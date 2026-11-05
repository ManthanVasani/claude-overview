'use strict';

const { NEEDS_YOU_TOOLS, AGENT_TOOLS } = require('./constants');

const MIN_TOKENS = 20000;
const LONG_PROMPT = 100000;
const HOUR_TTL = 3600000;
const SHORT_TTL = 300000;
const LOOP_RE = /\bsleep\s+\d|\buntil\b/;
// a permission prompt a person answered; a rule's answer says reasonType rule, or comes as config or a hook
const ASKED_RE = /^"permissionDecision":\{(?![^}]*"reasonType":"rule")[^}]*"source":"user_(?:temporary|reject)"/;
const BACKGROUND_TOOLS = new Set(['Monitor', 'TaskOutput']);
// parallel calls wait for the slowest
const RANK = ['command', 'background', 'loop', 'agents', 'ask'];

// $ per million input tokens, the cache read price as a share of it, and the price past LONG_PROMPT
const PRICES = {
  'claude-opus-5-5': [4, 0.05],
  'claude-opus-5': [5, 0.1],
  'claude-opus-4-8': [5, 0.1],
  'claude-sonnet-5-5': [2, 0.1],
  'claude-sonnet-5': [2, 0.1],
  'claude-haiku-5-5': [0.1, 0.1, 0.5],
  'claude-fable-5-1': [10, 0.025],
  'claude-fable-5': [10, 0.1],
};

// short and long are tokens written with a 5 minute and a 1 hour lifetime
function cost(key, short, long) {
  const [model, ...flags] = key.split(' ');
  const p = PRICES[model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')];
  if (!p) return null;
  const base = (flags.includes('long') && p[2] ? p[2] : p[0]) * (flags.includes('fast') ? 2 : 1);
  return (short * (1.25 - p[1]) + long * (2 - p[1])) * base / 1e6;
}

function newState() {
  return { id: null, t: 0, model: null, ttl: 0, fg: '', done: 0, wake: '', skip: false, acct: false, bg: [] };
}

function causeOf(s, agent, expired) {
  // past the cache lifetime the wait alone would have written it again
  if (s.acct && !expired) return 'account';
  // a tool that returned while the cache was still warm did not keep the call waiting
  if (s.fg && !(s.done && s.done - s.t < s.ttl)) return s.fg === 'ask' ? 'you' : s.fg;
  if (s.wake === 'task') return 'background';
  if (s.wake === 'prompt') return agent ? 'resumed' : 'you';
  return 'other';
}

function raise(s, kind) {
  if (RANK.indexOf(kind) > RANK.indexOf(s.fg)) s.fg = kind;
}

function noteTools(s, content) {
  for (const x of Array.isArray(content) ? content : []) {
    if (!x || x.type !== 'tool_use') continue;
    const input = x.input || {};
    if (input.run_in_background) {
      // in an agent, a call marked to run in the background can run in the foreground
      if (AGENT_TOOLS.has(x.name)) s.bg.push(x.id);
      continue;
    }
    let kind = 'command';
    if (NEEDS_YOU_TOOLS.has(x.name)) kind = 'ask';
    else if (AGENT_TOOLS.has(x.name)) kind = 'agents';
    else if (BACKGROUND_TOOLS.has(x.name)) kind = 'background';
    else if (x.name === 'Bash' && LOOP_RE.test(input.command || '')) kind = 'loop';
    raise(s, kind);
  }
}

// in a user line its own type comes before the message, and the message holds no timestamp key
function field(text, key) {
  const at = text.indexOf('"' + key + '":"');
  if (at < 0) return '';
  const from = at + key.length + 4;
  return text.slice(from, text.indexOf('"', from));
}

// the scanner parses a line only when it can hold usage
function line(s, text, d, agent) {
  // the waits file can hold a state an older server saved
  if (!s.bg) s.bg = [];
  // an agent's own transcript marks every line a side chain; in a session's, those lines belong to an agent
  if (!agent && text.indexOf('"isSidechain":true') >= 0) return null;
  if (!d || d.type !== 'assistant') {
    // request bodies, queues and attachments quote what was sent or queued, not what the call received
    const user = field(text, 'type') === 'user';
    if (user && text.indexOf('"tool_result"') >= 0) {
      // the decision is written after the result, which can quote anything
      if (ASKED_RE.test(text.slice(text.lastIndexOf('"permissionDecision"')))) s.fg = 'ask';
      const done = Date.parse(field(text, 'timestamp')) || 0;
      if (done - s.t >= s.ttl && s.bg.includes(field(text, 'tool_use_id'))) raise(s, 'agents');
      s.done = Math.max(s.done, done);
      return null;
    }
    if (text.indexOf('"subtype":"compact_boundary"') >= 0) s.skip = true;
    // the next call after an account switch writes the whole cache again
    else if (text.indexOf('"type":"credential_org"') >= 0) s.acct = true;
    // what came first ended the wait
    else if (s.wake || !user) return null;
    else if (text.indexOf('<task-notification>') >= 0) s.wake = 'task';
    // Claude Code marks its own lines meta, and also what an agent's session sends it
    else if (text.indexOf('"isMeta":true') < 0 || (agent && text.indexOf('"origin":{"kind":"coordinator"}') >= 0)) s.wake = 'prompt';
    return null;
  }
  const m = d.message || {};
  const u = m.usage;
  if (!u || !m.id || m.model === '<synthetic>') return null;
  if (m.id === s.id) {
    noteTools(s, m.content);
    return null;
  }
  const t = Date.parse(d.timestamp);
  if (!t) return null;
  const cc = u.cache_creation || {};
  const w1 = cc.ephemeral_1h_input_tokens || 0;
  const w5 = cc.ephemeral_5m_input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const prompt = (u.input_tokens || 0) + cw + (u.cache_read_input_tokens || 0);
  let miss = null;
  const expired = s.ttl && t - s.t >= s.ttl;
  if (s.id && !s.skip && m.model === s.model && (s.acct || expired) && cw >= MIN_TOKENS && cw >= prompt / 2) {
    const long = w1 || w5 ? w1 : s.ttl === HOUR_TTL ? cw : 0;
    const key = m.model + (u.speed === 'fast' ? ' fast' : '') + (prompt > LONG_PROMPT ? ' long' : '');
    miss = { t, cause: causeOf(s, agent, expired), key, short: cw - long, long };
  }
  Object.assign(s, newState(), { id: m.id, t, model: m.model, ttl: w1 ? HOUR_TTL : w5 ? SHORT_TTL : s.ttl });
  noteTools(s, m.content);
  return miss;
}

module.exports = { newState, line, cost };
