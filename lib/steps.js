'use strict';

const fs = require('fs');
const { MIN, HOUR, EV_KEEP_MS, EV_HISTORY_MS, EV_MAX, HIST_SLICE, HIST_PER_FILE, LATE_ENDS_MAX } = require('./constants');
const { isFileError, statMs, fileSize, readBack } = require('./files');
const { entryTime, toolError } = require('./text');
const { classify, describe } = require('./tools');

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
  return addStep(id, c.S, c.owner, name, input, label, t || Date.now(), cwd);
}

function addStep(id, S, owner, name, input, label, t, cwd) {
  const { k, r } = classify(name, input, cwd || (S.reg && S.reg.cwd));
  const e = { s: ++evSeq, sid: S.id, o: owner, t, n: name, k, r, l: label, e: 0, ok: null, err: null };
  evLog.push(e);
  evById.set(id, e);
  evNew.push(e);
  return e;
}

function stepById(id) {
  return evById.get(id);
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

function drainSteps() {
  if (!evNew.length && !evEnded.length) return null;
  const out = { a: evNew.map(evRow), d: evEnded };
  evNew = [];
  evEnded = [];
  return out;
}

function stepRows(min) {
  return evLog.filter((e) => e.t >= min).map(evRow);
}

// The first read of a transcript keeps only its end; the calls before it are read backwards once, a slice per poll.

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

function histPoll(files, now) {
  let budget = HIST_SLICE;
  const cutoff = now - EV_HISTORY_MS;
  for (const f of files) {
    if (budget <= 0) return;
    if (histDone.has(f.file)) continue;
    let job = histJobs.get(f.file);
    if (!job) {
      if (statMs(f.file) < cutoff) { histDone.add(f.file); continue; }
      job = { pos: f.backFrom != null ? f.backFrom : fileSize(f.file), used: 0, carry: Buffer.alloc(0), ends: new Map(), turnEnd: 0, S: f.S, owner: f.owner };
      histJobs.set(f.file, job);
    }
    budget -= histChunk(f.file, job, f.conv, cutoff, now);
    if (job.done) {
      histJobs.delete(f.file);
      histDone.add(f.file);
    }
  }
}

function histChunk(file, job, conv, cutoff, now) {
  if (job.pos <= 0 || job.used >= HIST_PER_FILE) { job.done = true; return 0; }
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { job.done = true; return 0; }
  let chunk;
  try {
    chunk = readBack(fd, job.pos, job.carry);
  } catch (e) {
    if (!isFileError(e)) throw e;
    job.done = true;
    return 0;
  } finally {
    fs.closeSync(fd);
  }
  const n = job.pos - chunk.pos;
  job.pos = chunk.pos;
  job.used += n;
  job.carry = chunk.carry;
  if (chunk.text === null) return n;
  const lines = chunk.text.split('\n');
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
        job.ends.set(x.tool_use_id, [t, x.is_error ? 0 : 1, toolError(x)]);
      }
    }
    if (use && d.type === 'assistant') {
      for (const x of content) {
        if (!x || x.type !== 'tool_use' || evById.has(x.id)) continue;
        const end = job.ends.get(x.id) || lateEnds.get(x.id);
        lateEnds.delete(x.id);
        const input = x.input || {};
        const e = addStep(x.id, job.S, job.owner, x.name, input, describe(x.name, input), t, d.cwd);
        if (end) { e.e = end[0]; e.ok = end[1]; e.err = end[2]; }
        else if (job.turnEnd) { e.e = job.turnEnd; e.ok = 2; }
        else if (conv && conv.lastCutAt > t) { e.e = conv.lastCutAt; e.ok = 2; }
        else if (!conv || now - t > HOUR) { e.e = t; e.ok = 2; }
        else {
          const key = job.S.id + '|' + job.owner;
          if (!histOpen.has(key)) histOpen.set(key, new Set());
          histOpen.get(key).add(e);
        }
      }
    }
    if (stop && t) job.turnEnd = t;
  }
  return n;
}

module.exports = { recordStep, stepById, endStep, noteLateEnd, cutPending, cutBefore, trimSteps, drainSteps, stepRows, histPoll };
