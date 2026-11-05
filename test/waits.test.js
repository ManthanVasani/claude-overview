'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const waits = require('../lib/waits');
const { prompt, reply, result, notification } = require('./helpers/claude-code');

const T0 = Date.parse('2026-11-04T10:00:00Z');
const MIN = 60000;

// parses a line only when the usage scanner would
function feed(entries, agent, s = waits.newState()) {
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
  assert.equal(feed([warm(T0, { stop: 'end_turn' }), meta, cold(T0 + 20 * MIN)], true)[0].cause, 'other');
  const sent = Object.assign(prompt(T0 + 19 * MIN, 'go on'), { isMeta: true, origin: { kind: 'coordinator' } });
  assert.equal(feed([warm(T0, { stop: 'end_turn' }), sent, cold(T0 + 20 * MIN)], true)[0].cause, 'resumed');
  assert.equal(feed([warm(T0, { stop: 'end_turn' }), sent, cold(T0 + 20 * MIN)])[0].cause, 'other');
  // a command's output can quote a notification
  const quoting = result(T0 + 19 * MIN, 'x', null, '<task-notification> from a log');
  assert.equal(feed([warm(T0, { stop: 'end_turn' }), quoting, cold(T0 + 20 * MIN)])[0].cause, 'other');
});

test('a tool that came back while the cache was still warm is not what the next call waited on', () => {
  const npm = { tools: [['Bash', { command: 'npm test' }]] };
  assert.equal(feed([warm(T0, npm), result(T0 + 30000, 'x'), cold(T0 + 10 * MIN)])[0].cause, 'other');
  assert.equal(feed([warm(T0, npm), result(T0 + 5 * MIN - 1, 'x'), cold(T0 + 10 * MIN)])[0].cause, 'other');
  assert.equal(feed([warm(T0, npm), result(T0 + 5 * MIN, 'x'), cold(T0 + 10 * MIN)])[0].cause, 'command');
  const stopped = [warm(T0, Object.assign({ ttl: '1h' }, npm)), result(T0 + MIN, 'x', null, 'interrupted'), prompt(T0 + 70 * MIN, 'next')];
  assert.equal(feed([...stopped, cold(T0 + 70 * MIN, { ttl: '1h' })])[0].cause, 'you');
  assert.equal(feed([warm(T0, npm), result(T0 + 1000, 'x'), warm(T0 + 2000, npm), cold(T0 + 10 * MIN)])[0].cause, 'command');
  // of calls made together, the last to come back decides
  const two = { tools: [['Bash', { command: 'ls' }], ['Bash', { command: 'npm test' }]] };
  assert.equal(feed([warm(T0, two), result(T0 + 1000, 'a'), result(T0 + 9 * MIN, 'b'), cold(T0 + 9 * MIN)])[0].cause, 'command');
  assert.equal(feed([warm(T0, two), result(T0 + 9 * MIN, 'b'), result(T0 + 1000, 'a'), cold(T0 + 9 * MIN)])[0].cause, 'command');
  const at = (t) => new Date(t).toISOString();
  const real = '{"parentUuid":"p","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]},"uuid":"u","timestamp":"' + at(T0 + 30000) + '","toolUseResult":{"task":{"timestamp":"' + at(T0 + 9 * MIN) + '"}}}';
  assert.equal(feed([warm(T0, npm), real, cold(T0 + 10 * MIN)])[0].cause, 'other');
});

test('only a line the call received is a result or a wake, not a request body, a queue or an attachment that quotes one', () => {
  const at = (t) => new Date(t).toISOString();
  const tag = '<task-notification>\n<task-id>b1</task-id>\n</task-notification>';
  const queued = { type: 'queue-operation', operation: 'enqueue', timestamp: at(T0 + 10 * MIN), content: tag };
  const attached = { parentUuid: 'p', attachment: { type: 'queued_command', prompt: tag }, type: 'attachment', timestamp: at(T0 + 10 * MIN) };
  for (const l of [queued, attached]) assert.equal(feed([warm(T0, { stop: 'end_turn' }), l, prompt(T0 + 20 * MIN, 'next'), cold(T0 + 20 * MIN)])[0].cause, 'you');
  const body = { type: 'api-request-blob', timestamp: at(T0 + 30000), body: { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }] } };
  assert.equal(feed([warm(T0, { tools: [['Bash', { command: 'npm test' }]] }), body, cold(T0 + 10 * MIN)])[0].cause, 'command');
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
  near(waits.cost('claude-haiku-5-5 long', 203000, 0), 203000 * (1.25 - 0.1) * 0.5 / 1e6);
  near(waits.cost('claude-haiku-5-5', 50000, 0), 50000 * (1.25 - 0.1) * 0.1 / 1e6);
  assert.equal(waits.cost('claude-opus-9 long', 203000, 0), null);
});

test('each priced model is matched by its own row, and any other id is left unpriced', () => {
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

test('a rewrite after an account switch is put down to it while the cache was still warm, and to the wait after that', () => {
  assert.deepEqual(feed([warm(T0), account(T0 + 30000), cold(T0 + MIN)]).map((m) => m.cause), ['account']);
  const sleep = { tools: [['Bash', { command: 'sleep 600' }]] };
  assert.deepEqual(feed([warm(T0, sleep), account(T0 + MIN), cold(T0 + 5 * MIN - 1)]).map((m) => m.cause), ['account']);
  assert.deepEqual(feed([warm(T0, sleep), account(T0 + MIN), cold(T0 + 5 * MIN)]).map((m) => m.cause), ['loop']);
  assert.deepEqual(feed([warm(T0, { ttl: '1h' }), account(T0 + MIN), prompt(T0 + 2 * 60 * MIN, 'next'), cold(T0 + 2 * 60 * MIN, { ttl: '1h' })]).map((m) => m.cause), ['you']);
  assert.equal(feed([warm(T0), account(T0 + 30000), warm(T0 + MIN)]).length, 0);
  // the session's own first sign-in comes before its first call
  assert.equal(feed([account(T0 - 1000), warm(T0), cold(T0 + MIN)]).length, 0);
  assert.equal(feed([warm(T0), account(T0 + 30000), warm(T0 + MIN), cold(T0 + 2 * MIN)]).length, 0);
});

test('a call that waited on a permission prompt was waiting on you', () => {
  const run = (source, inner) => feed([warm(T0, { tools: [['Bash', { command: 'npm test' }]] }), decided(T0 + 9 * MIN, source, inner), cold(T0 + 10 * MIN)])[0].cause;
  assert.equal(run('user_temporary'), 'you');
  // a prompt answered while the cache was still warm did not keep the call waiting
  const early = feed([warm(T0, { tools: [['AskUserQuestion', { questions: [] }]] }), decided(T0 + MIN, 'user_temporary'), cold(T0 + 10 * MIN)]);
  assert.equal(early[0].cause, 'other');
  assert.equal(run('user_reject'), 'you');
  const denied = Object.assign(result(T0 + 9 * MIN, 'x', { stdout: '' }), { permissionDecision: { decision: 'reject', source: 'user_reject', reasonType: 'rule' } });
  assert.equal(feed([warm(T0, { tools: [['Bash', { command: 'npm test' }]] }), denied, cold(T0 + 10 * MIN)])[0].cause, 'command');
  assert.equal(run('user_permanent'), 'command');
  assert.equal(run('config'), 'command');
  // the call's own decision comes after its result, which can hold another
  assert.equal(run('config', { permissionDecision: { decision: 'reject', source: 'user_reject' } }), 'command');
  // a result that holds usage is parsed
  const agent = feed([warm(T0, { tools: [['Agent', { prompt: 'look' }]] }), decided(T0 + 9 * MIN, 'user_temporary', { usage: { input_tokens: 1 }, role: 'assistant' }), cold(T0 + 10 * MIN)]);
  assert.equal(agent[0].cause, 'you');
});

test('an agent whose call to start background agents comes back only after the cache has run out was waiting on its agents', () => {
  const at = (t) => new Date(t).toISOString();
  const start = { tools: [['Agent', { prompt: 'look', run_in_background: true }, 'a1']] };
  const handback = { type: 'attachment', timestamp: at(T0 + 12 * MIN), attachment: { type: 'queued_command', prompt: 'found it', isMeta: true, origin: { kind: 'peer', handback: true } } };
  assert.equal(feed([warm(T0, start), result(T0 + 12 * MIN, 'a1'), handback, cold(T0 + 12 * MIN + 2000)], true)[0].cause, 'agents');
  const task = { tools: [['Task', { prompt: 'look', run_in_background: true }, 'a1']] };
  assert.equal(feed([warm(T0, task), result(T0 + 12 * MIN, 'a1'), cold(T0 + 12 * MIN + 2000)], true)[0].cause, 'agents');
  const quoted = { tools: [['Agent', { prompt: 'look', run_in_background: 'true' }, 'a1']] };
  assert.equal(feed([warm(T0, quoted), result(T0 + 12 * MIN, 'a1'), cold(T0 + 12 * MIN + 2000)], true)[0].cause, 'agents');
  // a person's answer on a call made beside it ranks above the agents
  const asked = { tools: [['Agent', { prompt: 'look', run_in_background: true }, 'a1'], ['AskUserQuestion', { questions: [] }]] };
  assert.equal(feed([warm(T0, asked), decided(T0 + 11 * MIN, 'user_temporary'), result(T0 + 12 * MIN, 'a1'), cold(T0 + 13 * MIN)], true)[0].cause, 'you');
  assert.equal(feed([warm(T0, start), result(T0 + 1000, 'a1'), notification(T0 + 15 * MIN, 'b1'), cold(T0 + 15 * MIN)])[0].cause, 'background');
  const both = { tools: [['Agent', { prompt: 'look', run_in_background: true }, 'a1'], ['Bash', { command: 'npm test' }, 'c1']] };
  assert.equal(feed([warm(T0, both), result(T0 + 1000, 'a1'), result(T0 + 9 * MIN, 'c1'), cold(T0 + 9 * MIN)], true)[0].cause, 'command');
  assert.equal(feed([warm(T0, both), result(T0 + 1000, 'c1'), result(T0 + 9 * MIN, 'a1'), cold(T0 + 9 * MIN)], true)[0].cause, 'agents');
  // a session starts the agent in the background
  assert.equal(feed([warm(T0, both), result(T0 + 9 * MIN, 'c1'), result(T0 + 9 * MIN + 50, 'a1'), cold(T0 + 10 * MIN)])[0].cause, 'command');
  const shell = { tools: [['Bash', { command: 'npm test', run_in_background: true }, 'a1']] };
  assert.equal(feed([warm(T0, shell), result(T0 + 12 * MIN, 'a1'), cold(T0 + 12 * MIN + 2000)], true)[0].cause, 'other');
  const hour = Object.assign({ ttl: '1h' }, start);
  assert.equal(feed([warm(T0, hour), result(T0 + 30 * MIN, 'a1'), cold(T0 + 70 * MIN, { ttl: '1h' })], true)[0].cause, 'other');
  assert.equal(feed([warm(T0, hour), result(T0 + 60 * MIN, 'a1'), cold(T0 + 61 * MIN, { ttl: '1h' })], true)[0].cause, 'agents');
  // a background agent an earlier call started does not hold up the next one
  const next = [warm(T0, start), result(T0 + 1000, 'a1'), warm(T0 + 2000), result(T0 + 12 * MIN, 'a1'), cold(T0 + 12 * MIN + 2000)];
  assert.equal(feed(next, true)[0].cause, 'other');
});

test('a waits state an older server saved is read on', () => {
  const older = (o) => {
    const s = Object.assign(waits.newState(), { id: 'm-old', t: T0, model: 'claude-opus-5-5', ttl: 5 * MIN }, o);
    delete s.bg;
    return s;
  };
  const rest = reply(T0, { id: 'm-old', write: 3000, read: 200000, tools: [['Agent', { prompt: 'look', run_in_background: true }, 'a1']] });
  assert.equal(feed([rest, result(T0 + 12 * MIN, 'a1'), cold(T0 + 12 * MIN + 2000)], true, older())[0].cause, 'agents');
  for (const [back, cause] of [[12 * MIN, 'command'], [MIN, 'other']]) {
    assert.equal(feed([result(T0 + back, 'c1'), cold(T0 + 12 * MIN + 2000)], true, older({ fg: 'command' }))[0].cause, cause, String(back));
  }
});

test('a session is never put down to waiting on agents it started in the background', () => {
  for (const name of ['Agent', 'Task']) {
    const start = { tools: [[name, { prompt: 'look', run_in_background: true }, 'a1']] };
    assert.equal(feed([warm(T0, start), result(T0 + 12 * MIN, 'a1'), cold(T0 + 12 * MIN + 2000)])[0].cause, 'other', name);
  }
  const quoted = { tools: [['Agent', { prompt: 'look', run_in_background: 'true' }, 'a1'], ['Bash', { command: 'npm test' }, 'c1']] };
  assert.equal(feed([warm(T0, quoted), result(T0 + 1000, 'a1'), result(T0 + 9 * MIN, 'c1'), cold(T0 + 9 * MIN)])[0].cause, 'command');
});
