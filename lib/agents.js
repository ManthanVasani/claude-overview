'use strict';

const fs = require('fs');
const path = require('path');
const { RESCAN_MS, AGENT_FIRST_BYTES, DONE_VISIBLE_MS, PROBLEM_VISIBLE_MS, LOST_MS } = require('./constants');
const { newConv, apply, agentNow, troubleOf } = require('./conversation');
const { Tail, readJson, statMs, firstTimestamp } = require('./files');

const PROBLEM_STATES = new Set(['failed', 'died', 'lost']);

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

module.exports = { PROBLEM_STATES, readAgents, agentStatus, agentViews };
