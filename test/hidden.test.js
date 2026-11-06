'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'hidden.js'), 'utf8');
const KEY = 'claude-overview-hidden';
const HOUR = 3600e3;
const DAY = 24 * HOUR;

// the tabs of one board share the storage
function page(store, clock) {
  const on = {};
  const localStorage = store.blocked
    ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }
    : { getItem: (k) => (k in store.data ? store.data[k] : null), setItem: (k, v) => { if (store.full) throw new Error('quota'); store.data[k] = String(v); } };
  const window = { addEventListener(type, fn) { on[type] = fn; } };
  vm.runInNewContext(SRC, { window, localStorage, Date: { now: () => clock.t } });
  return { h: window.OVHidden, storage: (key) => on.storage({ key }) };
}
const session = (id, o) => Object.assign({ id, name: id, alive: true, state: 'working', agents: [], workflows: [], shells: [] }, o);
const ids = (v, list) => list.filter((id) => v.concealed(id));
// the script's objects come from its own context, whose prototypes a strict compare would tell apart
const plain = (x) => JSON.parse(JSON.stringify(x));
const marked = (v) => [...v.marked].sort();

test('a hidden session leaves the board with every session it started, and the others stay', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('a', true);
  const v = h.view({ sessions: [session('a'), session('c1', { parentSid: 'a' }), session('c2', { parentSid: 'c1' }), session('b'), session('c3', { parentSid: 'gone' })], attention: [] });
  assert.deepEqual(ids(v, ['a', 'c1', 'c2', 'b', 'c3']), ['a', 'c1', 'c2']);
  assert.equal(v.count, 1);
  assert.deepEqual(marked(v), []);
  h.set('a', false);
  assert.deepEqual(ids(h.view({ sessions: [session('a'), session('c1', { parentSid: 'a' })], attention: [] }), ['a', 'c1']), []);
});

test('a hidden session stays on the board, marked, while it would send a desktop alert or a session in it waits for you', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('a', true);
  const sessions = (o) => [session('a'), session('c1', Object.assign({ parentSid: 'a' }, o))];
  const row = (sid, quiet) => ({ level: 'error', sid, node: 's:' + sid, quiet });
  const cases = [
    ['a problem row', sessions(), [row('a', false)], false],
    ["a started session's quiet row", sessions(), [row('c1', true)], true],
    ['a started session waiting for you', sessions({ state: 'needs-you' }), [], false],
    ['a started headless run waiting', sessions({ state: 'needs-you', headless: { kept: true } }), [], true],
    ['a started session that has ended in needs-you', sessions({ state: 'needs-you', alive: false }), [], true],
  ];
  for (const [name, list, attention, gone] of cases) {
    const v = h.view({ sessions: list, attention });
    assert.deepEqual(ids(v, ['a', 'c1']), gone ? ['a', 'c1'] : [], name);
    assert.deepEqual(marked(v), gone ? [] : ['a'], name);
    assert.equal(v.count, gone ? 1 : 0, name);
  }
});

test('showing the hidden sessions brings each one back, marked, and keeps the count', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('a', true);
  h.set('b', true);
  const v = h.view({ sessions: [session('a'), session('c1', { parentSid: 'a' }), session('b'), session('d')], attention: [{ level: 'error', sid: 'b', quiet: false }] }, true);
  assert.deepEqual(ids(v, ['a', 'c1', 'b', 'd']), []);
  assert.deepEqual(marked(v), ['a', 'b']);
  assert.equal(v.count, 1);
});

test('the steps of a hidden session that has left the board stay off the timeline, with those of the sessions it started', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('a', true);
  h.view({ sessions: [session('a'), session('c1', { parentSid: 'a' }), session('b')], attention: [] });
  const left = h.view({ sessions: [session('b')], attention: [] });
  assert.deepEqual(ids(left, ['a', 'c1', 'b', 'never-seen']), ['a', 'c1']);
  assert.deepEqual(ids(h.view({ sessions: [session('b')], attention: [] }, true), ['a', 'c1']), []);
  const back = h.view({ sessions: [session('a')], attention: [{ level: 'error', sid: 'a', quiet: false }] });
  assert.deepEqual(ids(back, ['a', 'c1']), []);
});

test('the sessions a hidden session started stay off the timeline once they leave the board, after a reload and in a new tab', () => {
  const store = { data: {} };
  const clock = { t: 0 };
  const one = page(store, clock);
  one.h.set('a', true);
  one.h.view({ sessions: [session('a'), session('c1', { parentSid: 'a' }), session('c2', { parentSid: 'a' }), session('b')], attention: [] });
  const two = page(store, clock);
  assert.deepEqual(ids(two.h.view({ sessions: [session('a'), session('c2', { parentSid: 'a' })], attention: [] }), ['a', 'c1', 'c2']), ['a', 'c1', 'c2']);
  assert.deepEqual(ids(page(store, clock).h.view({ sessions: [session('b')], attention: [] }), ['a', 'c1', 'c2', 'b']), ['a', 'c1', 'c2']);
  two.h.set('a', false);
  assert.deepEqual(ids(page(store, clock).h.view({ sessions: [session('b')], attention: [] }), ['a', 'c1', 'c2']), []);
});

test("a session hidden after a session it started has left the board keeps that session's steps off the timeline too", () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.view({ sessions: [session('a'), session('c1', { parentSid: 'a' })], attention: [] });
  h.view({ sessions: [session('a')], attention: [] });
  h.set('a', true);
  assert.deepEqual(ids(h.view({ sessions: [session('a')], attention: [] }), ['a', 'c1']), ['a', 'c1']);
});

test('a started session away from the board longer than the timeline keeps a step is forgotten, and only those of hidden sessions are saved', () => {
  const store = { data: {} };
  const clock = { t: 0 };
  const { h } = page(store, clock);
  const saved = () => JSON.parse(store.data[KEY]);
  h.set('a', true);
  const both = [session('a'), session('c1', { parentSid: 'a' }), session('b'), session('d1', { parentSid: 'b' })];
  h.view({ sessions: both, attention: [] });
  assert.deepEqual(saved(), { a: 0, c1: ['a', 0] });
  clock.t = HOUR / 2;
  h.view({ sessions: both, attention: [] });
  assert.deepEqual(saved(), { a: 0, c1: ['a', 0] });
  clock.t = 4 * HOUR;
  h.view({ sessions: [session('a')], attention: [] });
  assert.deepEqual(saved(), { a: 4 * HOUR, c1: ['a', 0] });
  clock.t = 4 * HOUR + 1;
  const v = h.view({ sessions: [session('a')], attention: [] });
  assert.deepEqual(saved(), { a: 4 * HOUR });
  assert.deepEqual(ids(v, ['a', 'c1']), ['a']);
});

test('a session hidden on its own stays hidden when the session that started it is hidden and then shown again', () => {
  const store = { data: {} };
  const clock = { t: 0 };
  const { h } = page(store, clock);
  h.set('c1', true);
  h.set('a', true);
  h.view({ sessions: [session('a'), session('c1', { parentSid: 'a' })], attention: [] });
  const next = page(store, clock).h;
  next.set('a', false);
  assert.deepEqual([next.has('a'), next.has('c1')], [false, true]);
});

test('the session whose details are open stays on the board, marked, with the sessions it started', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('a', true);
  const snap = { sessions: [session('a'), session('c1', { parentSid: 'a' }), session('b')], attention: [] };
  const v = h.view(snap, false, 'c1');
  assert.deepEqual(ids(v, ['a', 'c1', 'b']), []);
  assert.deepEqual(marked(v), ['a']);
  assert.equal(v.count, 0);
  assert.deepEqual(ids(h.view(snap, false, 'b'), ['a', 'c1']), ['a', 'c1']);
  assert.deepEqual(ids(h.view(snap, false, 'not-on-the-board'), ['a', 'c1']), ['a', 'c1']);
});

test('the list outlives a reload, and the tabs of the board share it, each redrawing only when the list changes', () => {
  const store = { data: {} };
  const clock = { t: 0 };
  const one = page(store, clock);
  const two = page(store, clock);
  let told = 0;
  two.h.on(() => told++);
  one.h.set('a', true);
  assert.equal(page(store, clock).h.has('a'), true);
  two.storage('another-key');
  assert.deepEqual([two.h.has('a'), told], [false, 0]);
  two.storage(KEY);
  assert.deepEqual([two.h.has('a'), told], [true, 1]);
  store.data[KEY] = JSON.stringify({ a: 5 });
  two.storage(KEY);
  assert.equal(told, 1);
  delete store.data[KEY];
  two.storage(null);
  assert.deepEqual([two.h.has('a'), told], [false, 2]);
  one.h.set('a', true);
  const three = page(store, clock);
  one.h.set('b', true);
  three.h.set('c', true);
  assert.deepEqual(Object.keys(JSON.parse(store.data[KEY])).sort(), ['a', 'b', 'c']);
});

test('an id away from the board for a week is forgotten, never on a snapshot with no sessions, and one on it is kept fresh', () => {
  const store = { data: {} };
  const clock = { t: 0 };
  const { h } = page(store, clock);
  h.set('a', true);
  h.set('b', true);
  const saved = () => JSON.parse(store.data[KEY]);
  clock.t = HOUR / 2;
  h.view({ sessions: [session('b')], attention: [] });
  assert.deepEqual(saved(), { a: 0, b: 0 });
  clock.t = 2 * HOUR;
  h.view({ sessions: [session('b')], attention: [] });
  assert.deepEqual(saved(), { a: 0, b: 2 * HOUR });
  clock.t = 7 * DAY + HOUR;
  h.view({ sessions: [], attention: [] });
  assert.deepEqual(saved(), { a: 0, b: 2 * HOUR });
  h.view({ sessions: [session('x')], attention: [] });
  assert.deepEqual(saved(), { b: 2 * HOUR });
  assert.deepEqual([h.has('a'), h.has('b')], [false, true]);
});

test('with the storage blocked or full, a hide lasts as long as the page', () => {
  for (const store of [{ blocked: true }, { data: {}, full: true }]) {
    const { h } = page(store, { t: 0 });
    h.set('a', true);
    h.set('b', true);
    assert.deepEqual([h.has('a'), h.has('b')], [true, true]);
    assert.deepEqual(ids(h.view({ sessions: [session('a'), session('b'), session('c')], attention: [] }), ['a', 'b', 'c']), ['a', 'b']);
  }
});

test('a stored list the page cannot read counts as empty, and an entry without a time is left out', () => {
  for (const raw of ['{', '"a"', JSON.stringify({ a: 'x', b: 5 })]) {
    const { h } = page({ data: { [KEY]: raw } }, { t: 0 });
    assert.equal(h.has('a'), false, raw);
  }
  assert.equal(page({ data: { [KEY]: JSON.stringify({ a: 'x', b: 5 }) } }, { t: 0 }).h.has('b'), true);
});

test('the header counts what is on the board', () => {
  const { h } = page({ data: {} }, { t: 0 });
  const list = [
    session('w', { agents: [{ state: 'running' }, { state: 'done' }], shells: [{ state: 'running' }, { state: 'done' }] }),
    session('r', { state: 'retrying', workflows: [{ state: 'running', running: 2 }, { state: 'done', running: 0 }] }),
    session('y', { state: 'your-turn' }),
    session('e', { state: 'error' }),
    session('n', { state: 'needs-you' }),
    session('d', { state: 'died', alive: false }),
  ];
  const attention = [{ level: 'needs' }, { level: 'error' }, { level: 'warn' }];
  assert.deepEqual(plain(h.totals(list, attention)), { sessions: 5, working: 2, yourTurn: 2, needsYou: 1, problems: 2, agentsRunning: 3, shellsRunning: 1, workflowsRunning: 1, ended: 1 });
});
