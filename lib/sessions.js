'use strict';

const fs = require('fs');
const path = require('path');
const { SESSIONS_DIR, PROJECTS_DIR } = require('./config');
const { RESCAN_MS, NEW_SESSION_RESCAN_MS, SESSION_FIRST_BYTES, PROBLEM_VISIBLE_MS, ENDED_VISIBLE_MS, ATTENTION_MS, RETRY_FRESH_MS, PROMPT_LEAD_MS, DEATH_GRACE_MS, BUCKET_MS, BUCKETS, NEEDS_YOU_TOOLS, AGENT_TOOLS } = require('./constants');
const { PROBLEM_STATES, readAgents, agentStatus, agentViews } = require('./agents');
const { newConv, liveConvs, apply, agentNow, permissionOf, troubleOf } = require('./conversation');
const { Tail, readJson, statMs } = require('./files');
const { refreshProcs, procInfo, alive, headlessOf } = require('./procs');
const { scanProcs, matchForeground, noteRunningTasks, backfillTasks, shellViews } = require('./shells');
const { cutPending, cutBefore } = require('./steps');
const { oneLine, shortPath } = require('./text');
const { pollWorkflows } = require('./workflows');

const WAIT_TEXT = {
  'permission prompt': 'Waiting for your permission',
  'sandbox request': 'Waiting for your permission',
  'worker request': 'Waiting for your permission',
  'input needed': 'Waiting for your answer',
  'goal proposal': 'Waiting for your answer',
};
// older versions are not known to write the waiting status
const WAITING_FROM = [2, 1, 286];

const regCache = new Map();
const located = new Map();
const sessions = new Map();

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

function newSession(id, r) {
  const S = { id, reg: r.reg, alive: r.alive, mt: r.mt, deadAt: r.alive ? 0 : r.mt, firstSeenDead: !r.alive, file: null, dir: null, tail: null, readDead: false, cut: false, agents: new Map(), wfs: new Map(), tasks: new Map(), ends: new Map(), procs: new Map(), agentDirMtime: 0, agentScanAt: 0, wfDirMtime: 0, wfScanAt: 0, backfillAt: 0 };
  S.conv = newConv(S, null);
  return S;
}

// Claude Code does not say which call its prompt is for
function waitedOn(S, fg, now, shellOwners) {
  const reg = S.reg;
  if (reg.status !== 'waiting' || reg.waitingFor !== 'permission prompt' || fg.guessed) return [];
  for (const a of S.agents.values()) if (a.tail && a.conv) a.conv.ended = agentStatus(S, a, now, shellOwners, []).state !== 'running';
  const since = Math.max((reg.startedAt || 0) - 2000, (reg.statusUpdatedAt || 0) - PROMPT_LEAD_MS);
  let one = null;
  for (const c of liveConvs(S)) {
    // an agent stopped in the middle of a call keeps that call open
    if (c.ended) continue;
    for (const p of c.pending.values()) {
      if (p.at < since || AGENT_TOOLS.has(p.name) || fg.running.has(p)) continue;
      if (one) return [];
      one = { c, p, since: reg.statusUpdatedAt || p.at };
    }
  }
  return one ? [one] : [];
}

function writesWaiting(reg) {
  if (!reg.status) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(reg.version || ''));
  if (!m) return false;
  for (let i = 0; i < 3; i++) if (Number(m[i + 1]) !== WAITING_FROM[i]) return Number(m[i + 1]) > WAITING_FROM[i];
  return true;
}

function sessionView(S, now, agents, workflows, shells, blocked) {
  const c = S.conv;
  const reg = S.reg;
  const pend = [...c.pending.values()].sort((a, b) => b.at - a.at);
  const ask = pend.find((p) => NEEDS_YOU_TOOLS.has(p.name) && p.at >= c.promptAt && p.at >= (reg.startedAt || 0) - 2000);
  const lastWrite = Math.max(c.lastAt, S.tail ? S.tail.mtimeMs : 0, S.mt || 0);
  if (reg.status === 'busy' || reg.status === 'idle' || reg.status === 'shell') {
    S.held = reg.status;
    S.heldAt = reg.statusUpdatedAt || 0;
  }
  let status = reg.status;
  // Claude Code reports a screen you opened, such as /model, as a dialog, even after the turn under it ends
  if (reg.status === 'waiting' && reg.waitingFor === 'dialog open') {
    const born = (reg.startedAt || 0) - 2000;
    // a command or a notification starts a turn without setting a prompt time
    const from = S.held ? S.heldAt : born;
    const ended = (c.lastStop === 'end_turn' && c.lastActAt > from && !(c.promptAt > c.lastActAt)) || c.interruptedAt > from;
    const quiet = S.held !== 'busy' && !(c.promptAt > from) && !(c.lastActAt > from);
    status = quiet ? S.held || 'idle' : !pend.some((p) => p.at >= born) && ended ? 'idle' : 'busy';
  }
  if (!status) status = now - lastWrite < 60000 ? 'busy' : 'idle';
  // a whole turn can start and end between two polls
  if (status === 'busy' || (c.lastActAt > S.idleAt && (reg.status === 'waiting' || reg.statusUpdatedAt > S.idleAt))) S.idleAt = 0;
  if ((status === 'idle' || status === 'shell') && !S.idleAt) S.idleAt = (reg.status === 'waiting' ? c.lastActAt : reg.statusUpdatedAt) || lastWrite;
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
  } else if (status === 'waiting' || permissionOf(blocked, c) || agentPerm) {
    state = 'needs-you';
    const p = permissionOf(blocked, c);
    if (p) act = { label: p.text, since: p.since, tool: p.tool };
    else if (agentPerm) act = { label: agentPerm.trouble.text + ' (agent: ' + agentPerm.desc + ')', since: agentPerm.trouble.since, tool: agentPerm.trouble.tool };
    else act = { label: WAIT_TEXT[reg.waitingFor] || 'Waiting for you', since: reg.statusUpdatedAt || now };
  } else if (c.fatal && c.fatal.at >= c.promptAt) {
    state = 'error';
    reason = c.fatal.text;
    act = { label: c.fatal.text, since: c.fatal.at };
  } else if (status === 'busy' && c.apiErr && now - c.apiErr.at < RETRY_FRESH_MS) {
    state = 'retrying';
    trouble = troubleOf(c, now, blocked, true);
    act = { label: trouble.text, since: c.apiErr.at };
  } else if (status === 'idle' || status === 'shell') {
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
    since: state === 'your-turn' || state === 'ended' || state === 'died' ? (state === 'your-turn' ? S.idleAt || lastWrite : S.deadAt || lastWrite) : act ? act.since : null,
    turnStartedAt: c.promptAt || null,
    act,
    steps: c.steps,
    prompt: c.lastPromptEntry || (c.prompt ? oneLine(c.prompt, 400) : null) || (S.headless && S.headless.prompt) || null,
    headless: S.headless ? { kept: S.headless.kept } : null,
    waiting: S.alive && reg.status === 'waiting' ? { for: reg.waitingFor || null, since: reg.statusUpdatedAt || null, text: WAIT_TEXT[reg.waitingFor] || null } : null,
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
  // no desktop alert for quiet rows: nobody answers a headless run, and a nested session's problems are its parent's
  const add = (level, node, title, text, since, quiet) => out.push({ level, sid, node, title, text, since: since || null, session: v.name, quiet: !!(quiet || v.headless || v.parentSid) });
  if (v.state === 'needs-you') add('needs', 's:' + sid, v.name, v.act ? v.act.label : 'Waiting for you', v.act && v.act.since);
  if (v.state === 'error') add('error', 's:' + sid, v.name, 'Stopped: ' + v.reason, v.since);
  if (v.state === 'retrying') add('error', 's:' + sid, v.name, v.trouble.text, v.trouble.since, true);
  if (v.state === 'died' && now - v.lastWrite < ATTENTION_MS * 6) add('error', 's:' + sid, v.name, v.reason + ' (pid ' + v.pid + ')', v.since);
  if (v.state === 'ended' && now - v.lastWrite < ATTENTION_MS) add('warn', 's:' + sid, v.name, v.reason, v.since, ![...v.agents, ...v.workflows].some((x) => x.state === 'died'));
  if (v.trouble && v.trouble.kind === 'stalled') add('warn', 's:' + sid, v.name, 'No activity while working', v.trouble.since, true);
  for (const a of v.agents) {
    const node = 'a:' + sid + ':' + a.id;
    if (a.trouble && a.trouble.kind === 'permission') add('needs', node, a.desc, a.trouble.text, a.trouble.since);
    else if (a.trouble && a.trouble.kind === 'retrying') add('error', node, a.desc, a.trouble.text, a.trouble.since, true);
    else if (a.trouble && a.trouble.kind === 'stalled') add('warn', node, a.desc, 'No activity', a.trouble.since, true);
    if (PROBLEM_STATES.has(a.state) && now - (a.doneAt || now) < ATTENTION_MS) add('error', node, a.desc, (a.state === 'failed' ? 'Failed: ' : a.state === 'died' ? 'Died: ' : 'Lost: ') + a.reason, a.doneAt, a.state === 'died');
  }
  for (const w of v.workflows) {
    if ((w.state === 'failed' || w.state === 'died') && now - (w.doneAt || now) < ATTENTION_MS) add('error', 'w:' + sid + ':' + w.runId, w.name, w.reason, w.doneAt, w.state === 'died');
  }
  for (const t of v.shells) {
    if (t.state === 'failed') add('warn', 't:' + sid + ':' + t.id, t.desc, (t.why ? t.why + ' (exit ' + t.exit + ')' : 'Exited with code ' + (t.exit != null ? t.exit : '?')), t.doneAt, true);
    if (t.state === 'died') add('warn', 't:' + sid + ':' + t.id, t.desc, 'Killed with the session', t.doneAt, true);
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
  const fg = S.alive ? matchForeground(S, now) : { used: new Set(), running: new Set(), guessed: false, blocked: [] };
  if (S.alive) {
    noteRunningTasks(S, now, fg.used);
    backfillTasks(S, now, transcriptsOf(S));
  }
  const shells = shellViews(S, now);
  // the timing guess can flag a call that is not waiting for you
  const blocked = writesWaiting(S.reg) ? waitedOn(S, fg, now, shells.owners) : fg.blocked;
  const agents = S.dir ? agentViews(S, now, shells.owners, blocked) : [];
  return sessionView(S, now, agents, workflows, shells.list, blocked);
}

// A session started from another session's shell (claude -p) is drawn under that session.
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

function collect(now) {
  refreshProcs();
  const regs = readRegistry(now);
  for (const id of sessions.keys()) if (!regs.has(id)) sessions.delete(id);
  const views = [];
  for (const [id, r] of regs) {
    let S = sessions.get(id);
    if (!S) {
      S = newSession(id, r);
      sessions.set(id, S);
    }
    if (S.alive && !r.alive) S.deadAt = now;
    // the status held for a session belongs to the process that wrote it
    if (S.reg.pid !== r.reg.pid) { S.held = null; S.idleAt = 0; }
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
  return { totals, attention, networkDown: down, sessions: views };
}

function* transcriptsOf(S) {
  if (S.file && S.tail) yield { file: S.file, backFrom: S.tail.startOffset, owner: null, conv: S.conv, S };
  for (const a of S.agents.values()) {
    if (a.file) yield { file: a.file, backFrom: a.tail ? a.tail.startOffset : a.startOffset, owner: a.id, conv: a.conv, S };
  }
  for (const w of S.wfs.values()) {
    if (!w.agents) continue;
    for (const a of w.agents.values()) if (a.file) yield { file: a.file, backFrom: a.tail ? a.tail.startOffset : a.startOffset, owner: 'wf:' + w.runId + ':' + a.id, conv: a.conv, S };
  }
}

function* historyFiles() {
  for (const S of sessions.values()) yield* transcriptsOf(S);
}

module.exports = { collect, historyFiles, newSession, waitedOn };
