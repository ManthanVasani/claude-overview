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

function page(hiddenIds) {
  const sent = [];
  const timers = [];
  class Notification {
    constructor(head) { sent.push(head); }
  }
  Notification.permission = 'granted';
  const prefs = JSON.stringify({ on: true, needs: true, problems: true, turns: true });
  const ctx = {
    // desktop alerts go out only while the page is not in front
    document: { getElementById: () => el(), querySelector: () => null, title: 'Claude overview', hasFocus: () => false, addEventListener() {}, documentElement: {} },
    localStorage: { getItem: (k) => (k === 'claude-overview-alerts' ? prefs : null), setItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout: (fn) => timers.push(fn),
    clearTimeout() {},
    addEventListener() {},
    Notification,
  };
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
  };
}
const session = (id, state, o) => Object.assign({ id, name: id.toUpperCase(), alive: true, state, since: 5 }, o);

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
