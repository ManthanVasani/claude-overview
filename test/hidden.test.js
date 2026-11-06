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
// startedBy also holds the sessions that have left the board
function board(sessions, attention, startedBy) {
  const up = Object.assign({}, startedBy);
  for (const s of sessions) if (s.parentSid) up[s.id] = s.parentSid;
  return { sessions, attention: attention || [], startedBy: up };
}

test('a hidden session leaves the board with every session it started, and the others stay', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('a', true);
  const v = h.view(board([session('a'), session('c1', { parentSid: 'a' }), session('c2', { parentSid: 'c1' }), session('b'), session('c3', { parentSid: 'gone' })]));
  assert.deepEqual(ids(v, ['a', 'c1', 'c2', 'b', 'c3']), ['a', 'c1', 'c2']);
  assert.equal(v.count, 1);
  assert.deepEqual(marked(v), []);
  h.set('a', false);
  assert.deepEqual(ids(h.view(board([session('a'), session('c1', { parentSid: 'a' })])), ['a', 'c1']), []);
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
    const v = h.view(board(list, attention));
    assert.deepEqual(ids(v, ['a', 'c1']), gone ? ['a', 'c1'] : [], name);
    assert.deepEqual(marked(v), gone ? [] : ['a'], name);
    assert.equal(v.count, gone ? 1 : 0, name);
  }
});

test('showing the hidden sessions brings each one back, marked, and keeps the count', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('a', true);
  h.set('b', true);
  const v = h.view(board([session('a'), session('c1', { parentSid: 'a' }), session('b'), session('d')], [{ level: 'error', sid: 'b', quiet: false }]), true);
  assert.deepEqual(ids(v, ['a', 'c1', 'b', 'd']), []);
  assert.deepEqual(marked(v), ['a', 'b']);
  assert.equal(v.count, 1);
});

test('the steps of a hidden session that has left the board stay off the timeline, with those of the sessions it started', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('a', true);
  const left = board([session('b')], [], { c1: 'a' });
  assert.deepEqual(ids(h.view(left), ['a', 'c1', 'b', 'never-seen']), ['a', 'c1']);
  assert.deepEqual(ids(h.view(left, true), ['a', 'c1']), []);
  const back = h.view(board([session('a')], [{ level: 'error', sid: 'a', quiet: false }], { c1: 'a' }));
  assert.deepEqual(ids(back, ['a', 'c1']), []);
});

test('the sessions a hidden session started stay off the timeline once they leave the board, after a reload and in a new tab', () => {
  const store = { data: {} };
  const clock = { t: 0 };
  page(store, clock).h.set('a', true);
  const left = board([session('b')], [], { c1: 'a', c2: 'a' });
  assert.deepEqual(ids(page(store, clock).h.view(left), ['a', 'c1', 'c2', 'b']), ['a', 'c1', 'c2']);
  page(store, clock).h.set('a', false);
  assert.deepEqual(ids(page(store, clock).h.view(left), ['a', 'c1', 'c2']), []);
});

test('the page saves only the sessions you hid, and nothing while none is hidden', () => {
  const store = { data: {} };
  const clock = { t: 0 };
  const { h } = page(store, clock);
  const snap = board([session('a'), session('c1', { parentSid: 'a' }), session('b')], [], { d1: 'b' });
  h.view(snap);
  clock.t = 2 * HOUR;
  h.view(snap);
  assert.equal(store.data[KEY], undefined);
  h.set('a', true);
  h.view(snap);
  assert.deepEqual(JSON.parse(store.data[KEY]), { a: 2 * HOUR });
});

test('the sessions a hidden session started stay hidden once its process has ended, while they run and after they end', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('a', true);
  const ended = board([session('a', { alive: false, state: 'died' }), session('c1'), session('c2', { parentSid: 'c1' }), session('b')], [], { c1: 'a' });
  const v = h.view(ended);
  assert.deepEqual(ids(v, ['a', 'c1', 'c2', 'b']), ['a', 'c1', 'c2']);
  assert.equal(v.count, 1);
  assert.deepEqual(marked(h.view(ended, true)), ['a', 'c1']);
  const gone = h.view(board([session('c1', { alive: false, state: 'died' }), session('c2', { alive: false, state: 'died' }), session('b')], [], { c1: 'a', c2: 'c1' }));
  assert.deepEqual(ids(gone, ['a', 'c1', 'c2', 'b']), ['a', 'c1', 'c2']);
});

test('a session hidden inside a session on the board takes only its own sessions off, and is marked when shown', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('c', true);
  const snap = board([session('p'), session('c', { parentSid: 'p' }), session('c1', { parentSid: 'c' })]);
  const v = h.view(snap);
  assert.deepEqual(ids(v, ['p', 'c', 'c1']), ['c', 'c1']);
  assert.equal(v.count, 1);
  assert.deepEqual(marked(h.view(snap, true)), ['c']);
});

test('a session hidden inside a hidden one comes back with it, both marked, and stays hidden through it', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('p', true);
  h.set('c1', true);
  const tree = (o) => board([session('p'), session('c1', { parentSid: 'p' }), session('c2', Object.assign({ parentSid: 'c1' }, o))]);
  const quiet = h.view(tree());
  assert.deepEqual(ids(quiet, ['p', 'c1', 'c2']), ['p', 'c1', 'c2']);
  assert.equal(quiet.count, 1);
  const loud = h.view(tree({ state: 'needs-you' }));
  assert.deepEqual(ids(loud, ['p', 'c1', 'c2']), []);
  assert.deepEqual(marked(loud), ['c1', 'p']);
  h.set('c1', false);
  assert.deepEqual(ids(h.view(tree()), ['p', 'c1', 'c2']), ['p', 'c1', 'c2']);
});

test('a session hidden on its own stays hidden when the session that started it is hidden and then shown again', () => {
  const store = { data: {} };
  const clock = { t: 0 };
  const { h } = page(store, clock);
  h.set('c1', true);
  h.set('a', true);
  const next = page(store, clock).h;
  next.set('a', false);
  assert.deepEqual([next.has('a'), next.has('c1')], [false, true]);
  assert.deepEqual(ids(next.view(board([session('a'), session('c1', { parentSid: 'a' })])), ['a', 'c1']), ['c1']);
});

test('the session whose details are open stays on the board, marked, with the sessions it started', () => {
  const { h } = page({ data: {} }, { t: 0 });
  h.set('a', true);
  const snap = board([session('a'), session('c1', { parentSid: 'a' }), session('b')]);
  const v = h.view(snap, false, 'c1');
  assert.deepEqual(ids(v, ['a', 'c1', 'b']), []);
  assert.deepEqual(marked(v), ['a']);
  assert.equal(v.count, 1);
  assert.deepEqual([v.held('a'), v.held('c1'), v.held('b')], [true, true, false]);
  assert.deepEqual(ids(h.view(snap, false, 'b'), ['a', 'c1']), ['a', 'c1']);
  assert.deepEqual(ids(h.view(snap, false, 'not-on-the-board'), ['a', 'c1']), ['a', 'c1']);
  assert.equal(h.view(snap, true, 'a').held('a'), false);
  assert.equal(h.view(Object.assign({}, snap, { attention: [{ level: 'error', sid: 'a', quiet: false }] }), false, 'a').held('a'), false);
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

test('with the storage blocked or full, a hide lasts as long as the page, and once a save works the tabs share the list again', () => {
  for (const store of [{ blocked: true }, { data: {}, full: true }]) {
    const { h, storage } = page(store, { t: 0 });
    h.set('a', true);
    h.set('b', true);
    assert.deepEqual([h.has('a'), h.has('b')], [true, true]);
    assert.deepEqual(ids(h.view({ sessions: [session('a'), session('b'), session('c')], attention: [] }), ['a', 'b', 'c']), ['a', 'b']);
    if (store.data) store.data[KEY] = '{}';
    storage(KEY);
    assert.deepEqual([h.has('a'), h.has('b')], [true, true]);
  }
  const store = { data: {}, full: true };
  const { h, storage } = page(store, { t: 0 });
  h.set('a', true);
  store.full = false;
  h.set('b', true);
  store.data[KEY] = JSON.stringify({ a: 0, b: 0, c: 0 });
  storage(KEY);
  assert.equal(h.has('c'), true);
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
