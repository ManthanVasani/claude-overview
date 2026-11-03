'use strict';

const fs = require('fs');
const { MIN, RESCAN_MS, PROBLEM_VISIBLE_MS, SHELL_DONE_VISIBLE_MS, SHELL_PROBLEM_VISIBLE_MS, BACKFILL_PER_FILE, BACKFILL_PER_RUN, PERMISSION_MS } = require('./constants');
const { liveConvs, newTask, launchId, startedId } = require('./conversation');
const { fileSize, readBack, statMs } = require('./files');
const { PROC_FS } = require('./config');
const { childrenOf, procInfo, stdoutOf, cmdOf, psText } = require('./procs');
const { TOOL_SHELL_RE, cmdKey, evalCommand, claudeQuote, evalWordIs } = require('./shell-line');
const { escapeRe, oneLine, entryTime } = require('./text');
const { shellDesc } = require('./tools');

const INSTANT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const EXIT_WHY = { 126: 'Not executable', 127: 'Command not found', 130: 'Interrupted', 137: 'Killed', 143: 'Terminated' };

function exitWhy(code, timed) { return code === 124 && timed ? 'Timed out' : EXIT_WHY[code] || null; }

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
    p.cmd = cmdOf(p.pid);
    S.procs.set(p.pid, p);
  }
  for (const pid of S.procs.keys()) if (!seen.has(pid)) S.procs.delete(pid);
}

// A foreground call that never starts a process is taken as a permission prompt.
function matchForeground(S, now) {
  const fg = [];
  const since = (S.reg.startedAt || 0) - 2000;
  const first = new Map();
  for (const c of liveConvs(S)) {
    for (const p of c.pending.values()) {
      if (p.bg || p.at < since || !(p.name === 'Bash' || INSTANT_TOOLS.has(p.name))) continue;
      if (!first.has(c)) first.set(c, p);
      if (p.name !== 'Bash') continue;
      if (p.ps === undefined) {
        p.ps = psText(p.cmd);
        p.word = PROC_FS ? null : psText(claudeQuote(p.cmd));
      }
      fg.push({ c, p });
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
    } else if (now - p.at > PERMISSION_MS && first.get(c) === p) blocked.push({ c, p, since: p.at + PERMISSION_MS });
  }
  for (const c of liveConvs(S)) {
    for (const p of c.pending.values()) {
      if (INSTANT_TOOLS.has(p.name) && first.get(c) === p && now - p.at > PERMISSION_MS) blocked.push({ c, p, since: p.at + PERMISSION_MS });
    }
  }
  const running = new Set();
  let guessed = false;
  for (const proc of S.procs.values()) {
    // a hook can run while its call waits for permission
    if (!(proc.task || TOOL_SHELL_RE.test(proc.cmd || '')) || (proc.task && S.tasks.has(proc.task))) continue;
    const near = fg.filter((x) => proc.start >= x.p.at - 3000);
    if (!near.length) continue;
    const ev = evalCommand(proc.cmd);
    const hits = near.filter((x) => x.p.ps != null && (x.p.ps === ev || (x.p.word != null && evalWordIs(proc.cmd, x.p.word))));
    if (hits.length === 1 && !running.has(hits[0].p)) {
      running.add(hits[0].p);
      // a stray child can take this shell's pairing, and an unpaired shell is read as a background one
      used.add(proc.pid);
      proc.fgOwner = hits[0].c.owner;
    } else guessed = true;
  }
  return { used, running, guessed, blocked };
}

function noteRunningTasks(S, now, used) {
  for (const proc of S.procs.values()) {
    if (!proc.task || used.has(proc.pid)) continue;
    let k = S.tasks.get(proc.task);
    if (!k) {
      if (now - proc.start < 5000) continue;
      k = newTask(proc.task, null, proc.start, true);
      S.tasks.set(proc.task, k);
    }
    k.seenRunning = now;
    k.goneAt = 0;
    if (!k.desc && !k.fallback) k.fallback = fallbackDesc(proc.pid);
  }
}

function fallbackDesc(pid) {
  const cmd = cmdOf(pid);
  if (cmd == null) return null;
  const ev = evalCommand(cmd);
  return '$ ' + oneLine(ev == null ? cmd : ev, 120);
}

function scanTextForTasks(text, want, owner, orphans) {
  for (const [useId, o] of orphans) {
    const found = callBefore(text, useId, text.length);
    if (!found) continue;
    orphans.delete(useId);
    if (want.has(o.k.id) && launchId(found.call.name, o.res, o.r) === o.k.id) takeLaunch(o.k, found, owner, want);
  }
  if (!want.size) return;
  const re = new RegExp([...want.keys()].map(escapeRe).join('|'), 'g');
  const hits = [];
  let m;
  while ((m = re.exec(text))) hits.push([m.index, m[0]]);
  let done = Infinity;
  for (let i = hits.length - 1; i >= 0 && want.size; i--) {
    const [idx, hitId] = hits[i];
    if (idx >= done || !want.has(hitId)) continue;
    const ls = text.lastIndexOf('\n', idx) + 1;
    done = ls;
    let le = text.indexOf('\n', ls);
    if (le === -1) le = text.length;
    if (text.startsWith('{"type":"api-request', ls) || le - ls > (4 << 20)) continue;
    let d;
    try { d = JSON.parse(text.slice(ls, le)); } catch { continue; }
    const a = d.type === 'attachment' && d.attachment;
    if (a && a.type === 'task_status') {
      const k = want.get(a.taskId);
      if (!k) continue;
      if (!k.ownerSure) k.owner = owner;
      if (a.description) {
        k.desc = oneLine(a.description, 140);
        if (!k.cmdKey && a.shell) k.cmdKey = cmdKey(a.shell.command);
        want.delete(k.id);
        k.needsInfo = false;
      }
      continue;
    }
    if (d.type !== 'user' || !d.message || !Array.isArray(d.message.content)) continue;
    const r = d.toolUseResult && typeof d.toolUseResult === 'object' ? d.toolUseResult : null;
    for (const res of d.message.content) {
      if (!res || res.type !== 'tool_result') continue;
      const k = want.get(startedId(res, r));
      if (!k) continue;
      const found = callBefore(text, res.tool_use_id, ls);
      // a chunk can start between a call and its result
      if (!found) { orphans.set(res.tool_use_id, { k, res, r }); continue; }
      if (launchId(found.call.name, res, r) === k.id) { takeLaunch(k, found, owner, want); break; }
    }
  }
}

function takeLaunch(k, found, owner, want) {
  const call = found.call;
  k.owner = owner;
  k.ownerSure = true;
  k.desc = shellDesc(call.input);
  k.kind = call.name === 'Monitor' ? 'monitor' : 'shell';
  k.cmdKey = cmdKey(call.input && call.input.command);
  k.startedAt = found.at || k.startedAt;
  want.delete(k.id);
  k.needsInfo = false;
}

function callBefore(text, id, before) {
  const j = text.lastIndexOf('"id":"' + id + '"', before);
  if (j === -1) return null;
  const us = text.lastIndexOf('\n', j) + 1;
  let ue = text.indexOf('\n', j);
  if (ue === -1) ue = text.length;
  let u;
  try { u = JSON.parse(text.slice(us, ue)); } catch { return null; }
  const call = ((u.message && u.message.content) || []).find((x) => x && x.type === 'tool_use' && x.id === id);
  return call ? { call, at: entryTime(u) } : null;
}

function searchBack(file, end, limit, want, owner) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  let pos = end;
  let carry = Buffer.alloc(0);
  const orphans = new Map();
  try {
    while (pos > 0 && end - pos < limit && want.size) {
      const chunk = readBack(fd, pos, carry);
      pos = chunk.pos;
      carry = chunk.carry;
      if (chunk.text !== null) scanTextForTasks(chunk.text, want, owner, orphans);
    }
  } finally {
    fs.closeSync(fd);
  }
  return end - pos;
}

// Running shells whose launch is older than the first tail read: look further back once.
function backfillTasks(S, now, transcripts) {
  const want = new Map();
  for (const k of S.tasks.values()) if (k.needsInfo && !k.tried && k.seenRunning) want.set(k.id, k);
  if (!want.size || now - S.backfillAt < RESCAN_MS) return;
  S.backfillAt = now;
  for (const k of want.values()) k.tried = true;
  const files = [];
  const agents = [];
  for (const f of transcripts) {
    if (f.owner === null) { files.push(f); continue; }
    const mtime = statMs(f.file);
    if (now - mtime < PROBLEM_VISIBLE_MS) agents.push({ f, mtime, wf: f.owner.startsWith('wf:') });
  }
  // a workflow can run hundreds of agents; they must not use up the budget the others need
  agents.sort((x, y) => x.wf - y.wf || y.mtime - x.mtime);
  for (const a of agents) files.push(a.f);
  let budget = BACKFILL_PER_RUN;
  for (const f of files) {
    if (!want.size || budget <= 0) break;
    // a launch's call can sit before the first read and its result after it
    const end = fileSize(f.file);
    if (end <= 0) continue;
    budget -= searchBack(f.file, end, Math.min(BACKFILL_PER_FILE, budget), want, f.owner);
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
      const key = psText(k.cmdKey);
      for (const p of S.procs.values()) if (!p.task && p.cmd && p.cmd.indexOf(key) !== -1) { proc = p; break; }
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

module.exports = { scanProcs, matchForeground, noteRunningTasks, backfillTasks, shellViews };
