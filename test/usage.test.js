'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const vm = require('vm');
const { dayKey } = require('../lib/days');
const { prompt, reply, result } = require('./helpers/claude-code');

const MIN = 60000;
const DAY = 864e5;
const NOON = new Date().setHours(12, 0, 0, 0);
const T = NOON - 2 * DAY;
const ROOT = path.join(__dirname, '..');

const warm = (t, o) => reply(t, Object.assign({ write: 3000, read: 200000 }, o));
const cold = (t, o) => reply(t, Object.assign({ write: 203000, read: 0 }, o));
const sleep = { tools: [['Bash', { command: 'sleep 600' }]] };

function write(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.flat().map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// the server's reply for each range once its worker has read every transcript
const CHILD = `
const fs = require('fs');
const path = require('path');
const { USAGE_INDEX, USAGE_WAITS } = require('./lib/config');
fs.mkdirSync(path.dirname(USAGE_INDEX), { recursive: true });
fs.copyFileSync(process.env.INDEX_FROM, USAGE_INDEX);
fs.copyFileSync(process.env.WAITS_FROM, USAGE_WAITS);
const usage = require('./lib/usage');
usage.start();
const until = Date.now() + 20000;
(function poll() {
  const p = usage.usageReply('all').progress;
  if (p && p.total && p.read === p.total && p.wread === p.total) {
    process.stdout.write(JSON.stringify({ all: usage.usageReply('all'), week: usage.usageReply('7d'), today: usage.usageReply('today') }));
    process.exit(0);
  }
  if (Date.now() > until) { process.stderr.write('not read: ' + JSON.stringify(p)); process.exit(1); }
  setTimeout(poll, 50);
})();
`;

function serve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const projects = path.join(dir, 'claude', 'projects', 'proj');
  write(path.join(projects, 'sid1.jsonl'), [warm(T, { ttl: '1h', stop: 'end_turn' }), prompt(T + 70 * MIN, 'next'), cold(T + 70 * MIN, { ttl: '1h', write: 500000 })]);
  write(path.join(projects, 'sid1', 'subagents', 'agent-a1.jsonl'), [warm(T, sleep), result(T + 10 * MIN, 'x'), cold(T + 10 * MIN, sleep), result(T + 20 * MIN, 'x'), cold(T + 20 * MIN)]);
  const opus9 = { model: 'claude-opus-9' };
  write(path.join(projects, 'sid2.jsonl'), [warm(T - DAY, opus9), cold(T - DAY + 10 * MIN, opus9), cold(T, { model: 'claude-opus-9', write: 100000 })]);
  write(path.join(projects, 'sid3.jsonl'), [warm(T - 20 * DAY)]);
  // deleted after their tokens were counted, with none, part or all of their waits
  const gone = (ino, sid, back) => ({ ino, size: 100, off: 100, mtime: T, wait: -1, sid, agent: false, cwd: '', title: '', tk: 0, days: { [dayKey(T - back * DAY)]: { 'claude-opus-5-5': [1, 2, 50, 0, 0] } }, hours: {}, recent: [] });
  const from = path.join(dir, 'index.json');
  fs.writeFileSync(from, JSON.stringify({ v: 1, files: { [path.join(projects, 'old.jsonl')]: gone('1:1', 'old', 10), [path.join(projects, 'part.jsonl')]: gone('1:2', 'part', 5), [path.join(projects, 'done.jsonl')]: gone('1:3', 'done', 3) } }));
  const waitsFrom = path.join(dir, 'waits.json');
  fs.writeFileSync(waitsFrom, JSON.stringify({ v: 1, files: { [path.join(projects, 'part.jsonl')]: { ino: '1:2', o: 50, s: {}, d: {} }, [path.join(projects, 'done.jsonl')]: { ino: '1:3', o: 100, s: {}, d: {} } } }));
  const env = Object.assign({}, process.env, { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), XDG_STATE_HOME: path.join(dir, 'state'), XDG_DATA_HOME: path.join(dir, 'data'), INDEX_FROM: from, WAITS_FROM: waitsFrom });
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', CHILD], { cwd: ROOT, env, timeout: 30000 }, (err, out, errOut) => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (err) reject(new Error(errOut || err.message)); else resolve(JSON.parse(out));
    });
  });
}

async function panel(data) {
  let selected = null;
  const el = () => ({ clientWidth: 440, addEventListener() {}, setAttribute() {}, querySelector() { return null; } });
  const ctx = {
    document: { getElementById: el, addEventListener() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    fetch: () => Promise.resolve({ json: () => data }),
    OV: { selected: () => selected, open(id) { selected = id; }, close() {}, repaint() {}, name: () => false },
    setTimeout: () => 0,
    clearTimeout() {},
    addEventListener() {},
  };
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'usage-ui.js'), 'utf8'), ctx);
  ctx.OVUsage.open();
  await new Promise((r) => setImmediate(r));
  return ctx.OVUsage.html();
}

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const replies = serve();

test('the server totals rewritten cache by cause and by session, and where its count starts', async () => {
  const { all, week, today } = await replies;
  const w = all.waits;
  assert.deepEqual(w.totals.map((x) => Math.round(x * 1e4) / 1e4), [5, 1209000, 5.8488, 303000]);
  assert.deepEqual(w.causes.map(([c, a]) => [c, a[0], a[1]]), [['you', 1, 500000], ['loop', 2, 406000], ['other', 2, 303000]]);
  // the main cause is the one that rewrote the most tokens
  assert.deepEqual(w.sessions.map((s) => [s.sid, s.a[0], s.cause]), [['sid1', 3, 'you'], ['sid2', 2, 'other']]);
  assert.equal(w.from, dayKey(T - 4 * DAY));
  // nothing in the week comes before the day the count starts
  assert.equal(week.waits.from, '');
  assert.equal(week.waits.totals[0], 5);
  assert.deepEqual(today.waits.totals, [0, 0, 0, 0]);
});

test('the Usage panel shows the cost of rewritten cache only for models it has a price for', async () => {
  const { all, today } = await replies;
  const t = text(await panel(all));
  assert.match(t, /Cache written again .*Counted from .*: older transcripts were deleted before this was counted/);
  assert.match(t, /5 times a reply wrote 1\.21M tokens of cache again: about \$5\.85 more than reading them, at API list prices, for 74% of them; the rest are on models with no price here/);
  assert.match(t, / Waiting for you 1 time · about \$3\.90 500k A sleep or poll loop 2 times · about \$1\.95 406k Something else 2 times 303k /);
  assert.match(t, /Top sessions · cache written again sid1 mostly waiting for you · 3 times · about \$5\.85 .* sid2 mostly something else · 2 times /);
  assert.doesNotMatch(text(await panel(today)), /written again/);
});

test('a cause or session row that holds tokens with no price shows no cost, as its dollars would cover only part of it', async () => {
  const { all } = await replies;
  const mixed = JSON.parse(JSON.stringify(all));
  mixed.waits.causes[0][1][3] = 100000;
  mixed.waits.sessions[0].a[3] = 100000;
  const t = text(await panel(mixed));
  assert.match(t, / Waiting for you 1 time 500k A sleep or poll loop 2 times · about \$1\.95 406k /);
  assert.match(t, /sid1 mostly waiting for you · 3 times /);
  assert.doesNotMatch(t, /sid1 mostly waiting for you · 3 times · about/);
});

test('while the waits are read back, the Usage panel says its count is low for now', async () => {
  const { today } = await replies;
  const behind = Object.assign({}, today, { progress: { total: 2e9, read: 2e9, wread: 1e9, pending: 0 } });
  assert.match(text(await panel(behind)), /Cache written again Still reading older transcripts for this: 1\.0 of 2\.0 GB read, so it is low for now/);
});
