'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { Worker } = require('worker_threads');
const { dayKey, hourKey } = require('../lib/days');
const { prompt, reply, result } = require('./helpers/claude-code');

const MIN = 60000;
const T0 = Date.parse('2026-11-04T10:00:00Z');
const V1_KEYS = ['agent', 'alias', 'cwd', 'days', 'gone', 'hours', 'ino', 'mtime', 'off', 'recent', 'sid', 'size', 'title', 'tk', 'wait'];

const warm = (t, o) => reply(t, Object.assign({ write: 3000, read: 200000 }, o));
const cold = (t, o) => reply(t, Object.assign({ write: 203000, read: 0 }, o));

function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-scan-'));
  const state = path.join(dir, 'state');
  return { dir, root: path.join(dir, 'projects'), index: path.join(state, 'usage-index-x.json'), waits: path.join(state, 'usage-waits-x.json') };
}

function write(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.flat().map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function transcripts(f) {
  const session = path.join(f.root, 'proj', 'sid1.jsonl');
  const agent = path.join(f.root, 'proj', 'sid1', 'subagents', 'agent-a1.jsonl');
  write(session, [warm(T0, { ttl: '1h', stop: 'end_turn' }), prompt(T0 + 70 * MIN, 'next'), cold(T0 + 70 * MIN, { ttl: '1h' })]);
  write(agent, [warm(T0, { tools: [['Bash', { command: 'sleep 600' }]] }), result(T0 + 10 * MIN, 'x'), cold(T0 + 10 * MIN)]);
  return { session, agent };
}

// the waits file is written once the first pass is done
function scan(f) {
  const before = fs.existsSync(f.waits) ? fs.statSync(f.waits).mtimeMs : 0;
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, '..', 'lib', 'usage-scan.js'), { workerData: { root: f.root, index: f.index, waits: f.waits, seed: path.join(f.dir, 'no-seed.json') } });
    let last = null;
    w.on('message', (m) => { if (m.progress) last = m; });
    w.on('error', reject);
    const until = Date.now() + 20000;
    (function poll() {
      const p = last && last.progress;
      if (p && p.read === p.total && p.wread === p.total && fs.existsSync(f.waits) && fs.statSync(f.waits).mtimeMs > before) w.terminate().then(() => resolve(last));
      else if (Date.now() > until) w.terminate().then(() => reject(new Error('the scan did not finish: ' + JSON.stringify(last && last.progress))));
      else setTimeout(poll, 50);
    })();
  });
}

function tally(m) {
  const causes = {};
  const sessions = {};
  const tokens = [0, 0, 0, 0, 0];
  for (const day in m.days) {
    const D = m.days[day];
    for (const c in D.w) causes[c] = (causes[c] || 0) + D.w[c][0];
    for (const sid in D.ws) for (const c in D.ws[sid]) sessions[sid + ' ' + c] = (sessions[sid + ' ' + c] || 0) + D.ws[sid][c][0];
    for (const model in D.m) D.m[model].forEach((v, i) => { tokens[i] += v; });
  }
  return { causes, sessions, tokens };
}

test('a session and its agents are read for their waits, kept apart from the index an older server reads', async () => {
  const f = folder();
  try {
    const { session, agent } = transcripts(f);
    const m = await scan(f);
    const t = tally(m);
    assert.deepEqual(t.causes, { you: 1, loop: 1 });
    assert.deepEqual(t.sessions, { 'sid1 you': 1, 'sid1 loop': 1 });
    assert.equal(t.tokens[0], 4);
    const index = JSON.parse(fs.readFileSync(f.index, 'utf8'));
    for (const p in index.files) assert.deepEqual(Object.keys(index.files[p]).sort(), V1_KEYS, p);
    const saved = JSON.parse(fs.readFileSync(f.waits, 'utf8'));
    assert.deepEqual(Object.keys(saved.files).sort(), [agent, session].sort());
    for (const p in saved.files) assert.equal(saved.files[p].o, fs.statSync(p).size);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('totals saved before waits were counted are read again for waits only', async () => {
  const f = folder();
  try {
    transcripts(f);
    const first = tally(await scan(f));
    fs.unlinkSync(f.waits);
    // as saved for a transcript idle for an hour, which keeps no ids to tell a line already counted
    const index = JSON.parse(fs.readFileSync(f.index, 'utf8'));
    for (const p in index.files) index.files[p].recent = [];
    fs.writeFileSync(f.index, JSON.stringify(index));
    const again = tally(await scan(f));
    assert.deepEqual(again, first);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('waits are counted again from the start when the index started a file again', async () => {
  const f = folder();
  try {
    const { agent } = transcripts(f);
    const first = tally(await scan(f));
    const index = JSON.parse(fs.readFileSync(f.index, 'utf8'));
    Object.assign(index.files[agent], { off: 0, days: {}, hours: {}, recent: [] });
    fs.writeFileSync(f.index, JSON.stringify(index));
    assert.deepEqual(tally(await scan(f)), first);
    // the waits of a file that was at this path before
    const saved = JSON.parse(fs.readFileSync(f.waits, 'utf8'));
    Object.assign(saved.files[agent], { ino: 'gone', d: {} });
    fs.writeFileSync(f.waits, JSON.stringify(saved));
    assert.deepEqual(tally(await scan(f)), first);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('saved waits are read back, not counted again, and a stale temporary file of a waits save is removed', async () => {
  const f = folder();
  try {
    const { session } = transcripts(f);
    await scan(f);
    const saved = JSON.parse(fs.readFileSync(f.waits, 'utf8'));
    const day = Object.keys(saved.files[session].d)[0];
    saved.files[session].d[day].you['claude-opus-5-5 long'][0] = 7;
    fs.writeFileSync(f.waits, JSON.stringify(saved));
    const left = f.waits + '.999.tmp';
    fs.writeFileSync(left, '{');
    fs.utimesSync(left, new Date(Date.now() - 2 * 3600000), new Date(Date.now() - 2 * 3600000));
    fs.appendFileSync(session, JSON.stringify(warm(T0 + 71 * MIN, { ttl: '1h' })[0]) + '\n');
    assert.equal(tally(await scan(f)).causes.you, 7);
    assert.equal(fs.existsSync(left), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('the waits of an earlier file at a deleted path are not added to it', async () => {
  const f = folder();
  try {
    const { session } = transcripts(f);
    await scan(f);
    const gone = path.join(f.root, 'proj', 'gone.jsonl');
    const index = JSON.parse(fs.readFileSync(f.index, 'utf8'));
    index.files[gone] = Object.assign({}, index.files[session], { ino: '1:1', sid: 'gone' });
    fs.writeFileSync(f.index, JSON.stringify(index));
    const saved = JSON.parse(fs.readFileSync(f.waits, 'utf8'));
    saved.files[gone] = Object.assign({}, saved.files[session], { ino: '1:2' });
    fs.writeFileSync(f.waits, JSON.stringify(saved));
    fs.appendFileSync(session, JSON.stringify(warm(T0 + 71 * MIN, { ttl: '1h' })[0]) + '\n');
    assert.deepEqual(tally(await scan(f)).sessions, { 'sid1 you': 1, 'sid1 loop': 1 });
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript deleted before its waits were read keeps its tokens by day and by hour, and moves where waits start', async () => {
  const f = folder();
  try {
    transcripts(f);
    const now = Date.now();
    const a = [1, 2, 50, 0, 0];
    const gone = { ino: '1:1', size: 100, off: 100, mtime: now, wait: -1, sid: 'gone', agent: false, cwd: '', title: '', tk: 0, days: { [dayKey(now)]: { 'claude-test': a } }, hours: { [hourKey(now)]: { 'claude-test': a } }, recent: [] };
    fs.mkdirSync(path.dirname(f.index), { recursive: true });
    fs.writeFileSync(f.index, JSON.stringify({ v: 1, files: { [path.join(f.root, 'proj', 'gone.jsonl')]: gone } }));
    const m = await scan(f);
    assert.deepEqual(m.days[dayKey(now)].m['claude-test'], a);
    assert.deepEqual(m.hours[hourKey(now)]['claude-test'], a);
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    assert.equal(m.waitsFrom, dayKey(next));
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('reading back for waits reports its progress to the end, past the part of it with no rewrites', async () => {
  const f = folder();
  try {
    // longer than one tick reads
    const big = path.join(f.root, 'proj', 'big.jsonl');
    fs.mkdirSync(path.dirname(big), { recursive: true });
    const pad = JSON.stringify({ type: 'progress', pad: 'x'.repeat(1000) }) + '\n';
    fs.writeFileSync(big, pad.repeat(34000));
    const st = fs.statSync(big);
    const done = { ino: st.dev + ':' + st.ino, size: st.size, off: st.size, mtime: st.mtimeMs, wait: -1, sid: 'big', agent: false, cwd: '', title: '', tk: 0, days: {}, hours: {}, recent: [] };
    fs.mkdirSync(path.dirname(f.index), { recursive: true });
    fs.writeFileSync(f.index, JSON.stringify({ v: 1, files: { [big]: done } }));
    const p = (await scan(f)).progress;
    assert.equal(p.wread, st.size);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
