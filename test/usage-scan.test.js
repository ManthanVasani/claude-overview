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
const SCANNER = fs.readFileSync(path.join(__dirname, '..', 'lib', 'usage-scan.js'), 'utf8');

function setting(name) {
  const m = new RegExp('^const ' + name + ' = (\\d+);$', 'm').exec(SCANNER);
  assert.ok(m, name + ' is not a plain number in usage-scan.js');
  return Number(m[1]);
}
// so the worker's next tick walks and reports
const NEXT_WALK = { shift: Math.max(setting('WALK_BUSY_MS'), setting('WALK_IDLE_MS'), setting('REPORT_MS')) + 1 };

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
function scan(f, fail, opts) {
  opts = opts || {};
  const before = fs.existsSync(f.waits) ? fs.statSync(f.waits).mtimeMs : 0;
  const done = opts.done || ((p) => p.read === p.total && p.wread === p.total);
  return new Promise((resolve, reject) => {
    const entry = fail ? path.join(__dirname, 'helpers', 'failing-reads.js') : path.join(__dirname, '..', 'lib', 'usage-scan.js');
    const w = new Worker(entry, { workerData: { root: f.root, index: f.index, waits: f.waits, seed: path.join(f.dir, 'no-seed.json'), fail } });
    let last = null;
    let stopped = false;
    const seen = { notices: [], reads: 0, reports: [] };
    w.on('message', (m) => {
      if (m.progress) { last = m; seen.reports.push({ reads: seen.reads, progress: m.progress }); }
      else if (m.notice) seen.notices.push(m.notice);
      else if (m.reads) { seen.reads = m.reads; if (opts.onRead) opts.onRead(w, m.reads); }
    });
    w.on('error', (e) => { stopped = true; reject(e); });
    const until = Date.now() + 20000;
    (function poll() {
      if (stopped) return;
      const p = last && last.progress;
      if (p && done(p) && fs.existsSync(f.waits) && fs.statSync(f.waits).mtimeMs > before && (!opts.ready || opts.ready(Object.assign({}, last, seen)))) w.terminate().then(() => resolve(Object.assign(last, seen)));
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

function unreadable(f) {
  const bad = path.join(f.root, 'other', 'bad.jsonl');
  write(bad, [prompt(T0, 'go'), warm(T0, { model: 'claude-bad' })]);
  return bad;
}

// the first tick reads these and reports before the bad file's turn
function ahead(f, bad) {
  const files = [];
  for (let i = 0; i < setting('SLICES_PER_TICK'); i++) {
    files.push(path.join(f.root, 'proj', 'sid' + i + '.jsonl'));
    write(files[i], [prompt(T0, 'go'), warm(T0)]);
  }
  const old = new Date(Date.now() - 864e5);
  fs.utimesSync(bad, old, old);
  return files;
}

test('a transcript that cannot be read is left out, and the rest are counted and saved', async () => {
  const f = folder();
  try {
    transcripts(f);
    const bad = unreadable(f);
    const m = await scan(f, { name: 'bad.jsonl', as: 'eio' });
    const t = tally(m);
    assert.deepEqual(t.causes, { you: 1, loop: 1 });
    assert.equal(t.tokens[0], 4);
    assert.equal(m.reads, 1);
    assert.equal(m.progress.pending, 0);
    assert.equal(m.progress.unreadable, 1);
    assert.equal(m.progress.uncounted, 1);
    assert.deepEqual(m.notices, ['Could not read ' + bad + ' for usage (EIO)']);
    assert.equal(JSON.parse(fs.readFileSync(f.index, 'utf8')).files[bad].off, 0);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript whose read fails after a report counted it as still to read is left out of the next report', async () => {
  const f = folder();
  try {
    ahead(f, unreadable(f));
    const m = await scan(f, { name: 'bad.jsonl', as: 'eio' });
    assert.ok(m.reports.some((r) => !r.reads && r.progress.pending === 1));
    assert.equal(m.reads, 1);
    assert.equal(m.progress.pending, 0);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript that still cannot be read is not counted as still to read between the next walk and its next read', async () => {
  const f = folder();
  try {
    const newer = ahead(f, unreadable(f));
    const m = await scan(f, { name: 'bad.jsonl', as: 'eio' }, {
      onRead: (w, n) => {
        if (n > 1) return;
        // so the next walk queues them ahead of the bad file again
        for (const p of newer) fs.appendFileSync(p, JSON.stringify(warm(T0 + MIN)[0]) + '\n');
        w.postMessage(NEXT_WALK);
      },
      ready: (s) => s.reads === 2,
    });
    assert.equal(tally(m).tokens[0], 2 * newer.length);
    const after = m.reports.filter((r) => r.reads);
    assert.ok(after.length);
    for (const r of after) assert.equal(r.progress.pending, 0);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript whose read failed is read again at the next walk', async () => {
  const f = folder();
  try {
    transcripts(f);
    unreadable(f);
    const m = await scan(f, { name: 'bad.jsonl', as: 'eio', once: true }, {
      onRead: (w) => w.postMessage(NEXT_WALK),
      ready: (s) => tally(s).tokens[0] === 5,
    });
    assert.equal(m.reads, 1);
    assert.equal(m.days[dayKey(T0)].m['claude-bad'][0], 1);
    assert.equal(m.progress.unreadable, 0);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript read again after a failed read is not left out, even with no replies in it', async () => {
  const f = folder();
  try {
    transcripts(f);
    write(path.join(f.root, 'other', 'bad.jsonl'), [prompt(T0, 'go')]);
    const m = await scan(f, { name: 'bad.jsonl', as: 'eio', once: true }, {
      onRead: (w) => w.postMessage(NEXT_WALK),
      ready: (s) => s.reads === 1 && s.progress.unreadable === 0,
    });
    assert.equal(m.progress.pending, 0);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript whose read failed is not left out once it has nothing to read', async () => {
  const f = folder();
  try {
    transcripts(f);
    const bad = unreadable(f);
    const m = await scan(f, { name: 'bad.jsonl', as: 'eio' }, {
      onRead: (w) => {
        fs.truncateSync(bad, 0);
        w.postMessage(NEXT_WALK);
      },
      ready: (s) => s.reads === 1 && s.progress.unreadable === 0,
    });
    assert.equal(tally(m).tokens[0], 4);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript that reads shorter than its size is taken to end where the read stopped, and is not named as unreadable', async () => {
  const f = folder();
  try {
    transcripts(f);
    const bad = unreadable(f);
    const m = await scan(f, { name: 'bad.jsonl', as: 'empty' });
    assert.equal(tally(m).tokens[0], 4);
    assert.equal(m.reads, 1);
    assert.equal(m.progress.unreadable, 0);
    assert.equal(m.progress.uncounted, 0);
    assert.deepEqual(m.notices, []);
    const saved = JSON.parse(fs.readFileSync(f.index, 'utf8')).files[bad];
    assert.deepEqual([saved.off, saved.size], [0, 0]);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript cut shorter while it is read is counted from what is left, and not named as unreadable', async () => {
  const f = folder();
  try {
    transcripts(f);
    const bad = path.join(f.root, 'other', 'bad.jsonl');
    const first = warm(T0, { model: 'claude-bad' });
    write(bad, [first, warm(T0 + MIN, { model: 'claude-bad' })]);
    const m = await scan(f, { name: 'bad.jsonl', as: 'cut', once: true, cut: Buffer.byteLength(JSON.stringify(first[0]) + '\n') });
    assert.equal(m.reads, 1);
    assert.equal(m.days[dayKey(T0)].m['claude-bad'][0], 1);
    assert.equal(m.progress.unreadable, 0);
    assert.deepEqual(m.notices, []);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript cut shorter than what was counted before it is opened is counted again from what is left', async () => {
  const f = folder();
  try {
    transcripts(f);
    const bad = path.join(f.root, 'other', 'bad.jsonl');
    const first = warm(T0, { model: 'claude-bad' });
    write(bad, [first, warm(T0 + MIN, { model: 'claude-bad' })]);
    await scan(f);
    fs.appendFileSync(bad, JSON.stringify(warm(T0 + 2 * MIN, { model: 'claude-bad' })[0]) + '\n');
    const m = await scan(f, { name: 'bad.jsonl', as: 'cut-open', once: true, cut: Buffer.byteLength(JSON.stringify(first[0]) + '\n') });
    assert.equal(m.reads, 1);
    assert.equal(m.days[dayKey(T0)].m['claude-bad'][0], 1);
    assert.equal(tally(m).tokens[0], 5);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript cut inside a line while it is read waits for the line to be finished, and is not named as unreadable', async () => {
  const f = folder();
  try {
    transcripts(f);
    const bad = path.join(f.root, 'other', 'bad.jsonl');
    write(bad, [warm(T0, { model: 'claude-bad' })]);
    const m = await scan(f, { name: 'bad.jsonl', as: 'cut', once: true, cut: 10 }, { done: (p) => p.pending === 0 });
    assert.equal(m.reads, 1);
    assert.equal(m.days[dayKey(T0)].m['claude-bad'], undefined);
    assert.equal(m.progress.unreadable, 0);
    assert.deepEqual(m.notices, []);
    const r = JSON.parse(fs.readFileSync(f.index, 'utf8')).files[bad];
    assert.deepEqual([r.off, r.size, r.wait], [0, 10, 10]);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript rewritten to its old size while it is read is read on at the next walk, and not named as unreadable', async () => {
  const f = folder();
  try {
    transcripts(f);
    const bad = path.join(f.root, 'other', 'bad.jsonl');
    const first = warm(T0, { model: 'claude-bad' });
    write(bad, [first, warm(T0 + MIN, { model: 'claude-bad' })]);
    const m = await scan(f, { name: 'bad.jsonl', as: 'regrow', once: true, cut: Buffer.byteLength(JSON.stringify(first[0]) + '\n') }, {
      onRead: (w) => w.postMessage(NEXT_WALK),
      ready: (s) => s.days[dayKey(T0)].m['claude-bad']?.[0] === 2,
    });
    assert.equal(m.reads, 1);
    assert.equal(m.days[dayKey(T0)].m['claude-bad'][0], 2);
    assert.equal(m.progress.unreadable, 0);
    assert.deepEqual(m.notices, []);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript that cannot be opened is named and left out, not taken for deleted', async () => {
  const f = folder();
  try {
    const { session } = transcripts(f);
    const bad = unreadable(f);
    await scan(f);
    fs.appendFileSync(bad, JSON.stringify(warm(T0 + MIN, { model: 'claude-bad' })[0]) + '\n');
    fs.appendFileSync(session, JSON.stringify(warm(T0 + 71 * MIN, { ttl: '1h' })[0]) + '\n');
    const m = await scan(f, { name: 'bad.jsonl', as: 'eacces' });
    assert.equal(m.reads, 1);
    assert.equal(m.days[dayKey(T0)].m['claude-bad'][0], 1);
    assert.equal(m.progress.unreadable, 1);
    assert.equal(m.progress.uncounted, 1);
    assert.deepEqual(m.notices, ['Could not read ' + bad + ' for usage (EACCES)']);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript removed before it is opened is not named as unreadable', async () => {
  const f = folder();
  try {
    transcripts(f);
    unreadable(f);
    const m = await scan(f, { name: 'bad.jsonl', as: 'enoent' });
    assert.equal(m.reads, 1);
    assert.equal(m.progress.unreadable, 0);
    assert.deepEqual(m.notices, []);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript that cannot be read again for its waits keeps its tokens and is left out of the waits count', async () => {
  const f = folder();
  try {
    const { session } = transcripts(f);
    const bad = unreadable(f);
    await scan(f);
    const saved = JSON.parse(fs.readFileSync(f.waits, 'utf8'));
    delete saved.files[bad];
    fs.writeFileSync(f.waits, JSON.stringify(saved));
    fs.appendFileSync(session, JSON.stringify(warm(T0 + 71 * MIN, { ttl: '1h' })[0]) + '\n');
    const m = await scan(f, { name: 'bad.jsonl', as: 'eio' });
    assert.equal(tally(m).tokens[0], 6);
    assert.equal(m.reads, 1);
    assert.equal(m.progress.unreadable, 1);
    assert.equal(m.progress.uncounted, 0);
    assert.deepEqual(m.notices, ['Could not read ' + bad + ' for usage (EIO)']);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript found empty while it is read again for its waits is counted again from the start in the next report', async () => {
  const f = folder();
  try {
    const bad = unreadable(f);
    const newer = ahead(f, bad);
    await scan(f);
    const saved = JSON.parse(fs.readFileSync(f.waits, 'utf8'));
    delete saved.files[bad];
    fs.writeFileSync(f.waits, JSON.stringify(saved));
    // so the first tick reports before the bad file's turn
    for (const p of newer) fs.appendFileSync(p, JSON.stringify(warm(T0 + MIN)[0]) + '\n');
    const m = await scan(f, { name: 'bad.jsonl', as: 'empty' });
    assert.equal(tally(m).tokens[0], 2 * newer.length);
    assert.equal(m.days[dayKey(T0)].m['claude-bad'], undefined);
    assert.equal(m.reads, 1);
    assert.equal(m.progress.unreadable, 0);
    assert.deepEqual(m.notices, []);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript cut shorter while it is read again for its waits is counted again from what is left', async () => {
  const f = folder();
  try {
    transcripts(f);
    const bad = path.join(f.root, 'other', 'bad.jsonl');
    const first = warm(T0, { model: 'claude-bad' });
    write(bad, [first, warm(T0 + MIN, { model: 'claude-bad' })]);
    await scan(f);
    const saved = JSON.parse(fs.readFileSync(f.waits, 'utf8'));
    delete saved.files[bad];
    fs.writeFileSync(f.waits, JSON.stringify(saved));
    const m = await scan(f, { name: 'bad.jsonl', as: 'cut', once: true, cut: Buffer.byteLength(JSON.stringify(first[0]) + '\n') });
    assert.equal(m.days[dayKey(T0)].m['claude-bad'][0], 1);
    assert.equal(tally(m).tokens[0], 5);
    assert.equal(m.reads, 1);
    assert.deepEqual(m.notices, []);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a transcript emptied before its waits were read is counted again from the start and saved, and read again when written back', async () => {
  const f = folder();
  try {
    transcripts(f);
    const bad = path.join(f.root, 'other', 'bad.jsonl');
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    // an unfinished last line, so the file waits at its size
    const text = JSON.stringify(warm(T0, { model: 'claude-bad' })[0]) + '\n{"type":"assistant"';
    fs.writeFileSync(bad, text);
    const pending = { done: (p) => p.pending === 0 };
    await scan(f, null, pending);
    const saved = JSON.parse(fs.readFileSync(f.waits, 'utf8'));
    delete saved.files[bad];
    fs.writeFileSync(f.waits, JSON.stringify(saved));
    fs.truncateSync(bad, 0);
    const m = await scan(f);
    assert.equal(m.days[dayKey(T0)].m['claude-bad'], undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.index, 'utf8')).files[bad].days, {});
    fs.writeFileSync(bad, text);
    const back = await scan(f, null, pending);
    assert.equal(back.days[dayKey(T0)].m['claude-bad'][0], 1);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a read that returns part of what was asked goes on reading', async () => {
  const f = folder();
  try {
    transcripts(f);
    unreadable(f);
    const m = await scan(f, { name: 'bad.jsonl', as: 'half' });
    assert.equal(tally(m).tokens[0], 5);
    assert.ok(m.reads > 1);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('an error in a read that is not a file error stops the scan', async () => {
  const f = folder();
  try {
    transcripts(f);
    unreadable(f);
    await assert.rejects(scan(f, { name: 'bad.jsonl', as: 'bug' }), /out of range/);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
