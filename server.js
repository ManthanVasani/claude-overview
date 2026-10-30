#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const PAGE = path.join(__dirname, 'index.html');
const CSWAP_DIR = cswapDir();
// Linux reads processes from /proc; macOS has none, so there one ps listing per poll stands in for it.
const PROC_FS = process.platform === 'linux';
const HOST = '127.0.0.1';
const PORT = Number(process.env.CLAUDE_OVERVIEW_PORT || 3100);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('CLAUDE_OVERVIEW_PORT must be a port number from 1 to 65535.');
  process.exit(1);
}

const arg = process.argv[2];
if (arg) {
  const usage = 'Usage: claude-overview\nServes the overview on http://' + HOST + ':' + PORT + '/ until Ctrl + C. CLAUDE_OVERVIEW_PORT sets the port.';
  if (arg === '--version' || arg === '-v') console.log(require('./package.json').version);
  else if (arg === '--help' || arg === '-h') console.log(usage);
  else { console.error('Unknown argument: ' + arg + '\n' + usage); process.exit(1); }
  process.exit(0);
}

// npm gives it no nice, and a dashboard should not compete with the sessions it watches
try { if (os.getPriority() < 10) os.setPriority(10); } catch (e) { /* it keeps the priority it started with */ }

const USAGE_INDEX = usageIndexFile();

const MIN = 60000;
const HOUR = 60 * MIN;
const POLL_MS = 2000;
const RESCAN_MS = 30000;
const NEW_SESSION_RESCAN_MS = 3000;
const SESSION_FIRST_BYTES = 4 << 20;
const AGENT_FIRST_BYTES = 1 << 20;
const JOURNAL_FIRST_BYTES = 16 << 20;
const MAX_READ_PER_POLL = 32 << 20;
const MAX_PENDING_LINE = 64 << 20;
const HEAD_BYTES = 64 << 10;
const BACKFILL_CHUNK = 4 << 20;
const BACKFILL_PER_FILE = 64 << 20;
const BACKFILL_PER_RUN = 256 << 20;
const DONE_VISIBLE_MS = 2 * HOUR;
const PROBLEM_VISIBLE_MS = 12 * HOUR;
const ENDED_VISIBLE_MS = 2 * HOUR;
const ATTENTION_MS = 2 * HOUR;
const SHELL_DONE_VISIBLE_MS = 10 * MIN;
const SHELL_PROBLEM_VISIBLE_MS = HOUR;
const WF_DONE_VISIBLE_MS = 30 * MIN;
const WORKFLOW_STALE_MS = 2 * HOUR;
const STALL_MS = 8 * MIN;
const LOST_MS = 2 * HOUR;
const RETRY_FRESH_MS = 10 * MIN;
const PERMISSION_MS = 15000;
const FG_LIMIT_MS = 11 * MIN;
const DEATH_GRACE_MS = 20000;
const FINAL_SETTLE_MS = 5000;
const BUCKET_MS = 15000;
const BUCKETS = 40;
const CLK_TCK = 100;
const EV_KEEP_MS = 3 * HOUR;
const EV_HISTORY_MS = 3 * HOUR;
const EV_MAX = 60000;
const NEEDS_YOU_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const INSTANT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const TASK_ID_RE = /(?:background with ID: |background \(ID: |Monitor started \(task )([A-Za-z0-9_-]+)/;
const HOME_RE = new RegExp('^' + HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const SCRATCH_RE = /^.*?\/claude-\d+\/[^/]+\/[0-9a-f-]{36}\/scratchpad/;
const SCRATCH_OWNER_RE = /^.*?\/claude-\d+\/[^/]+\/([0-9a-f-]{36})\/scratchpad/;

let bootMs = readBootMs();
function readBootMs() {
  if (!PROC_FS) return 0;
  try {
    const m = /btime (\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8'));
    return m ? Number(m[1]) * 1000 : 0;
  } catch { return 0; }
}

class Tail {
  constructor(file, firstBytes) {
    this.file = file;
    this.firstBytes = firstBytes;
    this.offset = null;
    this.startOffset = 0;
    this.pending = null;
    this.ino = null;
    this.mtimeMs = 0;
  }

  read() {
    let st;
    try { st = fs.statSync(this.file); } catch { return []; }
    this.mtimeMs = st.mtimeMs;
    if (this.ino !== null && (st.ino !== this.ino || st.size < this.offset)) {
      this.offset = null;
      this.pending = null;
    }
    this.ino = st.ino;
    if (this.offset === null) {
      const from = Math.max(0, st.size - this.firstBytes);
      const at = lineStart(this.file, from);
      this.offset = at < 0 ? from : at;
      this.startOffset = this.offset;
      this.skipping = at < 0;
    }
    if (st.size <= this.offset) return [];
    const want = Math.min(st.size - this.offset, MAX_READ_PER_POLL);
    const buf = Buffer.allocUnsafe(want);
    let got = 0;
    const fd = fs.openSync(this.file, 'r');
    try {
      while (got < want) {
        const n = fs.readSync(fd, buf, got, want - got, this.offset + got);
        if (!n) break;
        got += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    const base = this.offset - (this.pending ? this.pending.length : 0);
    this.offset += got;
    const data = this.pending ? Buffer.concat([this.pending, buf.subarray(0, got)]) : buf.subarray(0, got);
    const nl = data.lastIndexOf(10);
    if (nl === -1) {
      this.pending = data.length > MAX_PENDING_LINE ? null : Buffer.from(data);
      return [];
    }
    this.pending = nl + 1 < data.length ? Buffer.from(data.subarray(nl + 1)) : null;
    const lines = data.subarray(0, nl).toString('utf8').split('\n');
    if (this.skipping) {
      this.skipping = false;
      // the backwards readers start at startOffset, so it has to sit on a line boundary
      this.startOffset = base + data.indexOf(10) + 1;
      lines.shift();
    }
    const out = [];
    for (const line of lines) {
      if (!line || line.startsWith('{"type":"api-request')) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial or foreign line */ }
    }
    return out;
  }
}

function lineStart(file, pos) {
  if (pos <= 0) return 0;
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return -1; }
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let end = pos; end > 0 && pos - end < MAX_PENDING_LINE;) {
      const n = Math.min(buf.length, end);
      const got = fs.readSync(fd, buf, 0, n, end - n);
      const i = got > 0 ? buf.lastIndexOf(10, got - 1) : -1;
      if (i >= 0) return end - n + i + 1;
      end -= n;
    }
    return pos >= MAX_PENDING_LINE ? -1 : 0;
  } catch { return -1; } finally { fs.closeSync(fd); }
}

function oneLine(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function plainText(s) {
  return String(s == null ? '' : s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|`/g, '');
}

function shortPath(p) {
  if (!p) return '';
  p = String(p).replace(SCRATCH_RE, 'scratchpad').replace(HOME_RE, '~');
  return p.length > 80 ? '…' + p.slice(-79) : p;
}

function host(u) {
  try { return new URL(u).host; } catch { return oneLine(u, 60); }
}

function describe(name, i) {
  i = i || {};
  switch (name) {
    case 'Bash': return i.description ? oneLine(i.description, 140) : '$ ' + oneLine(i.command, 140);
    case 'Read': return 'Reading ' + shortPath(i.file_path);
    case 'Edit':
    case 'MultiEdit': return 'Editing ' + shortPath(i.file_path);
    case 'Write': return 'Writing ' + shortPath(i.file_path);
    case 'NotebookEdit': return 'Editing ' + shortPath(i.notebook_path);
    case 'Grep': return 'Searching for "' + oneLine(i.pattern, 60) + '"' + (i.path ? ' in ' + shortPath(i.path) : '');
    case 'Glob': return 'Finding files ' + oneLine(i.pattern, 70);
    case 'Agent':
    case 'Task': return 'Starting agent: ' + oneLine(i.description || i.subagent_type, 100);
    case 'Workflow': {
      const m = /name:\s*['"]([^'"]+)/.exec(i.script || '');
      return 'Starting workflow ' + (m ? m[1] : (i.name || ''));
    }
    case 'WebSearch': return 'Web search: ' + oneLine(i.query, 100);
    case 'WebFetch': return 'Fetching ' + host(i.url);
    case 'AskUserQuestion': {
      const q = Array.isArray(i.questions) && i.questions[0] && i.questions[0].question;
      return 'Asking you: ' + oneLine(q, 140);
    }
    case 'ExitPlanMode': return 'Waiting for you to approve its plan';
    case 'Skill': return 'Running skill /' + (i.skill || '');
    case 'ToolSearch': return 'Loading tools';
    case 'TodoWrite': return 'Updating its to-do list';
    case 'ScheduleWakeup': return 'Sleeping ' + Math.max(1, Math.round((i.delaySeconds || 0) / 60)) + ' min';
    case 'SendMessage': return 'Messaging ' + oneLine(i.to, 60);
    case 'Monitor': return 'Watching: ' + oneLine(i.description || i.command, 100);
    case 'TaskStop': return 'Stopping a task';
    case 'StructuredOutput': return 'Writing its result';
    case 'Artifact': return 'Publishing a page';
  }
  if (typeof name === 'string' && name.startsWith('mcp__')) {
    const parts = name.split('__');
    const server = (parts[1] || '').replace(/^claude_ai_/, '');
    return server + ' · ' + (parts.slice(2).join('__') || '') + (i.url ? ' ' + host(i.url) : '');
  }
  return String(name || 'tool');
}

function shellDesc(i) {
  i = i || {};
  return oneLine(i.description || ('$ ' + (i.command || '')), 140);
}

const TASK_OUTPUT_RE = /\/claude-\d+\/[^ ]*\/tasks\/[^/]+\.output$/;
function fileKey(p, cwd) {
  if (!p) return null;
  p = String(p).replace(/^['"]|['"]$/g, '');
  if (cwd && !p.startsWith('/') && !p.startsWith('~')) p = path.join(cwd, p);
  if (p.startsWith('~')) p = HOME + p.slice(1);
  if (TASK_OUTPUT_RE.test(p)) return null;
  // each session has its own scratchpad: the key keeps whose it is
  return 'file:' + path.normalize(p).replace(/(.)\/$/, '$1').replace(SCRATCH_OWNER_RE, (all, sid) => 'scratchpad@' + sid.slice(0, 8)).replace(HOME_RE, '~');
}

const FILE_TOOLS = new Set(['grep', 'rg', 'sed', 'cat', 'head', 'tail', 'wc', 'ls', 'awk', 'diff', 'cmp', 'find', 'stat', 'du', 'less', 'jq', 'cut', 'sort', 'uniq', 'tr', 'file', 'md5sum', 'sha256sum', 'cp', 'mv', 'mkdir', 'touch', 'chmod', 'tee']);
const RUNNERS = new Set(['node', 'python', 'python3', 'ruby', 'bash', 'sh', 'perl']);
const PATHLIKE = /^(?:[~./]|[\w-]+\/)[^\s'"|;&<>()$`*]*$|^[\w.-]+\.(?:rb|js|ts|json|md|ya?ml|html|erb|css|scss|py|sh|txt|log|tsv|csv|sql|output)$/;

function commandKey(cmd, cwd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (/\bgh\s+(?:pr|api|issue|run|repo)\b|\bgit\s+(?:push|fetch|pull|ls-remote)\b/.test(cmd)) return 'svc:github';
  let m = /\bssh\s+(?:-[BbcDEeFIiJLlmOopQRSWw]\s*\S+\s+|-[46AaCfGgKkMNnqsTtVvXxYy]+\s+)*(?:[\w.-]+@)?([\w.][\w.-]*)/.exec(cmd);
  if (m) return 'host:' + m[1];
  m = /\bcurl\b[^|;&]*?https?:\/\/([\w.-]+(?::\d+)?)/.exec(cmd);
  if (m) return 'host:' + m[1];
  if (/\brspec\b/.test(cmd)) return 'tool:rspec';
  if (/playwright|chromium|puppeteer/.test(cmd)) return 'tool:browser';
  const vars = {};
  let dir = cwd || null;
  const sub = (x) => x.replace(/\$\{?(\w+)\}?/g, (all, v) => (v in vars ? vars[v] : all));
  for (let seg of cmd.split(/\s*(?:&&|\|\||;|\n)\s*/)) {
    seg = seg.replace(/^(?:do|then|else|\{|\()\s+/, '').split(/\s\|\s?/)[0].trim();
    if (!seg || /^(?:done|fi|esac|\}|\))$/.test(seg)) continue;
    m = /^(\w+)=(\S*)$/.exec(seg);
    if (m) { vars[m[1]] = sub(m[2].replace(/^['"]|['"]$/g, '')); continue; }
    m = /^cd\s+(\S+)$/.exec(seg);
    if (m) {
      const target = sub(m[1].replace(/^['"]|['"]$/g, '')).replace(/^~(?=\/|$)/, HOME);
      dir = target.startsWith('/') ? target : path.join(dir || HOME, target);
      continue;
    }
    const words = seg.split(/\s+/).map(sub);
    let i = 0;
    while (i < words.length && (/^\w+=/.test(words[i]) || /^(?:timeout|nice|ionice|time|sudo|exec|env|bundle|-\S*|\d+[smh]?)$/.test(words[i]))) i++;
    const w = path.basename((words[i] || '').replace(/^['"(]+|['");]+$/g, ''));
    if (!w || !/^[\w.-]+$/.test(w)) continue;
    if (/^(?:for|while|until|if|case|echo|printf|sleep|true|false|test|\[|\[\[|export|local|set|read|wait|trap|source|\.)$/.test(w)) continue;
    if (w === 'git') {
      const c = words.indexOf('-C', i);
      return c > 0 && words[c + 1] ? fileKey(words[c + 1], dir) : dir ? fileKey(dir) : 'tool:git';
    }
    const args = words.slice(i + 1).filter((x) => x && x[0] !== '-' && !/^\d*>|^\/dev\//.test(x)).map((x) => (x.indexOf('*') > 0 ? x.slice(0, x.lastIndexOf('/', x.indexOf('*')) + 1) : x)).filter(Boolean);
    if (FILE_TOOLS.has(w)) {
      for (let j = args.length - 1; j >= 0; j--) if (PATHLIKE.test(args[j])) return fileKey(args[j], dir);
      continue;
    }
    if (RUNNERS.has(w)) {
      const a0 = args.find((x) => PATHLIKE.test(x));
      return a0 ? fileKey(a0, dir) : dir && dir !== cwd ? fileKey(dir) : 'cmd:' + w;
    }
    return 'cmd:' + w;
  }
  return dir && dir !== cwd ? fileKey(dir) : null;
}

function classify(name, i, cwd) {
  i = i || {};
  switch (name) {
    case 'Read': return { k: 'read', r: fileKey(i.file_path) };
    case 'Edit':
    case 'MultiEdit':
    case 'Write': return { k: 'edit', r: fileKey(i.file_path) };
    case 'NotebookEdit': return { k: 'edit', r: fileKey(i.notebook_path) };
    case 'Grep':
    case 'Glob': return { k: 'search', r: fileKey(i.path || cwd) };
    case 'Bash':
    case 'Monitor': return { k: 'run', r: commandKey(i.command, cwd) };
    case 'WebFetch': return { k: 'web', r: 'web:' + host(i.url) };
    case 'WebSearch': return { k: 'web', r: 'web:search' };
    case 'Agent':
    case 'Task':
    case 'Workflow': return { k: 'agent', r: null };
    case 'AskUserQuestion':
    case 'ExitPlanMode': return { k: 'ask', r: null };
    case 'Skill': return { k: 'other', r: i.skill ? 'skill:' + i.skill : null };
  }
  if (typeof name === 'string' && name.startsWith('mcp__')) return { k: 'svc', r: 'svc:' + (name.split('__')[1] || '').replace(/^claude_ai_/, '') };
  return { k: 'other', r: null };
}

// ---------- step log: every tool call, streamed to the page ----------

const evLog = [];
const evById = new Map();
let evNew = [];
let evEnded = [];
let evSeq = 0;
let evTrimAt = 0;

function evRow(e) {
  return [e.s, e.sid, e.o, e.t, e.n, e.k, e.r, e.l, e.e || 0, e.ok == null ? -1 : e.ok, e.err || null];
}
// cwd is the shell's folder when the call was made; relative paths resolve against it
function recordStep(c, id, name, input, label, t, cwd) {
  if (!id || !c.S || !c.S.id) return null;
  if (evById.has(id)) return evById.get(id);
  const { k, r } = classify(name, input, cwd || (c.S.reg && c.S.reg.cwd));
  const e = { s: ++evSeq, sid: c.S.id, o: c.owner, t: t || Date.now(), n: name, k, r, l: label, e: 0, ok: null, err: null };
  evLog.push(e);
  evById.set(id, e);
  evNew.push(e);
  return e;
}
// ok: 1 finished, 0 failed, 2 cut off
function endStep(e, t, ok, err) {
  if (!e || e.e) return;
  e.e = t || Date.now();
  e.ok = ok;
  if (err) e.err = err;
  evEnded.push([e.s, e.e, ok, e.err || null]);
}
function cutPending(c, t) {
  for (const p of c.pending.values()) if (p.ev) endStep(p.ev, Math.max(t, p.ev.t), 2, null);
  c.lastCutAt = t;
  const early = histOpen.get(c.S.id + '|' + c.owner);
  if (early) {
    for (const e of early) endStep(e, Math.max(t, e.t), 2, null);
    histOpen.delete(c.S.id + '|' + c.owner);
  }
}
// a call made before the session's current process started ended with the earlier process
function cutBefore(c, t) {
  for (const p of c.pending.values()) if (p.ev && p.at < t - 2000) endStep(p.ev, Math.max(t, p.ev.t), 2, null);
  const early = histOpen.get(c.S.id + '|' + c.owner);
  if (!early) return;
  for (const e of early) if (e.t < t - 2000) { endStep(e, t, 2, null); early.delete(e); }
  if (!early.size) histOpen.delete(c.S.id + '|' + c.owner);
}
function trimSteps(now) {
  if (now - evTrimAt < MIN && evLog.length <= EV_MAX) return;
  evTrimAt = now;
  const min = now - EV_KEEP_MS;
  const keep = evLog.filter((e) => e.t >= min);
  // history read later is older than what came first: past the cap, the oldest go
  if (keep.length > EV_MAX) keep.sort((a, b) => a.t - b.t).splice(0, keep.length - EV_MAX * 0.9);
  if (keep.length === evLog.length) return;
  evLog.length = 0;
  for (const e of keep) evLog.push(e);
  const live = new Set(keep);
  for (const [id, e] of evById) if (!live.has(e)) evById.delete(id);
}

// ---------- step history from before the first read ----------
// The first read of a transcript keeps only its end; the calls before it are read backwards once, a slice per poll,
// until EV_HISTORY_MS is covered.

const HIST_SLICE = 16 << 20;
const HIST_PER_FILE = 192 << 20;
const LATE_ENDS_MAX = 20000;
const histJobs = new Map();
const histDone = new Set();
// results whose call lies before the first read, kept until the backwards read reaches the call
const lateEnds = new Map();
// calls found that way with no result yet, by conversation, so a later interrupt or turn end cuts them
const histOpen = new Map();

function noteLateEnd(id, t, ok, err) {
  lateEnds.set(id, [t, ok, err]);
  if (lateEnds.size > LATE_ENDS_MAX) lateEnds.delete(lateEnds.keys().next().value);
}
function histFiles(S) {
  const out = [];
  if (S.file && S.tail) out.push({ file: S.file, end: S.tail.startOffset, owner: null, conv: S.conv });
  for (const a of S.agents.values()) {
    if (!a.file) continue;
    out.push({ file: a.file, end: a.tail ? a.tail.startOffset : a.startOffset != null ? a.startOffset : null, owner: a.id, conv: a.conv });
  }
  for (const w of S.wfs.values()) {
    if (!w.agents) continue;
    for (const a of w.agents.values()) if (a.file) out.push({ file: a.file, end: a.tail ? a.tail.startOffset : null, owner: 'wf:' + w.runId + ':' + a.id, conv: a.conv });
  }
  return out;
}
function histPoll(now) {
  let budget = HIST_SLICE;
  const cutoff = now - EV_HISTORY_MS;
  for (const S of sessions.values()) {
    for (const f of histFiles(S)) {
      if (budget <= 0) return;
      if (histDone.has(f.file)) continue;
      let job = histJobs.get(f.file);
      if (!job) {
        if (statMs(f.file) < cutoff) { histDone.add(f.file); continue; }
        job = { pos: f.end != null ? f.end : fileSize(f.file), used: 0, carry: Buffer.alloc(0), ends: new Map(), turnEnd: 0, S, owner: f.owner };
        histJobs.set(f.file, job);
      }
      budget -= histChunk(f.file, job, f.conv, cutoff, now);
      if (job.done) {
        histJobs.delete(f.file);
        histDone.add(f.file);
      }
    }
  }
}
function histChunk(file, job, conv, cutoff, now) {
  if (job.pos <= 0 || job.used >= HIST_PER_FILE) { job.done = true; return 0; }
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { job.done = true; return 0; }
  const n = Math.min(BACKFILL_CHUNK, job.pos);
  const buf = Buffer.allocUnsafe(n);
  let got = 0;
  try {
    while (got < n) {
      const r = fs.readSync(fd, buf, got, n - got, job.pos - n + got);
      if (!r) break;
      got += r;
    }
  } finally {
    fs.closeSync(fd);
  }
  job.pos -= n;
  job.used += n;
  const data = Buffer.concat([buf.subarray(0, got), job.carry]);
  let start = 0;
  if (job.pos > 0) {
    const nl = data.indexOf(10);
    if (nl === -1) { job.carry = data.length > MAX_PENDING_LINE ? Buffer.alloc(0) : data; return n; }
    job.carry = Buffer.from(data.subarray(0, nl));
    start = nl + 1;
  } else job.carry = Buffer.alloc(0);
  const lines = data.toString('utf8', start).split('\n');
  // newest first, so a call's result and any later turn end are already known when the call is reached
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const use = line.indexOf('"tool_use"') !== -1;
    const res = line.indexOf('"tool_result"') !== -1;
    const stop = line.indexOf('"stop_reason":"end_turn"') !== -1 || line.indexOf('[Request interrupted by user') !== -1;
    if (!use && !res && !stop) {
      const m = /"timestamp":"([^"]+)"/.exec(line);
      if (m && Date.parse(m[1]) < cutoff) job.done = true;
      continue;
    }
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const t = entryTime(d);
    if (t && t < cutoff) { job.done = true; continue; }
    const content = d.message && Array.isArray(d.message.content) ? d.message.content : [];
    if (res) {
      for (const x of content) {
        if (!x || x.type !== 'tool_result') continue;
        job.ends.set(x.tool_use_id, [t, x.is_error ? 0 : 1, x.is_error ? oneLine(typeof x.content === 'string' ? x.content : textOf(x.content), 200) : null]);
      }
    }
    if (use && d.type === 'assistant') {
      for (const x of content) {
        if (!x || x.type !== 'tool_use' || evById.has(x.id)) continue;
        const end = job.ends.get(x.id) || lateEnds.get(x.id);
        lateEnds.delete(x.id);
        const input = x.input || {};
        const { k, r } = classify(x.name, input, d.cwd || (job.S.reg && job.S.reg.cwd));
        const e = { s: ++evSeq, sid: job.S.id, o: job.owner, t, n: x.name, k, r, l: describe(x.name, input), e: 0, ok: null, err: null };
        if (end) { e.e = end[0]; e.ok = end[1]; e.err = end[2]; }
        else if (job.turnEnd) { e.e = job.turnEnd; e.ok = 2; }
        else if (conv && conv.lastCutAt > t) { e.e = conv.lastCutAt; e.ok = 2; }
        else if (!conv || now - t > HOUR) { e.e = t; e.ok = 2; }
        else {
          const key = job.S.id + '|' + job.owner;
          if (!histOpen.has(key)) histOpen.set(key, new Set());
          histOpen.get(key).add(e);
        }
        evLog.push(e);
        evById.set(x.id, e);
        evNew.push(e);
      }
    }
    if (stop && t) job.turnEnd = t;
  }
  return n;
}

// The text before the first quote appears verbatim inside the shell's `eval '...'` command line.
function cmdKey(cmd) {
  if (typeof cmd !== 'string') return null;
  const head = cmd.split(/['\n]/)[0].trim();
  const key = head.slice(-60);
  return key.length >= 12 ? key : null;
}

function newConv(S, owner) {
  return {
    S,
    owner,
    pending: new Map(),
    prompt: null,
    promptAt: 0,
    lastPromptEntry: null,
    aiTitle: null,
    customTitle: null,
    branch: null,
    model: null,
    ctx: 0,
    prs: new Map(),
    lastAt: 0,
    lastActAt: 0,
    lastKind: null,
    lastStop: null,
    handback: 0,
    said: null,
    steps: 0,
    agentPrompts: new Map(),
    recent: [],
    buckets: new Map(),
    workflows: new Map(),
    apiErr: null,
    fatal: null,
    interruptedAt: 0,
  };
}

function entryTime(d) {
  const t = Date.parse(d && d.timestamp);
  return Number.isFinite(t) ? t : 0;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text).join('\n');
}

function setEnd(S, key, rec) {
  if (!S || !key) return;
  const prev = S.ends.get(key);
  if (prev && prev.at > rec.at) return;
  S.ends.delete(key);
  S.ends.set(key, rec);
  if (S.ends.size > 4000) S.ends.delete(S.ends.keys().next().value);
}

function noteNotification(c, content, t) {
  if (typeof content !== 'string' || content.indexOf('<task-notification>') === -1) return;
  const st = /<status>([^<]+)<\/status>/.exec(content);
  if (!st) return;
  const summary = /<summary>([^<]*)<\/summary>/.exec(content);
  const exit = /exit code (\d+)/.exec(summary ? summary[1] : '');
  const rec = {
    status: st[1].trim(),
    at: t,
    summary: summary ? oneLine(summary[1], 200) : null,
    exit: exit ? Number(exit[1]) : null,
    waiting: content.indexOf('waiting on its own background work') !== -1,
  };
  const task = /<task-id>([^<]+)<\/task-id>/.exec(content);
  const tool = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(content);
  if (task) setEnd(c.S, task[1].trim(), rec);
  if (tool) setEnd(c.S, tool[1].trim(), rec);
}

const EXIT_WHY = { 126: 'Not executable', 127: 'Command not found', 130: 'Interrupted', 137: 'Killed', 143: 'Terminated' };
function exitWhy(code, timed) { return code === 124 && timed ? 'Timed out' : EXIT_WHY[code] || null; }

function registerTask(c, id, info) {
  const S = c.S;
  if (!S || !id) return;
  let k = S.tasks.get(id);
  if (!k) {
    k = { id, owner: c.owner, ownerSure: false, desc: null, kind: 'shell', startedAt: 0, cmdKey: null, timeoutMs: null, seenRunning: 0, goneAt: 0, needsInfo: false, tried: false };
    S.tasks.set(id, k);
  }
  if (info.launch) {
    k.owner = c.owner;
    k.ownerSure = true;
    if (info.at) k.startedAt = info.at;
  } else if (!k.ownerSure) {
    k.owner = c.owner;
  }
  if (info.desc) { k.desc = info.desc; k.needsInfo = false; }
  if (info.kind) k.kind = info.kind;
  if (info.cmd && !k.cmdKey) k.cmdKey = cmdKey(info.cmd);
  if (info.cmd) k.timed = /(?:^|[\s;&|(])timeout\s/.test(info.cmd);
  if (info.timeoutMs) k.timeoutMs = info.timeoutMs;
  if (!k.startedAt && info.at) k.startedAt = info.at;
}

function bump(c, t) {
  if (!t) return;
  const b = Math.floor(t / BUCKET_MS);
  c.buckets.set(b, (c.buckets.get(b) || 0) + 1);
  if (c.buckets.size > BUCKETS * 2) {
    const min = Math.floor(Date.now() / BUCKET_MS) - BUCKETS;
    for (const k of c.buckets.keys()) if (k < min) c.buckets.delete(k);
  }
}

function applyAssistant(c, d, t) {
  const m = d.message || {};
  if (d.gitBranch) c.branch = d.gitBranch;
  if (d.isApiErrorMessage) {
    c.fatal = { text: oneLine(textOf(m.content) || d.error || 'API error', 220), kind: d.apiError || d.error || null, at: t };
    c.apiErr = null;
    cutPending(c, t);
    c.pending.clear();
    c.lastKind = 'error';
    return;
  }
  if (m.model === '<synthetic>') return;
  c.fatal = null;
  c.apiErr = null;
  c.lastActAt = t;
  if (m.model) c.model = m.model;
  const u = m.usage;
  if (u) {
    const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    if (ctx > 0) c.ctx = ctx;
  }
  c.lastKind = 'assistant';
  c.lastStop = m.stop_reason || null;
  for (const x of Array.isArray(m.content) ? m.content : []) {
    if (!x) continue;
    if (x.type === 'tool_use') {
      const input = x.input || {};
      if (x.name === 'SubagentHandback') c.handback = t || Date.now();
      if (AGENT_TOOLS.has(x.name) && input.prompt) {
        c.agentPrompts.set(x.id, oneLine(plainText(input.prompt), 900));
        if (c.agentPrompts.size > 400) c.agentPrompts.delete(c.agentPrompts.keys().next().value);
      }
      const label = describe(x.name, input);
      c.steps++;
      const shell = x.name === 'Bash' || x.name === 'Monitor';
      c.pending.set(x.id, {
        name: x.name,
        label,
        at: t,
        bg: x.name === 'Monitor' || !!input.run_in_background,
        desc: shell ? shellDesc(input) : null,
        cmd: shell ? input.command : null,
        ev: recordStep(c, x.id, x.name, input, label, t, d.cwd),
      });
      c.recent.push({ at: t, label, tool: x.name });
      if (c.recent.length > 8) c.recent.shift();
      bump(c, t);
    } else if (x.type === 'text' && x.text && x.text.trim()) {
      c.said = { text: oneLine(plainText(x.text), 240), at: t };
    }
  }
  if (c.lastStop === 'end_turn') {
    cutPending(c, t);
    c.pending.clear();
  }
}

function applyUser(c, d, t) {
  const m = d.message || {};
  if (d.gitBranch) c.branch = d.gitBranch;
  const content = m.content;
  let isResult = false;
  if (Array.isArray(content)) {
    for (const x of content) {
      if (!x || x.type !== 'tool_result') continue;
      isResult = true;
      const p = c.pending.get(x.tool_use_id);
      c.pending.delete(x.tool_use_id);
      const ev = evById.get(x.tool_use_id);
      const err = x.is_error ? oneLine(typeof x.content === 'string' ? x.content : textOf(x.content), 200) : null;
      if (ev) endStep(ev, t, x.is_error ? 0 : 1, err);
      else noteLateEnd(x.tool_use_id, t, x.is_error ? 0 : 1, err);
      const r = d.toolUseResult && typeof d.toolUseResult === 'object' ? d.toolUseResult : null;
      const launched = r && r.status === 'async_launched';
      if (launched && r.runId) c.workflows.set(r.runId, { name: r.workflowName || null, summary: r.summary || null, at: t });
      if (!launched && p && AGENT_TOOLS.has(p.name)) {
        setEnd(c.S, x.tool_use_id, { status: x.is_error ? 'failed' : 'completed', at: t, summary: null, exit: null, waiting: false });
      }
      if (p && (p.name === 'Bash' || p.name === 'Monitor')) {
        const txt = typeof x.content === 'string' ? x.content : textOf(x.content);
        const mm = TASK_ID_RE.exec(txt || '');
        const id = (r && (r.backgroundTaskId || (p.name === 'Monitor' && r.taskId))) || (mm && mm[1]);
        if (id) registerTask(c, id, { launch: true, desc: p.desc, kind: p.name === 'Monitor' ? 'monitor' : 'shell', at: p.at, cmd: p.cmd, timeoutMs: r && r.timeoutMs });
      }
    }
  }
  if (isResult) {
    c.apiErr = null;
    c.lastActAt = t;
  }
  c.lastKind = 'user';
  if (isResult || d.isMeta) return;
  const text = textOf(content).trim();
  if (!text) return;
  if (text.indexOf('<task-notification>') !== -1) {
    noteNotification(c, text, t);
    return;
  }
  if (text.startsWith('[Request interrupted')) {
    c.interruptedAt = t;
    cutPending(c, t);
    c.pending.clear();
    return;
  }
  if (d.isSidechain || text[0] === '<') return;
  c.prompt = text;
  c.promptAt = t;
  cutPending(c, t);
  c.pending.clear();
  c.fatal = null;
  c.apiErr = null;
  c.interruptedAt = 0;
}

function apply(c, d) {
  if (!d || typeof d !== 'object') return;
  const t = entryTime(d);
  if (t > c.lastAt) c.lastAt = t;
  switch (d.type) {
    case 'last-prompt': if (d.lastPrompt) c.lastPromptEntry = d.lastPrompt; break;
    case 'ai-title': if (d.aiTitle) c.aiTitle = d.aiTitle; break;
    case 'custom-title': if (d.customTitle) c.customTitle = d.customTitle; break;
    case 'pr-link':
      if (d.prNumber) c.prs.set((d.prRepository || '') + '#' + d.prNumber, { n: d.prNumber, url: d.prUrl || null, repo: d.prRepository || null });
      break;
    case 'queue-operation': noteNotification(c, d.content, t); break;
    case 'assistant': applyAssistant(c, d, t); break;
    case 'user': applyUser(c, d, t); break;
    case 'system':
      if (d.subtype === 'api_error') {
        const e = d.error || {};
        c.apiErr = {
          text: oneLine(e.formatted || e.message || 'API error', 160),
          attempt: d.retryAttempt || null,
          max: d.maxRetries || null,
          down: !!e.isNetworkDown,
          at: t,
        };
      }
      break;
    case 'attachment': {
      const a = d.attachment;
      if (!a) break;
      if (a.type === 'queued_command' && typeof a.prompt === 'string') noteNotification(c, a.prompt, t);
      else if (a.type === 'task_status' && a.taskId && !/agent|workflow/.test(a.taskType || '')) {
        registerTask(c, a.taskId, { desc: a.description ? oneLine(a.description, 140) : null, at: t, cmd: a.shell && a.shell.command, kind: /monitor/.test(a.taskType || '') ? 'monitor' : null });
        if (a.status && a.status !== 'running' && c.S && !c.S.ends.has(a.taskId)) {
          setEnd(c.S, a.taskId, { status: a.status, at: t, summary: null, exit: null, waiting: false });
        }
      }
      break;
    }
    default: break;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function statMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function firstTimestamp(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const m = /"timestamp":"([^"]+)"/.exec(buf.toString('utf8', 0, n));
    const t = m ? Date.parse(m[1]) : NaN;
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; } finally { fs.closeSync(fd); }
}

let psTable = new Map();
let psKids = new Map();

function refreshProcs() {
  if (PROC_FS) {
    // btime moves when the wall clock is stepped, as WSL does after the host sleeps
    bootMs = readBootMs();
    return;
  }
  const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C', TZ: 'UTC' }), timeout: 5000, maxBuffer: 64 << 20 });
  // a failed listing keeps the last one, so live sessions do not flash to ended
  if (r.status !== 0 || !r.stdout) return;
  const table = new Map();
  const kids = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}) ?(.*)$/.exec(line);
    if (!m) continue;
    table.set(m[1], { ppid: m[2], token: m[3], start: Date.parse(m[3] + ' UTC'), cmd: m[4] });
    if (!kids.has(m[2])) kids.set(m[2], []);
    kids.get(m[2]).push(m[1]);
  }
  psTable = table;
  psKids = kids;
}

function procInfo(pid) {
  if (!PROC_FS) return psTable.get(String(pid)) || null;
  let s;
  try { s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); } catch { return null; }
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return { ppid: f[1], token: f[19], start: bootMs + Number(f[19]) * 1000 / CLK_TCK };
}

// procStart is what Claude Code recorded: the /proc start tick on Linux, ps's lstart (day space-padded) on macOS
function alive(pid, procStart) {
  const p = procInfo(pid);
  if (!p) return false;
  return procStart == null || p.token.replace(/\s+/g, ' ') === String(procStart).trim().replace(/\s+/g, ' ');
}

function cmdOf(pid) {
  if (!PROC_FS) { const p = psTable.get(String(pid)); return p ? p.cmd : null; }
  try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' '); } catch { return null; }
}

// where each process's stdout goes, which names the task output file of a background shell
function stdoutOf(pids) {
  const out = new Map();
  if (!pids.length) return out;
  if (PROC_FS) {
    for (const pid of pids) {
      try { out.set(pid, fs.readlinkSync('/proc/' + pid + '/fd/1')); } catch { /* gone or not ours */ }
    }
    return out;
  }
  const r = spawnSync('lsof', ['-w', '-a', '-p', pids.join(','), '-d', '1', '-Fn'], { encoding: 'utf8', timeout: 5000 });
  let pid = null;
  for (const line of (r.stdout || '').split('\n')) {
    if (line[0] === 'p') pid = line.slice(1);
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1));
  }
  return out;
}

function childrenOf(pid) {
  if (!PROC_FS) return psKids.get(String(pid)) || [];
  const out = new Set();
  let tids = [];
  try { tids = fs.readdirSync('/proc/' + pid + '/task'); } catch { return []; }
  for (const tid of tids) {
    let s = '';
    try { s = fs.readFileSync('/proc/' + pid + '/task/' + tid + '/children', 'utf8'); } catch { continue; }
    for (const c of s.split(' ')) if (c.trim()) out.add(c.trim());
  }
  return [...out];
}

const regCache = new Map();

function readRegistry(now) {
  const out = new Map();
  let names;
  try { names = fs.readdirSync(SESSIONS_DIR); } catch { return out; }
  const present = new Set();
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    present.add(n);
    const file = path.join(SESSIONS_DIR, n);
    const mt = statMs(file);
    let r = regCache.get(n);
    if (!r || r.mt !== mt) {
      r = { mt, reg: readJson(file) };
      regCache.set(n, r);
    }
    const reg = r.reg;
    if (!reg || !reg.sessionId || !reg.pid) continue;
    const live = alive(reg.pid, reg.procStart);
    if (!live && now - mt > (reg.status === 'busy' ? PROBLEM_VISIBLE_MS : ENDED_VISIBLE_MS)) continue;
    const prev = out.get(reg.sessionId);
    if (!prev || (live && !prev.alive) || (live === prev.alive && (reg.startedAt || 0) > (prev.reg.startedAt || 0))) {
      out.set(reg.sessionId, { reg, alive: live, mt });
    }
  }
  for (const n of regCache.keys()) if (!present.has(n)) regCache.delete(n);
  return out;
}

const located = new Map();

function locateTranscript(reg, now) {
  const hit = located.get(reg.sessionId);
  if (hit && hit.file) return hit.file;
  if (hit && now - hit.at < NEW_SESSION_RESCAN_MS) return null;
  const name = reg.sessionId + '.jsonl';
  let file = null;
  if (reg.cwd) {
    const guess = path.join(PROJECTS_DIR, reg.cwd.replace(/[^a-zA-Z0-9]/g, '-'), name);
    if (fs.existsSync(guess)) file = guess;
  }
  if (!file && (!hit || now - hit.scanAt >= RESCAN_MS)) {
    let dirs = [];
    try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { /* none */ }
    for (const d of dirs) {
      const p = path.join(PROJECTS_DIR, d, name);
      if (fs.existsSync(p)) { file = p; break; }
    }
    located.set(reg.sessionId, { file, at: now, scanAt: now });
    return file;
  }
  located.set(reg.sessionId, { file, at: now, scanAt: hit ? hit.scanAt : 0 });
  return file;
}

function agentNow(conv) {
  if (!conv) return null;
  const pend = [...conv.pending.values()].sort((a, b) => b.at - a.at);
  if (pend.length) return { label: pend[0].label, since: pend[0].at, tool: pend[0].name };
  if (conv.lastAt) return { label: 'Thinking', since: conv.lastAt };
  return null;
}

// --- background shells ------------------------------------------------------

function scanProcs(S) {
  const seen = new Set();
  const fresh = [];
  for (const pid of childrenOf(S.reg.pid)) {
    seen.add(pid);
    const info = procInfo(pid);
    if (!info) continue;
    const prev = S.procs.get(pid);
    if (prev && prev.start === info.start) continue;
    fresh.push({ pid, start: info.start, task: null, cmd: null });
  }
  const outs = stdoutOf(fresh.map((p) => p.pid));
  for (const p of fresh) {
    const m = /\/tasks\/([A-Za-z0-9_-]+)\.output$/.exec(outs.get(p.pid) || '');
    if (m) p.task = m[1];
    else p.cmd = cmdOf(p.pid);
    S.procs.set(p.pid, p);
  }
  for (const pid of S.procs.keys()) if (!seen.has(pid)) S.procs.delete(pid);
}

function liveConvs(S) {
  const out = [S.conv];
  for (const a of S.agents.values()) if (a.conv) out.push(a.conv);
  for (const w of S.wfs.values()) if (w.agents) for (const a of w.agents.values()) if (a.conv) out.push(a.conv);
  return out;
}

// Pairs each running process with the foreground tool call that started it, and
// flags foreground calls that never started a process (a permission prompt).
function matchForeground(S, now) {
  const fg = [];
  const since = (S.reg.startedAt || 0) - 2000;
  const first = new Map();
  for (const c of liveConvs(S)) {
    for (const p of c.pending.values()) {
      if (p.bg || p.at < since || !(p.name === 'Bash' || INSTANT_TOOLS.has(p.name))) continue;
      if (!first.has(c)) first.set(c, p);
      if (p.name === 'Bash') fg.push({ c, p });
    }
  }
  fg.sort((x, y) => x.p.at - y.p.at);
  const used = new Set();
  const blocked = [];
  for (const { c, p } of fg) {
    let best = null;
    for (const proc of S.procs.values()) {
      if (used.has(proc.pid) || (proc.task && S.tasks.has(proc.task))) continue;
      if (proc.start < p.at - 3000) continue;
      if (!best || proc.start < best.start) best = proc;
    }
    if (best) {
      used.add(best.pid);
      best.fgOwner = c.owner;
    } else if (now - p.at > PERMISSION_MS && first.get(c) === p) blocked.push({ c, p });
  }
  for (const c of liveConvs(S)) {
    for (const p of c.pending.values()) {
      if (INSTANT_TOOLS.has(p.name) && first.get(c) === p && now - p.at > PERMISSION_MS) blocked.push({ c, p });
    }
  }
  return { used, blocked };
}

function noteRunningTasks(S, now, used) {
  for (const proc of S.procs.values()) {
    if (!proc.task || used.has(proc.pid)) continue;
    let k = S.tasks.get(proc.task);
    if (!k) {
      if (now - proc.start < 5000) continue;
      k = { id: proc.task, owner: null, ownerSure: false, desc: null, kind: 'shell', startedAt: proc.start, cmdKey: null, timeoutMs: null, seenRunning: 0, goneAt: 0, needsInfo: true, tried: false, fallback: null };
      S.tasks.set(proc.task, k);
    }
    k.seenRunning = now;
    k.goneAt = 0;
    if (!k.desc && !k.fallback) k.fallback = fallbackDesc(proc.pid);
  }
}

// with --no-session-persistence a claude -p run writes no transcript
function headlessOf(pid) {
  const cmd = cmdOf(pid);
  if (!cmd) return null;
  const words = cmd.split(' ').filter(Boolean);
  const i = words.findIndex((w) => w === '-p' || w === '--print');
  if (i < 0) return null;
  let j = i + 1;
  while (j < words.length && words[j][0] !== '-') j++;
  return { prompt: j > i + 1 ? oneLine(words.slice(i + 1, j).join(' '), 400) : null, kept: !words.includes('--no-session-persistence') };
}

function fallbackDesc(pid) {
  const cmd = cmdOf(pid);
  if (cmd == null) return null;
  const m = /eval '(.*?)(?:' <|'$)/.exec(cmd);
  return '$ ' + oneLine((m ? m[1] : cmd).replace(/'\\''/g, "'"), 120);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scanTextForTasks(text, want, owner, S) {
  const re = new RegExp([...want.keys()].map(escapeRe).join('|'), 'g');
  const hits = [];
  let m;
  while ((m = re.exec(text))) hits.push([m.index, m[0]]);
  for (let i = hits.length - 1; i >= 0; i--) {
    const [idx, id] = hits[i];
    const k = want.get(id);
    if (!k) continue;
    const ls = text.lastIndexOf('\n', idx) + 1;
    let le = text.indexOf('\n', idx);
    if (le === -1) le = text.length;
    if (text.startsWith('{"type":"api-request', ls) || le - ls > (4 << 20)) continue;
    let d;
    try { d = JSON.parse(text.slice(ls, le)); } catch { continue; }
    const a = d.type === 'attachment' && d.attachment;
    if (a && a.type === 'task_status' && a.taskId === id) {
      if (!k.ownerSure) k.owner = owner;
      if (a.description) {
        k.desc = oneLine(a.description, 140);
        if (!k.cmdKey && a.shell) k.cmdKey = cmdKey(a.shell.command);
        want.delete(id);
        k.needsInfo = false;
      }
      continue;
    }
    if (d.type !== 'user' || !d.message || !Array.isArray(d.message.content)) continue;
    const res = d.message.content.find((x) => x && x.type === 'tool_result' && String(typeof x.content === 'string' ? x.content : textOf(x.content)).indexOf(id) !== -1);
    if (!res) continue;
    k.owner = owner;
    k.ownerSure = true;
    const key = '"id":"' + res.tool_use_id + '"';
    const j = text.lastIndexOf(key, ls);
    if (j !== -1) {
      const us = text.lastIndexOf('\n', j) + 1;
      let ue = text.indexOf('\n', j);
      if (ue === -1) ue = text.length;
      try {
        const u = JSON.parse(text.slice(us, ue));
        const call = ((u.message && u.message.content) || []).find((x) => x && x.id === res.tool_use_id);
        if (call) {
          k.desc = shellDesc(call.input);
          k.kind = call.name === 'Monitor' ? 'monitor' : 'shell';
          k.cmdKey = cmdKey(call.input && call.input.command);
          k.startedAt = entryTime(u) || k.startedAt;
        }
      } catch { /* partial line */ }
    }
    want.delete(id);
    k.needsInfo = false;
  }
}

function searchBack(file, end, limit, want, owner, S) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  let pos = end;
  let used = 0;
  let carry = Buffer.alloc(0);
  try {
    while (pos > 0 && used < limit && want.size) {
      const n = Math.min(BACKFILL_CHUNK, pos);
      const buf = Buffer.allocUnsafe(n);
      let got = 0;
      while (got < n) {
        const r = fs.readSync(fd, buf, got, n - got, pos - n + got);
        if (!r) break;
        got += r;
      }
      pos -= n;
      used += n;
      const data = Buffer.concat([buf.subarray(0, got), carry]);
      let start = 0;
      if (pos > 0) {
        const nl = data.indexOf(10);
        if (nl === -1) { carry = data.length > MAX_PENDING_LINE ? Buffer.alloc(0) : data; continue; }
        carry = Buffer.from(data.subarray(0, nl));
        start = nl + 1;
      }
      scanTextForTasks(data.toString('utf8', start), want, owner, S);
    }
  } finally {
    fs.closeSync(fd);
  }
  return used;
}

// Running shells whose launch is older than the first tail read: look further back once.
function backfillTasks(S, now) {
  const want = new Map();
  for (const k of S.tasks.values()) if (k.needsInfo && !k.tried && k.seenRunning) want.set(k.id, k);
  if (!want.size || now - S.backfillAt < RESCAN_MS) return;
  S.backfillAt = now;
  for (const k of want.values()) k.tried = true;
  const files = [];
  if (S.tail) files.push({ file: S.file, end: S.tail.startOffset, owner: null });
  const agents = [...S.agents.values()].filter((a) => now - (a.mtime || 0) < PROBLEM_VISIBLE_MS);
  agents.sort((x, y) => (y.mtime || 0) - (x.mtime || 0));
  for (const a of agents) files.push({ file: a.file, end: a.startOffset != null ? a.startOffset : fileSize(a.file), owner: a.id });
  let budget = BACKFILL_PER_RUN;
  for (const f of files) {
    if (!want.size || budget <= 0) break;
    if (f.end <= 0) continue;
    budget -= searchBack(f.file, f.end, Math.min(BACKFILL_PER_FILE, budget), want, f.owner, S);
  }
}

function shellViews(S, now) {
  const running = new Map();
  for (const p of S.procs.values()) if (p.task) running.set(p.task, p);
  const list = [];
  const owners = new Map();
  for (const k of S.tasks.values()) {
    let proc = S.alive ? running.get(k.id) : null;
    if (!proc && S.alive && k.kind === 'monitor' && k.cmdKey) {
      for (const p of S.procs.values()) if (!p.task && p.cmd && p.cmd.indexOf(k.cmdKey) !== -1) { proc = p; break; }
    }
    const end = S.ends.get(k.id);
    let state;
    let doneAt = null;
    if (proc) {
      state = 'running';
      k.seenRunning = now;
      k.goneAt = 0;
    } else if (end) {
      if (end.status === 'completed') state = end.exit ? 'failed' : 'done';
      else if (end.status === 'failed') state = 'failed';
      else state = 'stopped';
      doneAt = end.at;
    } else if (!S.alive) {
      state = 'died';
      doneAt = S.deadAt || now;
    } else if (S.reg.startedAt && k.startedAt && k.startedAt < S.reg.startedAt) {
      state = 'died';
      doneAt = S.reg.startedAt;
    } else if (k.kind === 'monitor' && !k.cmdKey && now - k.startedAt < (k.timeoutMs || 30 * MIN)) {
      state = 'running';
    } else {
      if (!k.goneAt) k.goneAt = k.seenRunning ? now : k.startedAt || now;
      state = 'ended';
      doneAt = k.goneAt;
    }
    const keep = state === 'running' ? Infinity : state === 'failed' || state === 'died' ? SHELL_PROBLEM_VISIBLE_MS : SHELL_DONE_VISIBLE_MS;
    if (state !== 'running' && now - (doneAt || 0) > keep) {
      if (now - (doneAt || 0) > PROBLEM_VISIBLE_MS) S.tasks.delete(k.id);
      continue;
    }
    if (state === 'running') owners.set(k.owner || '', (owners.get(k.owner || '') || 0) + 1);
    list.push({
      id: k.id,
      owner: k.owner || null,
      kind: k.kind,
      desc: k.desc || k.fallback || 'Background ' + (k.kind === 'monitor' ? 'watch' : 'command') + ' ' + k.id,
      state,
      startedAt: k.startedAt || (proc && proc.start) || null,
      doneAt,
      exit: end ? end.exit : null,
      why: end ? exitWhy(end.exit, k.timed) : null,
      summary: end ? end.summary : null,
      pid: proc ? Number(proc.pid) : null,
    });
  }
  const rank = { running: 0, failed: 1, died: 1, ended: 2, stopped: 2, done: 3 };
  list.sort((x, y) => rank[x.state] - rank[y.state] || (y.startedAt || 0) - (x.startedAt || 0));
  return { list, owners };
}

// --- agents -----------------------------------------------------------------

function trackAgent(a, now) {
  a.meta = readJson(a.metaFile) || {};
  a.metaMtime = statMs(a.metaFile);
  if (!a.startedAt) a.startedAt = firstTimestamp(a.file) || a.metaMtime || a.mtime || now;
  a.tail = new Tail(a.file, AGENT_FIRST_BYTES);
  a.conv = newConv(a.S, a.id);
}

function retireAgent(a) {
  a.mtime = a.tail ? a.tail.mtimeMs : a.mtime;
  a.startOffset = a.tail ? a.tail.startOffset : a.startOffset;
  a.tail = null;
  a.conv = null;
}

function scanAgents(S, now) {
  const dir = path.join(S.dir, 'subagents');
  let st;
  try { st = fs.statSync(dir); } catch { return; }
  if (st.mtimeMs === S.agentDirMtime && now - S.agentScanAt < RESCAN_MS) return;
  S.agentDirMtime = st.mtimeMs;
  S.agentScanAt = now;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const m = /^agent-([0-9a-zA-Z_-]+)\.jsonl$/.exec(n);
    if (!m) continue;
    const id = m[1];
    let a = S.agents.get(id);
    if (a && a.tail) continue;
    const file = path.join(dir, n);
    const mt = statMs(file);
    if (a && a.mtime === mt) continue;
    if (!a) {
      a = { id, S, file, metaFile: path.join(dir, 'agent-' + id + '.meta.json'), mtime: mt, startOffset: null, startedAt: 0 };
      S.agents.set(id, a);
      if (now - mt > PROBLEM_VISIBLE_MS) continue;
    } else {
      a.mtime = mt;
    }
    trackAgent(a, now);
  }
}

function readAgents(S, now) {
  scanAgents(S, now);
  for (const a of S.agents.values()) {
    if (!a.tail) continue;
    for (const d of a.tail.read()) apply(a.conv, d);
    const mm = statMs(a.metaFile);
    if (mm !== a.metaMtime) {
      a.meta = readJson(a.metaFile) || a.meta;
      a.metaMtime = mm;
    }
  }
}

function permissionOf(blocked, conv) {
  const b = blocked.find((x) => x.c === conv);
  return b ? { kind: 'permission', text: 'Waiting for your permission: ' + b.p.label, since: b.p.at + PERMISSION_MS, tool: b.p.name } : null;
}

function troubleOf(c, now, blocked, hasProc) {
  if (c.apiErr && now - c.apiErr.at < RETRY_FRESH_MS) {
    const n = c.apiErr.attempt && c.apiErr.max ? ' · retry ' + c.apiErr.attempt + ' of ' + c.apiErr.max : '';
    return { kind: 'retrying', text: c.apiErr.text + n, since: c.apiErr.at, down: c.apiErr.down };
  }
  const perm = permissionOf(blocked, c);
  if (perm) return perm;
  const lastAt = c.lastAt;
  if (!lastAt) return null;
  const waitingOnChild = [...c.pending.values()].some((p) => AGENT_TOOLS.has(p.name) || NEEDS_YOU_TOOLS.has(p.name) || (p.name === 'Bash' && !p.bg && hasProc));
  if (!waitingOnChild && now - lastAt > STALL_MS) return { kind: 'stalled', text: 'No activity', since: lastAt };
  return null;
}

function agentStatus(S, a, now, shellOwners, blocked) {
  const meta = a.meta || {};
  const c = a.conv;
  const lastAt = Math.max(c.lastAt, a.tail.mtimeMs);
  const shells = shellOwners.get(a.id) || 0;
  if (c.fatal) return { state: 'failed', reason: c.fatal.text, doneAt: c.fatal.at };
  const end = S.ends.get(a.id) || (meta.toolUseId && S.ends.get(meta.toolUseId)) || null;
  let doneAt = 0;
  if (end) doneAt = end.at;
  if (c.handback) doneAt = Math.max(doneAt, c.handback);
  if (meta.finished || meta.stoppedByUser) doneAt = Math.max(doneAt, Math.min(a.metaMtime || lastAt, lastAt + 5000));
  if (c.lastKind === 'assistant' && c.lastStop === 'end_turn' && !c.pending.size) doneAt = Math.max(doneAt, c.lastAt);
  if (doneAt && c.lastActAt <= doneAt + 3000) {
    if (meta.stoppedByUser) return { state: 'stopped', reason: 'Stopped by you', doneAt };
    if (end && end.at >= doneAt - 3000 && (end.status === 'killed' || end.status === 'stopped')) return { state: 'stopped', reason: 'Stopped', doneAt };
    if (end && end.at >= doneAt - 3000 && end.status === 'failed') return { state: 'failed', reason: end.summary || 'Failed', doneAt };
    if (shells && S.alive) return { state: 'waiting', reason: 'Waiting on its own background work', doneAt: null };
    return { state: 'done', doneAt };
  }
  if (!S.alive) return { state: 'died', reason: 'The session process ended', doneAt: S.deadAt || lastAt };
  if (S.reg.startedAt && lastAt < S.reg.startedAt - 2000) {
    return { state: 'died', reason: 'Lost when the session restarted', doneAt: S.reg.startedAt };
  }
  const sc = S.conv;
  if (meta.requestShape !== 'background' && sc.interruptedAt && sc.interruptedAt > a.startedAt && sc.interruptedAt >= lastAt - 2000) {
    return { state: 'stopped', reason: 'Stopped when you interrupted the session', doneAt: sc.interruptedAt };
  }
  if (now - lastAt > LOST_MS && !c.pending.size) return { state: 'lost', reason: 'No activity and no final report', doneAt: lastAt };
  const hasProc = [...S.procs.values()].some((p) => p.start >= lastAt - 3000);
  return { state: 'running', trouble: troubleOf(c, now, blocked, hasProc || c.pending.size > 0) };
}

const PROBLEM_STATES = new Set(['failed', 'died', 'lost']);

function agentViews(S, now, shellOwners, blocked) {
  const list = [];
  for (const a of S.agents.values()) {
    if (!a.tail) continue;
    const st = agentStatus(S, a, now, shellOwners, blocked);
    const keep = st.state === 'running' || st.state === 'waiting' ? Infinity : PROBLEM_STATES.has(st.state) ? PROBLEM_VISIBLE_MS : DONE_VISIBLE_MS;
    if (now - (st.doneAt || now) > keep) {
      retireAgent(a);
      continue;
    }
    const meta = a.meta || {};
    const parent = meta.parentAgentId && S.agents.get(meta.parentAgentId);
    const promptSource = parent && parent.conv ? parent.conv : S.conv;
    list.push({
      id: a.id,
      parentId: meta.parentAgentId || null,
      depth: meta.spawnDepth || 1,
      desc: meta.description || a.conv.aiTitle || 'Agent ' + a.id.slice(0, 7),
      type: meta.agentType || 'agent',
      background: meta.requestShape === 'background',
      parent: parent && parent.meta ? parent.meta.description || null : null,
      prompt: (meta.toolUseId && promptSource.agentPrompts.get(meta.toolUseId)) || null,
      state: st.state,
      reason: st.reason || null,
      trouble: st.trouble || null,
      startedAt: a.startedAt,
      doneAt: st.doneAt || null,
      lastAt: Math.max(a.conv.lastAt, a.tail.mtimeMs),
      now: st.state === 'running' ? agentNow(a.conv) : null,
      said: a.conv.said ? a.conv.said.text : null,
      steps: a.conv.steps,
      recent: a.conv.recent.slice(-6).reverse(),
      model: a.conv.model,
      ctx: a.conv.ctx || null,
      shells: shellOwners.get(a.id) || 0,
    });
  }
  const rank = { running: 0, waiting: 1, failed: 2, died: 2, lost: 2, stopped: 3, done: 4 };
  list.sort((x, y) => rank[x.state] - rank[y.state] || y.startedAt - x.startedAt);
  return list;
}

// --- workflows --------------------------------------------------------------

function workflowName(S, runId, w) {
  const launched = S.conv.workflows.get(runId);
  if (launched && launched.name) return launched.name;
  if (w.final && w.final.workflowName) return w.final.workflowName;
  if (w.scriptName) return w.scriptName;
  const dir = path.join(S.dir, 'workflows', 'scripts');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* none */ }
  const suffix = '-' + runId + '.js';
  const f = names.find((n) => n.endsWith(suffix));
  w.scriptName = f ? f.slice(0, -suffix.length) : runId;
  return w.scriptName;
}

function scanWorkflows(S, now) {
  const dir = path.join(S.dir, 'subagents', 'workflows');
  let st;
  try { st = fs.statSync(dir); } catch { return; }
  if (st.mtimeMs === S.wfDirMtime && now - S.wfScanAt < RESCAN_MS) return;
  S.wfDirMtime = st.mtimeMs;
  S.wfScanAt = now;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const runId of names) {
    if (!/^wf_[0-9a-zA-Z_-]+$/.test(runId)) continue;
    let w = S.wfs.get(runId);
    if (w && w.tail) continue;
    const journal = path.join(dir, runId, 'journal.jsonl');
    const finalFile = path.join(S.dir, 'workflows', runId + '.json');
    const jm = statMs(journal);
    const fm = statMs(finalFile);
    const key = jm + ':' + fm;
    if (w && w.key === key) continue;
    if (!w) {
      w = { runId, dir: path.join(dir, runId), journal, finalFile, key };
      S.wfs.set(runId, w);
    } else {
      w.key = key;
    }
    const recent = fm ? now - fm < PROBLEM_VISIBLE_MS : jm && now - jm < WORKFLOW_STALE_MS;
    if (!recent) continue;
    w.tail = new Tail(journal, JOURNAL_FIRST_BYTES);
    w.agents = new Map();
    w.final = null;
    w.lastPhase = null;
    w.startedAt = firstTimestamp(journal) || jm || now;
  }
}

function closeAgent(a, t) {
  if (a.tail && a.conv) for (const d of a.tail.read()) apply(a.conv, d);
  if (a.conv) {
    cutPending(a.conv, t);
    a.steps = a.conv.steps;
  }
  a.tail = null;
  a.conv = null;
}

function pollWorkflows(S, now) {
  scanWorkflows(S, now);
  const list = [];
  for (const w of S.wfs.values()) {
    if (!w.tail) continue;
    for (const d of w.tail.read()) {
      if (!d || !d.agentId) continue;
      let a = w.agents.get(d.agentId);
      if (!a) {
        const file = path.join(w.dir, 'agent-' + d.agentId + '.jsonl');
        a = { id: d.agentId, label: d.label || d.agentId, phase: d.phase || null, file, startedAt: entryTime(d) || statMs(path.join(w.dir, 'agent-' + d.agentId + '.meta.json')) || now, state: 'running', tail: null, conv: null };
        w.agents.set(d.agentId, a);
      }
      if (d.type === 'started') {
        if (d.label) a.label = d.label;
        if (d.phase) { a.phase = d.phase; w.lastPhase = d.phase; }
      } else if (d.type !== 'launched') {
        a.state = d.type === 'result' ? 'done' : d.type;
        closeAgent(a, entryTime(d) || now);
      }
    }
    if (!w.final) {
      const fm = statMs(w.finalFile);
      if (fm) w.final = readJson(w.finalFile) || (now - fm > FINAL_SETTLE_MS ? { status: 'completed' } : null);
    }
    const doneAt = w.final ? statMs(w.finalFile) : 0;
    const f = w.final || {};
    const failed = w.final && f.status && f.status !== 'completed';
    const died = !w.final && (!S.alive || (S.reg.startedAt && w.tail.mtimeMs < S.reg.startedAt - 2000));
    const keep = failed || died ? PROBLEM_VISIBLE_MS : WF_DONE_VISIBLE_MS;
    if ((w.final && now - doneAt > keep) || (!w.final && !died && now - w.tail.mtimeMs > WORKFLOW_STALE_MS) || (died && now - w.tail.mtimeMs > keep)) {
      w.key = statMs(w.journal) + ':' + doneAt;
      w.tail = null;
      w.agents = null;
      continue;
    }
    const agents = [];
    let done = 0;
    let running = 0;
    for (const a of w.agents.values()) {
      if (a.state === 'running' && !w.final && !died) {
        running++;
        if (!a.tail) { a.tail = new Tail(a.file, AGENT_FIRST_BYTES); a.conv = newConv(S, 'wf:' + w.runId + ':' + a.id); }
        for (const d of a.tail.read()) apply(a.conv, d);
        a.steps = a.conv.steps;
        agents.push({ id: a.id, label: a.label, phase: a.phase, state: a.conv.fatal ? 'failed' : 'running', reason: a.conv.fatal ? a.conv.fatal.text : null, startedAt: a.startedAt, now: agentNow(a.conv), steps: a.conv.steps, recent: a.conv.recent.slice(-6).reverse(), model: a.conv.model, ctx: a.conv.ctx || null });
      } else {
        done++;
        if (a.conv) closeAgent(a, w.final ? doneAt : (S.alive ? S.reg.startedAt : S.deadAt) || now);
        const st = a.state === 'running' ? 'died' : a.state;
        if (!w.final) agents.push({ id: a.id, label: a.label, phase: a.phase, state: st, reason: null, startedAt: a.startedAt, now: null, steps: a.steps || 0, recent: [], model: null, ctx: null });
      }
    }
    agents.sort((x, y) => x.startedAt - y.startedAt);
    const launched = S.conv.workflows.get(w.runId);
    list.push({
      runId: w.runId,
      name: workflowName(S, w.runId, w),
      summary: (launched && launched.summary) || f.summary || null,
      state: died ? 'died' : w.final ? (f.status || 'completed') === 'completed' ? 'done' : 'failed' : 'running',
      reason: died ? 'Ended with the session' : failed ? 'Workflow ' + f.status : null,
      startedAt: f.startTime || w.startedAt || now,
      doneAt: doneAt || null,
      durationMs: f.durationMs || null,
      tokens: f.totalTokens || null,
      phase: w.lastPhase,
      total: f.agentCount || w.agents.size,
      done: w.final ? f.agentCount || done : done,
      running: w.final || died ? 0 : running,
      agents,
    });
  }
  list.sort((x, y) => (y.state === 'running') - (x.state === 'running') || y.startedAt - x.startedAt);
  return list;
}

// --- sessions ---------------------------------------------------------------

const sessions = new Map();

function sessionView(S, now, agents, workflows, shells, blocked) {
  const c = S.conv;
  const reg = S.reg;
  const pend = [...c.pending.values()].sort((a, b) => b.at - a.at);
  const ask = pend.find((p) => NEEDS_YOU_TOOLS.has(p.name) && p.at >= c.promptAt && p.at >= (reg.startedAt || 0) - 2000);
  const lastWrite = Math.max(c.lastAt, S.tail ? S.tail.mtimeMs : 0, S.mt || 0);
  let status = reg.status;
  if (!status) status = now - lastWrite < 60000 ? 'busy' : 'idle';
  const agentPerm = agents.find((a) => a.trouble && a.trouble.kind === 'permission');
  let state;
  let act = null;
  let reason = null;
  let trouble = null;
  if (!S.alive) {
    state = status === 'busy' || c.pending.size ? 'died' : 'ended';
    reason = state === 'died' ? 'The process ended while it was working (killed or crashed)' : 'The process ended without closing the session (killed or crashed)';
  } else if (ask) {
    state = 'needs-you';
    act = { label: ask.label, since: ask.at, tool: ask.name };
  } else if (permissionOf(blocked, c) || agentPerm) {
    state = 'needs-you';
    const p = permissionOf(blocked, c);
    act = p ? { label: p.text, since: p.since, tool: p.tool } : { label: agentPerm.trouble.text + ' (agent: ' + agentPerm.desc + ')', since: agentPerm.trouble.since, tool: agentPerm.trouble.tool };
  } else if (c.fatal && c.fatal.at >= c.promptAt) {
    state = 'error';
    reason = c.fatal.text;
    act = { label: c.fatal.text, since: c.fatal.at };
  } else if (status === 'busy' && c.apiErr && now - c.apiErr.at < RETRY_FRESH_MS) {
    state = 'retrying';
    trouble = troubleOf(c, now, blocked, true);
    act = { label: trouble.text, since: c.apiErr.at };
  } else if (status === 'idle') {
    state = 'your-turn';
    if (c.interruptedAt && c.interruptedAt >= c.promptAt) reason = 'You interrupted it';
  } else {
    state = 'working';
    act = agentNow(c) || (S.headless && !S.headless.kept ? { label: 'Headless run, no transcript', since: reg.startedAt || now } : { label: 'Starting', since: reg.statusUpdatedAt || now });
    const hasProc = [...S.procs.values()].some((p) => p.start >= (c.lastAt || 0) - 3000);
    trouble = troubleOf(c, now, blocked, hasProc);
  }
  const nowBucket = Math.floor(now / BUCKET_MS);
  const convs = liveConvs(S);
  const activity = [];
  for (let b = nowBucket - BUCKETS + 1; b <= nowBucket; b++) {
    let n = 0;
    for (const cv of convs) n += cv.buckets.get(b) || 0;
    activity.push(n);
  }
  return {
    id: reg.sessionId,
    pid: reg.pid,
    alive: S.alive,
    name: reg.name || c.customTitle || c.aiTitle || reg.sessionId.slice(0, 8),
    topic: c.aiTitle && c.aiTitle !== reg.name ? c.aiTitle : null,
    cwd: shortPath(reg.cwd),
    entrypoint: reg.entrypoint || null,
    startedAt: reg.startedAt || null,
    branch: c.branch,
    prs: [...c.prs.values()],
    model: c.model,
    ctx: c.ctx || null,
    state,
    reason,
    trouble,
    since: state === 'your-turn' || state === 'ended' || state === 'died' ? (state === 'your-turn' ? reg.statusUpdatedAt || lastWrite : S.deadAt || lastWrite) : act ? act.since : null,
    turnStartedAt: c.promptAt || null,
    act,
    steps: c.steps,
    prompt: c.lastPromptEntry || (c.prompt ? oneLine(c.prompt, 400) : null) || (S.headless && S.headless.prompt) || null,
    headless: S.headless ? { kept: S.headless.kept } : null,
    said: c.said,
    lastWrite,
    recent: c.recent.slice(-6).reverse(),
    activity,
    agents,
    workflows,
    shells,
  };
}

function attentionFor(v, now) {
  const out = [];
  const sid = v.id;
  const add = (level, node, title, text, since) => out.push({ level, sid, node, title, text, since: since || null, session: v.name });
  if (v.state === 'needs-you') add('needs', 's:' + sid, v.name, v.act ? v.act.label : 'Waiting for you', v.act && v.act.since);
  if (v.state === 'error') add('error', 's:' + sid, v.name, 'Stopped: ' + v.reason, v.since);
  if (v.state === 'retrying') add('error', 's:' + sid, v.name, v.trouble.text, v.trouble.since);
  if (v.state === 'died' && now - v.lastWrite < ATTENTION_MS * 6) add('error', 's:' + sid, v.name, v.reason + ' (pid ' + v.pid + ')', v.since);
  if (v.state === 'ended' && now - v.lastWrite < ATTENTION_MS) add('warn', 's:' + sid, v.name, v.reason, v.since);
  if (v.trouble && v.trouble.kind === 'stalled') add('warn', 's:' + sid, v.name, 'No activity while working', v.trouble.since);
  for (const a of v.agents) {
    const node = 'a:' + sid + ':' + a.id;
    if (a.trouble && a.trouble.kind === 'permission') add('needs', node, a.desc, a.trouble.text, a.trouble.since);
    else if (a.trouble && a.trouble.kind === 'retrying') add('error', node, a.desc, a.trouble.text, a.trouble.since);
    else if (a.trouble && a.trouble.kind === 'stalled') add('warn', node, a.desc, 'No activity', a.trouble.since);
    if (PROBLEM_STATES.has(a.state) && now - (a.doneAt || now) < ATTENTION_MS) add('error', node, a.desc, (a.state === 'failed' ? 'Failed: ' : a.state === 'died' ? 'Died: ' : 'Lost: ') + a.reason, a.doneAt);
  }
  for (const w of v.workflows) {
    if ((w.state === 'failed' || w.state === 'died') && now - (w.doneAt || now) < ATTENTION_MS) add('error', 'w:' + sid + ':' + w.runId, w.name, w.reason, w.doneAt);
  }
  for (const t of v.shells) {
    if (t.state === 'failed') add('warn', 't:' + sid + ':' + t.id, t.desc, (t.why ? t.why + ' (exit ' + t.exit + ')' : 'Exited with code ' + (t.exit != null ? t.exit : '?')), t.doneAt);
    if (t.state === 'died') add('warn', 't:' + sid + ':' + t.id, t.desc, 'Killed with the session', t.doneAt);
  }
  return out;
}

function pollSession(S, now) {
  if (!S.tail) {
    const file = locateTranscript(S.reg, now);
    if (file) {
      S.file = file;
      S.dir = file.slice(0, -'.jsonl'.length);
      S.tail = new Tail(file, SESSION_FIRST_BYTES);
    }
  }
  if (S.alive) S.readDead = S.cut = false;
  if (S.tail && (S.alive || !S.readDead)) {
    for (const d of S.tail.read()) apply(S.conv, d);
    if (!S.alive) S.readDead = true;
  }
  if (S.dir) readAgents(S, now);
  if (!S.alive && !S.cut && S.tail) {
    S.cut = true;
    cutPending(S.conv, Math.max(S.deadAt || now, S.conv.lastAt || 0));
    for (const a of S.agents.values()) if (a.conv) cutPending(a.conv, Math.max(S.deadAt || now, a.conv.lastAt || 0));
  }
  if (S.alive && S.reg.startedAt) {
    cutBefore(S.conv, S.reg.startedAt);
    for (const a of S.agents.values()) if (a.conv) cutBefore(a.conv, S.reg.startedAt);
  }
  const workflows = S.dir ? pollWorkflows(S, now) : [];
  if (S.alive) scanProcs(S);
  else S.procs.clear();
  const { used, blocked } = S.alive ? matchForeground(S, now) : { used: new Set(), blocked: [] };
  if (S.alive) {
    noteRunningTasks(S, now, used);
    backfillTasks(S, now);
  }
  const shells = shellViews(S, now);
  const agents = S.dir ? agentViews(S, now, shells.owners, blocked) : [];
  return sessionView(S, now, agents, workflows, shells.list, blocked);
}

// A session started from another session's shell (claude -p) is drawn under that shell.
function linkNestedSessions(views) {
  const pidToSid = new Map();
  for (const v of views) if (v.alive) pidToSid.set(String(v.pid), v.id);
  for (const v of views) {
    if (!v.alive) continue;
    let pid = String(v.pid);
    for (let i = 0; i < 12; i++) {
      const info = procInfo(pid);
      if (!info) break;
      const pp = info.ppid;
      if (!pp || pp === '0' || pp === '1') break;
      const parent = pidToSid.get(pp);
      if (parent && parent !== v.id) {
        const PS = sessions.get(parent);
        const proc = PS && PS.procs.get(pid);
        v.parentSid = parent;
        v.parentTask = (proc && proc.task) || null;
        v.parentOwner = (proc && proc.fgOwner) || null;
        break;
      }
      pid = pp;
    }
  }
}

let snapshot = { now: Date.now(), totals: {}, sessions: [], attention: [], pollMs: POLL_MS, costMs: 0 };
let snapshotJson = JSON.stringify(snapshot);
const clients = new Set();

function poll() {
  const t0 = Date.now();
  const now = t0;
  try {
    refreshProcs();
    const regs = readRegistry(now);
    for (const id of sessions.keys()) if (!regs.has(id)) sessions.delete(id);
    const views = [];
    for (const [id, r] of regs) {
      let S = sessions.get(id);
      if (!S) {
        S = { id, reg: r.reg, alive: r.alive, mt: r.mt, deadAt: r.alive ? 0 : r.mt, firstSeenDead: !r.alive, file: null, dir: null, tail: null, readDead: false, cut: false, agents: new Map(), wfs: new Map(), tasks: new Map(), ends: new Map(), procs: new Map(), agentDirMtime: 0, agentScanAt: 0, wfDirMtime: 0, wfScanAt: 0, backfillAt: 0 };
        S.conv = newConv(S, null);
        sessions.set(id, S);
      }
      if (S.alive && !r.alive) S.deadAt = now;
      S.reg = r.reg;
      S.alive = r.alive;
      S.mt = r.mt;
      if (S.alive && S.headlessPid !== r.reg.pid) { S.headless = headlessOf(r.reg.pid); S.headlessPid = r.reg.pid; }
      const v = pollSession(S, now);
      if (!S.alive) {
        if (!S.firstSeenDead && now - S.deadAt < DEATH_GRACE_MS) continue;
        const keep = v.state === 'died' ? PROBLEM_VISIBLE_MS : ENDED_VISIBLE_MS;
        if (now - v.lastWrite > keep) continue;
      }
      views.push(v);
    }
    linkNestedSessions(views);
    const rank = { 'needs-you': 0, error: 1, retrying: 1, died: 2, working: 3, 'your-turn': 4, ended: 5 };
    views.sort((a, b) => rank[a.state] - rank[b.state] || b.lastWrite - a.lastWrite);
    const totals = { sessions: 0, working: 0, yourTurn: 0, needsYou: 0, problems: 0, agentsRunning: 0, shellsRunning: 0, workflowsRunning: 0, ended: 0 };
    let attention = [];
    for (const v of views) {
      if (v.alive) totals.sessions++;
      else totals.ended++;
      if (v.state === 'working' || v.state === 'retrying') totals.working++;
      else if (v.state === 'your-turn' || v.state === 'error') totals.yourTurn++;
      else if (v.state === 'needs-you') totals.needsYou++;
      for (const a of v.agents) if (a.state === 'running') totals.agentsRunning++;
      for (const w of v.workflows) {
        if (w.state === 'running') totals.workflowsRunning++;
        totals.agentsRunning += w.running;
      }
      for (const t of v.shells) if (t.state === 'running') totals.shellsRunning++;
      attention = attention.concat(attentionFor(v, now));
    }
    const lv = { needs: 0, error: 1, warn: 2 };
    attention.sort((x, y) => lv[x.level] - lv[y.level] || (y.since || 0) - (x.since || 0));
    totals.problems = attention.filter((x) => x.level !== 'needs').length;
    const down = views.some((v) => v.trouble && v.trouble.down) || views.some((v) => v.agents.some((a) => a.trouble && a.trouble.down));
    const next = { now, pollMs: POLL_MS, costMs: Date.now() - t0, totals, attention, networkDown: down, sessions: views };
    const json = JSON.stringify({ ...next, now: 0, costMs: 0 });
    const changed = json !== snapshotJson;
    snapshot = next;
    snapshotJson = json;
    if (changed) broadcast();
    histPoll(now);
    trimSteps(now);
    if (evNew.length || evEnded.length) {
      const payload = 'event: ev\ndata: ' + JSON.stringify({ a: evNew.map(evRow), d: evEnded }) + '\n\n';
      evNew = [];
      evEnded = [];
      for (const res of clients) res.write(payload);
    }
  } catch (e) {
    logOnce(e);
  }
  setTimeout(poll, POLL_MS);
}

const logged = new Set();
function logOnce(e) {
  const msg = (e && e.stack) || String(e);
  if (logged.has(msg)) return;
  logged.add(msg);
  console.error(new Date().toISOString(), msg);
}

function broadcast() {
  const payload = 'data: ' + JSON.stringify(snapshot) + '\n\n';
  for (const res of clients) res.write(payload);
}

const ALLOWED_HOSTS = new Set([HOST + ':' + PORT, 'localhost:' + PORT]);
const STATIC = { '/map.js': 'map.js', '/live.js': 'live.js', '/usage-ui.js': 'usage-ui.js', '/vendor/d3.min.js': path.join('vendor', 'd3.min.js') };

// ---------- usage: tokens from the transcripts, limits from cswap ----------

let usageSummary = null;
function startUsage() {
  let w;
  try {
    w = new Worker(path.join(__dirname, 'usage-scan.js'), { workerData: { root: PROJECTS_DIR, index: USAGE_INDEX, seed: path.join(__dirname, 'usage-index.json') } });
  } catch (e) { logOnce(e); return; }
  w.on('message', (m) => {
    if (m.notice) logOnce(m.notice);
    else usageSummary = m;
  });
  w.on('error', logOnce);
  w.on('exit', () => setTimeout(startUsage, MIN));
}

// the XDG spec ignores a relative path
function xdgDir(name, fallback) {
  const xdg = (process.env[name] || '').replace(/^~(?=$|\/)/, () => HOME);
  return path.isAbsolute(xdg) ? xdg : path.join(HOME, fallback);
}

// npm can install the code where its user cannot write, and the index keeps the totals of deleted transcripts
function usageIndexFile() {
  const base = process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support') : xdgDir('XDG_STATE_HOME', path.join('.local', 'state'));
  // servers reading different Claude folders must not mix their totals
  const folder = crypto.createHash('sha1').update(path.resolve(PROJECTS_DIR)).digest('hex').slice(0, 12);
  return path.join(base, 'claude-overview', 'usage-index-' + folder + '.json');
}

// cswap keeps its files under the XDG data dir on Linux and in ~/.claude-swap-backup on macOS
function cswapDir() {
  if (process.platform !== 'linux') return path.join(HOME, '.claude-swap-backup');
  return path.join(xdgDir('XDG_DATA_HOME', path.join('.local', 'share')), 'claude-swap');
}

// cswap's account list, its last usage reading per account and its last switch; its credentials are never read.
function cswapAccounts() {
  const seq = readJson(path.join(CSWAP_DIR, 'sequence.json'));
  if (!seq || !seq.accounts) return null;
  const store = readJson(path.join(CSWAP_DIR, 'cache', 'usage.json'));
  const rows = (store && store.schemaVersion === 2 && store.accounts) || {};
  const sw = readJson(path.join(CSWAP_DIR, 'autoswitch_state.json')) || {};
  const now = Date.now();
  const win = (w) => {
    if (!w || typeof w.pct !== 'number') return null;
    const at = w.resets_at ? Date.parse(w.resets_at) : 0;
    // a window whose reset has passed has rolled over, so its stored percentage is stale
    return at && at <= now ? { pct: 0, at: 0 } : { pct: w.pct, at };
  };
  const nums = Array.isArray(seq.sequence) && seq.sequence.length ? seq.sequence : Object.keys(seq.accounts).map(Number);
  const list = [];
  for (const num of nums) {
    const a = seq.accounts[String(num)];
    if (!a) continue;
    const row = rows[String(num)];
    const ok = !!row && row.email === a.email;
    const g = (ok && row.lastGood) || {};
    list.push({
      num,
      email: a.email || '',
      alias: a.alias || '',
      org: a.organizationName || '',
      active: num === seq.activeAccountNumber,
      disabled: !!a.disabled,
      apiKey: a.kind === 'api_key',
      h5: win(g.five_hour),
      d7: win(g.seven_day),
      scoped: (Array.isArray(g.scoped) ? g.scoped : []).map((x) => Object.assign({ name: String(x.name || '') }, win(x))).filter((x) => x.pct != null),
      fetched: ok && row.fetchedAt ? row.fetchedAt * 1000 : 0,
      error: (ok && row.lastError) || null,
      dead: ok && (row.authDeadStrikes || 0) >= 1,
    });
  }
  return { list, lastSwitch: sw.lastSwitchAt ? { at: sw.lastSwitchAt * 1000, from: sw.lastSwitchFrom, to: sw.lastSwitchTo } : null };
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function localDay(back) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function addInto(a, b) { for (let i = 0; i < 5; i++) a[i] += b[i]; }
function usageReply(range) {
  const RANGES = { today: 1, '7d': 7, '30d': 30, month: 0, all: 0 };
  if (!Object.prototype.hasOwnProperty.call(RANGES, range)) range = '7d';
  const out = { now: Date.now(), range, accounts: cswapAccounts(), progress: usageSummary ? usageSummary.progress : null };
  const u = usageSummary;
  if (!u) return out;
  const today = localDay(0);
  const keys = [];
  if (range === 'all' || range === 'month') {
    const first = range === 'all' ? Object.keys(u.days).sort()[0] || today : today.slice(0, 8) + '01';
    for (let i = 0; ; i++) {
      const k = localDay(i);
      if (k < first) break;
      keys.unshift(k);
    }
  } else for (let i = RANGES[range] - 1; i >= 0; i--) keys.push(localDay(i));
  const totals = [0, 0, 0, 0, 0];
  const agents = [0, 0, 0, 0, 0];
  const models = {};
  const projects = {};
  const sessions = {};
  for (const k of keys) {
    const D = u.days[k];
    if (!D) continue;
    for (const m in D.m) { addInto(totals, D.m[m]); addInto(models[m] || (models[m] = [0, 0, 0, 0, 0]), D.m[m]); }
    for (const p in D.p) addInto(projects[p] || (projects[p] = [0, 0, 0, 0, 0]), D.p[p]);
    for (const sid in D.s) addInto(sessions[sid] || (sessions[sid] = [0, 0, 0, 0, 0]), D.s[sid]);
    addInto(agents, D.ag);
  }
  let series;
  if (range === 'today') {
    series = [];
    for (let h = 0; h <= new Date().getHours(); h++) series.push({ k: today + 'T' + pad2(h), m: u.hours[today + 'T' + pad2(h)] || {} });
  } else series = keys.map((k) => ({ k, m: (u.days[k] && u.days[k].m) || {} }));
  const live = new Map((snapshot && snapshot.sessions || []).map((x) => [x.id, x.name]));
  const byOut = (a, b) => b[1][2] - a[1][2];
  out.totals = totals;
  out.agents = agents;
  out.series = series;
  out.models = Object.entries(models).sort(byOut);
  out.projects = Object.entries(projects).sort(byOut).slice(0, 8).map(([p, a]) => [p ? p.replace(HOME_RE, '~') : '', a]);
  out.sessions = Object.entries(sessions).sort(byOut).slice(0, 10).map(([sid, a]) => {
    const meta = u.sess[sid] || {};
    return { sid, a, name: live.get(sid) || '', title: meta.t || '', cwd: meta.c ? meta.c.replace(HOME_RE, '~') : '', last: meta.l || 0, live: live.has(sid) };
  });
  return out;
}

const server = http.createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  const url = (req.url || '/').split('?')[0];
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  if (url === '/') {
    fs.readFile(PAGE, (err, body) => {
      if (err) { res.writeHead(500); res.end('page missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" });
      res.end(body);
    });
    return;
  }
  if (STATIC[url]) {
    fs.readFile(path.join(__dirname, STATIC[url]), (err, body) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    });
    return;
  }
  if (url === '/usage') {
    const range = (/[?&]range=([a-z0-9]+)/.exec(req.url || '') || [])[1] || '7d';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(usageReply(range)));
    return;
  }
  if (url === '/state.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(snapshot, null, 2));
    return;
  }
  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(snapshot) + '\n\n');
    const min = Date.now() - EV_HISTORY_MS;
    res.write('event: hist\ndata: ' + JSON.stringify({ a: evLog.filter((e) => e.t >= min).map(evRow) }) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  res.writeHead(404);
  res.end();
});

setInterval(() => {
  for (const res of clients) res.write('event: tick\ndata: ' + Date.now() + '\n\n');
}, 10000);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(new Date().toISOString(), 'Port ' + PORT + ' is already in use, maybe by another copy of claude-overview. Set CLAUDE_OVERVIEW_PORT to use another port.');
  else console.error(new Date().toISOString(), e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(new Date().toISOString(), 'Claude overview on http://' + HOST + ':' + PORT + '/');
  poll();
  startUsage();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
