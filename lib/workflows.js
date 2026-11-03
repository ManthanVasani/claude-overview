'use strict';

const fs = require('fs');
const path = require('path');
const { RESCAN_MS, AGENT_FIRST_BYTES, JOURNAL_FIRST_BYTES, PROBLEM_VISIBLE_MS, WF_DONE_VISIBLE_MS, WORKFLOW_STALE_MS, FINAL_SETTLE_MS } = require('./constants');
const { newConv, apply, agentNow } = require('./conversation');
const { Tail, readJson, statMs, firstTimestamp } = require('./files');
const { cutPending } = require('./steps');
const { entryTime } = require('./text');

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

module.exports = { pollWorkflows };
