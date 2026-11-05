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

// desktop alerts go out only while the page is not in front
function page(hiddenIds) {
  const sent = [];
  const timers = [];
  class Notification {
    constructor(head) { sent.push(head); }
  }
  Notification.permission = 'granted';
  const prefs = JSON.stringify({ on: true, needs: true, problems: true, turns: true });
  const ctx = {
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
    snap: (sessions, attention) => ctx.OVAlerts.onSnap({ boot: 1, sessions, attention: attention || [] }),
    settle: () => timers.splice(0).forEach((fn) => fn()),
    sent,
  };
}
const session = (id, state, o) => Object.assign({ id, name: id.toUpperCase(), alive: true, state, since: 5 }, o);

test('a hidden session sends no Your turn alert, and one on the board does', () => {
  const p = page(['a']);
  p.snap([session('a', 'working'), session('b', 'working')]);
  p.snap([session('a', 'your-turn'), session('b', 'your-turn')]);
  p.settle();
  assert.deepEqual(p.sent, ['Your turn: B']);
});

test('a hidden session sends its Needs you and Stopped alerts', () => {
  const p = page(['a']);
  p.snap([session('a', 'working')]);
  const stopped = { level: 'error', sid: 'a', node: 's:a', title: 'A', text: 'Stopped: API Error', since: 7, session: 'A', quiet: false };
  p.snap([session('a', 'needs-you', { waiting: { since: 6, text: 'Waiting for your permission' } })], [stopped]);
  assert.deepEqual(p.sent, ['Needs you: A', 'A']);
});

test('the page loads hidden.js before the scripts that read it', () => {
  const html = read('index.html');
  const at = (f) => html.indexOf('<script src="/' + f + '"></script>');
  assert.ok(at('hidden.js') > 0);
  for (const f of ['map.js', 'live.js', 'alerts.js']) assert.ok(at('hidden.js') < at(f), f);
});
