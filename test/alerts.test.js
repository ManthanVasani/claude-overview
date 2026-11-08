'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

function el() {
  const classes = new Set();
  return {
    classList: { contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    style: {},
    hidden: true,
    addEventListener() {},
    setAttribute() {},
    querySelector: () => el(),
    querySelectorAll: () => [],
    contains: () => false,
    focus() {},
  };
}

function page(hiddenIds, o = {}) {
  const sent = [];
  const timers = [];
  const onStorage = [];
  let clock = 1e12;
  let readsFail = false;
  class Notification {
    constructor(head) { sent.push(head); }
  }
  Notification.permission = 'granted';
  // tabs of one origin share their storage
  const store = o.store || new Map();
  store.set('claude-overview-alerts', JSON.stringify({ on: true, needs: true, problems: true, turns: true }));
  const ctx = {
    // desktop alerts go out only while the page is not in front
    document: { getElementById: () => el(), querySelector: () => null, title: 'Claude overview', hasFocus: () => false, addEventListener() {}, documentElement: {} },
    localStorage: { getItem: (k) => { if (readsFail) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; }, setItem: (k, v) => { if (o.failWrites) throw new Error('quota'); store.set(k, String(v)); } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout: (fn) => timers.push(fn),
    clearTimeout() {},
    addEventListener: (type, fn) => { if (type === 'storage') onStorage.push(fn); },
    Date: { now: () => clock },
  };
  if (!o.noAlerts) ctx.Notification = Notification;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('hidden.js'), ctx);
  for (const id of hiddenIds) ctx.OVHidden.set(id, true);
  vm.runInContext(read('alerts.js'), ctx);
  return {
    snap: (sessions, attention, startedBy) => ctx.OVAlerts.onSnap({ boot: 1, sessions, attention: attention || [], startedBy }),
    settle: () => timers.splice(0).forEach((fn) => fn()),
    sent,
    hidden: ctx.OVHidden,
    alerts: ctx.OVAlerts,
    store,
    title: () => ctx.document.title,
    tick: (ms) => { clock += ms; },
    storage: (key) => onStorage.forEach((fn) => fn({ key })),
    blockReads: () => { readsFail = true; },
  };
}
const session = (id, state, o) => Object.assign({ id, name: id.toUpperCase(), alive: true, state, since: 5, pid: 100, startedAt: 1 }, o);
const waiting = (id, since, o) => session(id, 'needs-you', Object.assign({ waiting: { since, text: 'Waiting for your permission' } }, o));
const stopped = (id, node) => ({ level: 'error', sid: id, node: node || 's:' + id, title: id.toUpperCase(), text: 'Stopped: API Error', since: 7, session: id.toUpperCase(), quiet: false });

test('a hidden session and the sessions it started send no Your turn alert, and one on the board does', () => {
  const p = page(['a']);
  const startedBy = { c: 'a' };
  p.snap([session('a', 'working'), session('b', 'working'), session('c', 'working')], [], startedBy);
  p.snap([session('a', 'your-turn'), session('b', 'your-turn'), session('c', 'your-turn')], [], startedBy);
  p.settle();
  assert.deepEqual(p.sent, ['Your turn: B']);
});

test('a hidden session sends its Needs you alert, and a problem alert while the problem leaves it hidden', () => {
  const p = page(['a']);
  p.snap([session('a', 'working')]);
  p.snap([session('a', 'needs-you', { waiting: { since: 6, text: 'Waiting for your permission' } })]);
  const stopped = { level: 'error', sid: 'a', node: 's:a', title: 'A', text: 'Stopped: API Error', since: 7, session: 'A', quiet: false };
  const sessions = [session('a', 'error')];
  p.snap(sessions, [stopped]);
  assert.deepEqual(p.sent, ['Needs you: A', 'A']);
  assert.ok(p.hidden.view({ sessions, attention: [stopped] }, false, null).gone.has('a'));
});

test('the page loads hidden.js before the scripts that read it', () => {
  const html = read('index.html');
  const at = (f) => html.indexOf('<script src="/' + f + '"></script>');
  assert.ok(at('hidden.js') > 0);
  for (const f of ['map.js', 'live.js', 'alerts.js']) assert.ok(at('hidden.js') < at(f), f);
});

test('a muted session sends no Needs you, problem or Your turn alert while it still counts in the tab title, and the others alert', () => {
  const p = page(['c']);
  const ids = ['a', 'b', 'c'];
  p.snap(ids.map((id) => session(id, 'working')));
  p.alerts.mute(session('a'), true);
  p.alerts.mute(session('c'), true);
  p.snap(ids.map((id) => waiting(id, 6)));
  assert.equal(p.title(), '(3) Claude overview');
  p.snap(ids.map((id) => session(id, 'error')), [...ids.map((id) => stopped(id)), stopped('a', 'a:a:1')]);
  p.snap(ids.map((id) => session(id, 'working')));
  p.snap(ids.map((id) => session(id, 'your-turn')));
  p.settle();
  assert.deepEqual(p.sent, ['Needs you: B', 'B', 'Your turn: B']);
});

test('unmuting sends no alert for a wait that began while muted, and the next wait alerts', () => {
  const p = page([]);
  p.snap([session('a', 'working')]);
  p.alerts.mute(session('a'), true);
  p.snap([waiting('a', 6)]);
  p.alerts.mute(session('a'), false);
  p.snap([waiting('a', 6)]);
  p.snap([session('a', 'working')]);
  p.snap([waiting('a', 9)]);
  assert.deepEqual(p.sent, ['Needs you: A']);
});

test('a mute holds for one process of a session, so the session run again in a new process alerts', () => {
  const p = page([]);
  p.snap([session('a', 'working')]);
  p.alerts.mute(session('a'), true);
  p.snap([waiting('a', 6)]);
  p.snap([waiting('a', 8, { pid: 200, startedAt: 2 })]);
  assert.deepEqual(p.sent, ['Needs you: A']);
  assert.equal(p.alerts.muted(session('a', 'working', { pid: 200, startedAt: 2 })), false);
});

test('a mute is kept while its process is on the board or less than an hour off it, however long the board was quiet, and forgotten after that, never on an empty board', () => {
  const p = page([]);
  const a = session('a', 'working');
  const b = session('b', 'working');
  const died = session('a', 'died', { alive: false });
  p.snap([a, b]);
  p.alerts.mute(a, true);
  p.tick(3 * 3600e3);
  p.snap([b]);
  p.tick(30e3);
  p.snap([died, b], [stopped('a')]);
  assert.deepEqual(p.sent, []);
  p.tick(3 * 3600e3);
  p.snap([b]);
  p.tick(59 * 60e3);
  p.snap([b]);
  assert.ok(p.alerts.muted(a));
  p.tick(60e3 + 1);
  p.snap([]);
  assert.ok(p.alerts.muted(a));
  p.snap([b]);
  assert.equal(p.alerts.muted(a), false);
  assert.equal(p.store.get('claude-overview-muted'), '{}');
});

test('a mute or unmute in one tab applies in the others and redraws them, and its run leaving the board does not', () => {
  const one = page([]);
  const two = page([], { store: one.store });
  const a = session('a', 'working');
  one.snap([a]);
  two.snap([a]);
  let own = 0;
  let other = 0;
  one.alerts.on(() => own++);
  two.alerts.on(() => other++);
  one.alerts.mute(a, true);
  two.storage('claude-overview-muted');
  assert.ok(two.alerts.muted(a));
  one.snap([session('b', 'working')]);
  assert.notEqual(one.store.get('claude-overview-muted'), JSON.stringify({ 'a|100|1': 0 }));
  two.storage('claude-overview-muted');
  one.alerts.mute(a, false);
  two.storage(null);
  assert.equal(two.alerts.muted(a), false);
  assert.deepEqual([own, other], [2, 2]);
});

test('a tab that missed another tab\'s mute keeps it when it mutes one or saves that one has left the board', () => {
  const one = page([]);
  const two = page([], { store: one.store });
  const list = ['a', 'b', 'c'].map((id) => session(id, 'working'));
  const stored = () => Object.keys(JSON.parse(one.store.get('claude-overview-muted'))).sort();
  one.snap(list);
  two.snap(list);
  one.alerts.mute(list[0], true);
  two.alerts.mute(list[1], true);
  assert.deepEqual(stored(), ['a|100|1', 'b|100|1']);
  assert.ok(two.alerts.muted(list[0]));
  one.alerts.mute(list[2], true);
  two.snap([list[0], list[2]]);
  assert.deepEqual(stored(), ['a|100|1', 'b|100|1', 'c|100|1']);
  assert.ok(JSON.parse(one.store.get('claude-overview-muted'))['b|100|1'] > 0);
});

test('when the storage cannot be written, a mute lasts as long as the page', () => {
  const p = page([], { failWrites: true });
  const a = session('a', 'working');
  p.snap([a]);
  p.alerts.mute(a, true);
  p.storage('claude-overview-muted');
  p.snap([waiting('a', 6)]);
  assert.ok(p.alerts.muted(a));
  assert.deepEqual(p.sent, []);
});

test('when the storage stops being readable, the page keeps its mutes and does not write over the stored ones', () => {
  const p = page([]);
  const a = session('a', 'working');
  p.snap([a]);
  p.alerts.mute(a, true);
  p.blockReads();
  p.snap([session('b', 'working')]);
  p.snap([waiting('a', 6)]);
  assert.ok(p.alerts.muted(a));
  assert.deepEqual(p.sent, []);
  assert.deepEqual(Object.keys(JSON.parse(p.store.get('claude-overview-muted'))), ['a|100|1']);
});

test('a browser that cannot show desktop alerts offers no mute', () => {
  assert.equal(page([], { noAlerts: true }).alerts.mute, null);
  assert.equal(typeof page([]).alerts.mute, 'function');
});

test('the details offer the bell and the cards say muted only for a running session that is not headless, in a browser that can alert, and a mute redraws the board', () => {
  const map = read('map.js');
  assert.match(map, /function canMute\(x\) \{ return !!\(x\.alive && !x\.headless && window\.OVAlerts && window\.OVAlerts\.mute\); \}/);
  assert.match(map, /function isMuted\(x\) \{ return canMute\(x\) && window\.OVAlerts\.muted\(x\); \}/);
  assert.match(map, /const mute = \(n\.kind === 'session' \|\| n\.kind === 'child'\) && canMute\(x\) \? muteHtml\(x\) : '';/);
  assert.equal((map.match(/\(isMuted\(x\) \? '<span class="badge">muted<\/span> ' : ''\)/g) || []).length, 2);
  assert.match(map, /document\.addEventListener\('DOMContentLoaded', \(\) => \{ if \(window\.OVAlerts && window\.OVAlerts\.on\) window\.OVAlerts\.on\(render\); \}\);/);
});
