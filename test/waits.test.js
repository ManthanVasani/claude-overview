'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const waits = require('../lib/waits');
const { prompt, reply, result, notification } = require('./helpers/claude-code');

const T0 = Date.parse('2026-11-04T10:00:00Z');
const MIN = 60000;

// feeds lines the way the usage scanner reads them: only a line that can hold usage is parsed
function feed(entries, agent) {
  const s = waits.newState();
  const out = [];
  for (const e of entries.flat()) {
    const text = typeof e === 'string' ? e : JSON.stringify(e);
    const d = text.indexOf('"usage"') >= 0 && text.indexOf('"assistant"') >= 0 ? JSON.parse(text) : null;
    const m = waits.line(s, text, d, !!agent);
    if (m) out.push(m);
  }
  return out;
}

const warm = (t, o) => reply(t, Object.assign({ write: 3000, read: 200000 }, o));
const cold = (t, o) => reply(t, Object.assign({ write: 203000, read: 0 }, o));
const account = (t, org) => ({ type: 'attachment', timestamp: new Date(t).toISOString(), attachment: { type: 'credential_org', organizationUuid: org || 'org-1' } });
const decided = (t, source, inner) => Object.assign(result(t, 'x', inner || { stdout: '' }), { permissionDecision: { decision: 'accept', source } });

test('a call after a wait longer than the cache lasts, which writes the whole prompt again, counts once', () => {
  const misses = feed([warm(T0, { tools: [['Bash', { command: 'sleep 600 && make check' }]] }), result(T0 + 10 * MIN, 'x'), cold(T0 + 10 * MIN)]);
  assert.equal(misses.length, 1);
  assert.deepEqual(misses[0], { t: T0 + 10 * MIN, cause: 'loop', key: 'claude-opus-5-5 long', short: 203000, long: 0 });
});

test('a wait shorter than the cache lasts, a small write, or a write of under half the prompt is not counted', () => {
  assert.equal(feed([warm(T0), cold(T0 + 4.9 * MIN)]).length, 0);
  assert.equal(feed([warm(T0), cold(T0 + 6 * MIN, { write: 19999 })]).length, 0);
  assert.equal(feed([warm(T0), cold(T0 + 6 * MIN, { write: 100000, read: 100001 })]).length, 0);
  assert.equal(feed([warm(T0), cold(T0 + 6 * MIN, { write: 100000, read: 99998 })]).length, 1);
});

test('the cache lifetime comes from the last call that wrote to it', () => {
  assert.equal(feed([warm(T0, { ttl: '1h' }), cold(T0 + 59 * MIN, { ttl: '1h' })]).length, 0);
  assert.equal(feed([warm(T0, { ttl: '1h' }), cold(T0 + 61 * MIN, { ttl: '1h' })]).length, 1);
  assert.equal(feed([warm(T0, { ttl: '1h' }), warm(T0 + MIN, { write: 0 }), cold(T0 + 30 * MIN)]).length, 0);
  // a call that only read the cache keeps the lifetime it was written with
  assert.equal(feed([warm(T0, { ttl: '1h' }), warm(T0 + MIN, { write: 0 }), cold(T0 + 62 * MIN)]).length, 1);
  assert.equal(feed([warm(T0, { ttl: 'none' }), cold(T0 + 10 * MIN, { ttl: 'none' })]).length, 0);
});

test('a new model, or the first call after a compaction, starts a new cache and is not counted', () => {
  assert.equal(feed([warm(T0), cold(T0 + 10 * MIN, { model: 'claude-sonnet-5-5' })]).length, 0);
  const boundary = { type: 'system', subtype: 'compact_boundary', timestamp: new Date(T0 + 9 * MIN).toISOString(), compactMetadata: { trigger: 'auto' } };
  assert.equal(feed([warm(T0), boundary, cold(T0 + 10 * MIN)]).length, 0);
  assert.equal(feed([warm(T0), boundary, cold(T0 + 10 * MIN), cold(T0 + 20 * MIN)]).length, 1);
  // Claude Code writes some messages of its own, such as an API error, as a reply
  assert.equal(feed([warm(T0), reply(T0 + 2 * MIN, { model: '<synthetic>' }), cold(T0 + 10 * MIN)]).length, 1);
});

test('the lines of one reply count as one call, and its slowest kind of wait is the cause', () => {
  const r = warm(T0, { tools: [['Agent', { prompt: 'look' }], ['Bash', { command: 'sleep 300' }], ['Read', { file_path: '/x' }]] });
  assert.equal(r.length, 3);
  const misses = feed([r, cold(T0 + 10 * MIN)]);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].cause, 'agents');
  assert.equal(feed([warm(T0, { tools: [['Bash', { command: 'make' }], ['AskUserQuestion', {}]] }), cold(T0 + 10 * MIN)])[0].cause, 'you');
  assert.equal(feed([warm(T0, { tools: [['Bash', { command: 'npm test' }]] }), cold(T0 + 10 * MIN)])[0].cause, 'command');
  assert.equal(feed([warm(T0, { tools: [['TaskOutput', { task_id: 'b1' }]] }), cold(T0 + 10 * MIN)])[0].cause, 'background');
  const both = { tools: [['Bash', { command: 'until test -f x; do sleep 5; done', run_in_background: true }], ['Bash', { command: 'npm test' }]] };
  assert.equal(feed([warm(T0, both), cold(T0 + 10 * MIN)])[0].cause, 'command');
});

test('a command that sleeps or waits until something is a poll loop, and a script that only loops is a long command', () => {
  const cause = (command) => feed([warm(T0, { tools: [['Bash', { command }]] }), cold(T0 + 10 * MIN)])[0].cause;
  assert.equal(cause('until [ -f done ]; do ssh box check; done'), 'loop');
  assert.equal(cause('while true; do sleep 30; done'), 'loop');
  assert.equal(cause("python3 - <<'EOF'\nwhile todo:\n    run(todo.pop())\nEOF"), 'command');
});

test('with nothing running in the foreground, what woke the next call is the cause', () => {
  const bg = { tools: [['Bash', { command: 'sleep 900', run_in_background: true }]] };
  assert.equal(feed([warm(T0, bg), result(T0 + 1000, 'x'), warm(T0 + 2000, { stop: 'end_turn' }), notification(T0 + 15 * MIN, 'b1'), cold(T0 + 15 * MIN)])[0].cause, 'background');
  assert.equal(feed([warm(T0, { stop: 'end_turn' }), prompt(T0 + 20 * MIN, 'next'), cold(T0 + 20 * MIN)])[0].cause, 'you');
  assert.equal(feed([warm(T0, { stop: 'end_turn' }), prompt(T0 + 20 * MIN, 'next'), cold(T0 + 20 * MIN)], true)[0].cause, 'resumed');
  assert.equal(feed([warm(T0, { stop: 'end_turn' }), notification(T0 + 15 * MIN, 'b1'), prompt(T0 + 16 * MIN, 'next'), cold(T0 + 16 * MIN)])[0].cause, 'background');
  assert.equal(feed([warm(T0, { stop: 'end_turn' }), prompt(T0 + 15 * MIN, 'next'), notification(T0 + 16 * MIN, 'b1'), cold(T0 + 16 * MIN)])[0].cause, 'you');
  const meta = Object.assign(prompt(T0 + 19 * MIN, 'a reminder'), { isMeta: true });
  assert.equal(feed([warm(T0, { stop: 'end_turn' }), meta, cold(T0 + 20 * MIN)])[0].cause, 'other');
  // a command's output can quote a notification
  const quoting = result(T0 + 19 * MIN, 'x', null, '<task-notification> from a log');
  assert.equal(feed([warm(T0, { stop: 'end_turn' }), quoting, cold(T0 + 20 * MIN)])[0].cause, 'other');
});

test('an agent transcript is read whole, while side-chain lines in a session transcript are skipped', () => {
  const side = (lines) => lines.map((l) => Object.assign({}, l, { isSidechain: true }));
  assert.equal(feed([side(warm(T0)), side(cold(T0 + 10 * MIN))], true).length, 1);
  assert.equal(feed([side(warm(T0)), side(cold(T0 + 10 * MIN))], false).length, 0);
  assert.equal(feed([warm(T0), side(warm(T0 + 5.5 * MIN)), cold(T0 + 6 * MIN)]).length, 1);
});

test('a rewrite is kept as its model, its speed and prompt size, and its tokens by cache lifetime', () => {
  const miss = (o, gap) => feed([warm(T0, Object.assign({ ttl: '5m' }, o, { speed: undefined })), cold(T0 + (gap || 10) * MIN, o)])[0];
  assert.deepEqual([miss({ ttl: '1h' }, 61).short, miss({ ttl: '1h' }, 61).long], [0, 203000]);
  assert.equal(miss({ speed: 'fast' }).key, 'claude-opus-5-5 fast long');
  assert.equal(feed([warm(T0, { write: 3000, read: 20000 }), cold(T0 + 10 * MIN, { write: 23000 })])[0].key, 'claude-opus-5-5');
  // a reply with no split of its write keeps the lifetime the last split said
  const old = feed([warm(T0, { ttl: '1h' }), cold(T0 + 61 * MIN, { ttl: 'none' })])[0];
  assert.deepEqual([old.short, old.long], [0, 203000]);
});

test('the extra cost is the write price over the read price, at the prices for the model', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' vs ' + b);
  near(waits.cost('claude-opus-5-5 long', 203000, 0), 203000 * (1.25 - 0.05) * 4 / 1e6);
  near(waits.cost('claude-opus-5-5 long', 0, 203000), 203000 * (2 - 0.05) * 4 / 1e6);
  near(waits.cost('claude-opus-5-5 fast long', 203000, 0), 203000 * (1.25 - 0.05) * 8 / 1e6);
  near(waits.cost('claude-sonnet-5-5 long', 203000, 0), 203000 * (1.25 - 0.1) * 2 / 1e6);
  // Haiku 5.5 costs five times as much past 100k tokens of prompt
  near(waits.cost('claude-haiku-5-5 long', 203000, 0), 203000 * (1.25 - 0.1) * 0.5 / 1e6);
  near(waits.cost('claude-haiku-5-5', 50000, 0), 50000 * (1.25 - 0.1) * 0.1 / 1e6);
  assert.equal(waits.cost('claude-opus-9 long', 203000, 0), null);
});

test('each priced model is matched by its own row, and a newer one is left unpriced', () => {
  const per = (m) => { const c = waits.cost(m, 1e6, 0); return c == null ? null : Math.round(c * 1000) / 1000; };
  assert.equal(per('claude-opus-5-5'), 4.8);
  assert.equal(per('claude-opus-5-5[1m]'), 4.8);
  assert.equal(per('claude-opus-5'), 5.75);
  assert.equal(per('claude-opus-4-8'), 5.75);
  assert.equal(per('claude-sonnet-5'), 2.3);
  assert.equal(per('claude-sonnet-5-5'), 2.3);
  assert.equal(per('claude-haiku-5-5'), 0.115);
  assert.equal(per('claude-haiku-5-5-20261001'), 0.115);
  assert.equal(per('claude-fable-5-1'), 12.25);
  assert.equal(per('claude-fable-5'), 11.5);
  for (const m of ['claude-opus-5-7', 'claude-sonnet-5-8', 'claude-fable-5-2', 'claude-haiku-4-5-20251001', 'claude-opus-4-7', 'us.anthropic.claude-opus-5-5']) assert.equal(per(m), null, m);
});

test('a rewrite after an account switch is counted at any wait, before what it waited on', () => {
  assert.deepEqual(feed([warm(T0), account(T0 + 30000), cold(T0 + MIN)]).map((m) => m.cause), ['account']);
  assert.deepEqual(feed([warm(T0, { tools: [['Bash', { command: 'sleep 600' }]] }), account(T0 + MIN), cold(T0 + 10 * MIN)]).map((m) => m.cause), ['account']);
  assert.equal(feed([warm(T0), account(T0 + 30000), warm(T0 + MIN)]).length, 0);
  // the session's own first sign-in comes before its first call
  assert.equal(feed([account(T0 - 1000), warm(T0), cold(T0 + MIN)]).length, 0);
  assert.equal(feed([warm(T0), account(T0 + 30000), warm(T0 + MIN), cold(T0 + 2 * MIN)]).length, 0);
});

test('a call that waited on a permission prompt was waiting on you', () => {
  const run = (source, inner) => feed([warm(T0, { tools: [['Bash', { command: 'npm test' }]] }), decided(T0 + 9 * MIN, source, inner), cold(T0 + 10 * MIN)])[0].cause;
  assert.equal(run('user_temporary'), 'you');
  assert.equal(run('user_reject'), 'you');
  assert.equal(run('user_permanent'), 'command');
  assert.equal(run('config'), 'command');
  // the call's own decision comes after its result, which can hold another
  assert.equal(run('config', { permissionDecision: { decision: 'reject', source: 'user_reject' } }), 'command');
  // a result that holds usage is parsed
  const agent = feed([warm(T0, { tools: [['Agent', { prompt: 'look' }]] }), decided(T0 + 9 * MIN, 'user_temporary', { usage: { input_tokens: 1 }, role: 'assistant' }), cold(T0 + 10 * MIN)]);
  assert.equal(agent[0].cause, 'you');
});
