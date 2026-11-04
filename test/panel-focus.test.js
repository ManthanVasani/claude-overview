'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');

class Text {
  constructor(value) { this.nodeType = 3; this.nodeName = '#text'; this.nodeValue = value; this.parentNode = null; }
  get childNodes() { return []; }
}

class El {
  constructor(page, name, attrs = {}) {
    this.page = page;
    this.nodeType = 1;
    this.nodeName = name;
    this.attributes = Object.keys(attrs).map((a) => ({ name: a, value: attrs[a] }));
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.scrollTop = 0;
  }
  get parentElement() { return this.parentNode; }
  hasAttribute(n) { return this.attributes.some((a) => a.name === n); }
  getAttribute(n) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; }
  setAttribute(n, v) { const a = this.attributes.find((x) => x.name === n); if (a) a.value = v; else this.attributes.push({ name: n, value: v }); }
  removeAttribute(n) { this.attributes = this.attributes.filter((a) => a.name !== n); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  appendChild(c) { if (c.parentNode) c.parentNode.childNodes.splice(c.parentNode.childNodes.indexOf(c), 1); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) {
    this.childNodes.splice(this.childNodes.indexOf(c), 1);
    c.parentNode = null;
    if (c === this.page.active || (c.contains && c.contains(this.page.active))) this.page.active = this.page.body;
    return c;
  }
  replaceChild(w, h) {
    const i = this.childNodes.indexOf(h);
    this.removeChild(h);
    if (w.parentNode) w.parentNode.childNodes.splice(w.parentNode.childNodes.indexOf(w), 1);
    w.parentNode = this;
    this.childNodes.splice(i, 0, w);
    return h;
  }
  contains(o) { for (let n = o; n; n = n.parentNode) if (n === this) return true; return false; }
  matches(sel) { const m = /^\[([a-z-]+)\]$/.exec(sel); return m ? this.hasAttribute(m[1]) : this.nodeName === sel.toUpperCase(); }
  closest(sel) { for (let n = this; n; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  get isConnected() { return this.page.body.contains(this); }
  focusable() { return this.nodeName === 'BUTTON' || this.hasAttribute('tabindex') || (this.nodeName === 'A' && this.hasAttribute('href')); }
  get shown() { for (let n = this; n; n = n.parentNode) if (n.hasAttribute('hidden')) return false; return true; }
  focus(opts) {
    assert.equal(opts && opts.preventScroll, true);
    if (this.focusable() && this.isConnected && this.shown) this.page.active = this;
  }
  blur() { if (this.page.active === this) this.page.active = this.page.body; }
}

function parse(page, html, into) {
  const stack = [into];
  for (const m of html.matchAll(/<\/[^>]+>|<([a-z]+)([^>]*)>|[^<]+/g)) {
    const top = stack[stack.length - 1];
    if (m[0].startsWith('</')) stack.pop();
    else if (m[1]) {
      const attrs = {};
      for (const a of m[2].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] || '';
      stack.push(top.appendChild(new El(page, m[1].toUpperCase(), attrs)));
    } else top.appendChild(new Text(m[0]));
  }
}

function serialize(el) {
  return el.childNodes.map((c) => {
    if (c.nodeType !== 1) return c.nodeValue;
    const attrs = c.attributes.map((a) => a.name + '="' + a.value + '"').sort().join(' ');
    return '<' + c.nodeName.toLowerCase() + (attrs ? ' ' + attrs : '') + '>' + serialize(c) + '</' + c.nodeName.toLowerCase() + '>';
  }).join('');
}

function makePage() {
  const page = {};
  page.body = new El(page, 'BODY');
  page.active = page.body;
  const panel = page.body.appendChild(new El(page, 'ASIDE', { id: 'panel' }));
  const document = {
    body: page.body,
    get activeElement() { return page.active; },
    createElement() {
      const content = new El(page, '#fragment');
      return { content, set innerHTML(html) { parse(page, html, content); } };
    },
  };
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'panel-focus.js'), 'utf8'), { window, document });
  const card = page.body.appendChild(new El(page, 'DIV', { tabindex: '0' }));
  const button = page.body.appendChild(new El(page, 'BUTTON'));
  const list = page.body.appendChild(new El(page, 'SECTION', { id: 'touch' }));
  const rows = list.appendChild(new El(page, 'UL'));
  const draw = (keys) => {
    for (const r of rows.childNodes.slice()) rows.removeChild(r);
    for (const k of keys) rows.appendChild(new El(page, 'LI', { 'data-key': k, tabindex: '0' }));
    return rows.childNodes;
  };
  return { page, panel, window, card, button, list, draw, focus: window.OVPanelFocus(panel) };
}

const KEY = { type: 'keydown', preventDefault() {} };
const KEY_CLICK = { type: 'click', detail: 0 };
const MOUSE = { type: 'click', detail: 1 };
const HTML = '<div class="p-top"><span>Agent</span><button data-close>x</button></div><p>Reading a file</p><a href="/pr/1">PR</a>';
const closeOf = (panel) => panel.querySelector('[data-close]');
const linkOf = (panel) => panel.querySelector('a');

function openFrom(t, el, event) {
  t.focus.redraw(HTML);
  el.focus({ preventScroll: true });
  t.window.event = event;
  t.focus.opened();
}

test('a redraw leaves the panel holding exactly what the new HTML says', () => {
  const steps = [
    '',
    HTML,
    '<div class="p-top" id="t"><span>Agent</span><button data-close>x</button></div><p>Writing</p>',
    '<div><b>one</b>two<i>three</i></div>',
    '<div>one<b>two</b></div>text',
    '<svg viewBox="0 0 1 1"><rect width="1"></rect></svg><div class="a" title="b"></div>',
    '<svg><rect></rect><rect height="2"></rect></svg><div class="c"></div>',
    '<p></p>',
    '',
  ];
  for (const from of steps) {
    for (const to of steps) {
      const { page, panel, focus } = makePage();
      focus.redraw(from);
      focus.redraw(to);
      const fresh = new El(page, '#fragment');
      parse(page, to, fresh);
      assert.equal(serialize(panel), serialize(fresh), from + ' -> ' + to);
    }
  }
});

test('focus stays on the same control when a redraw changes what is around it', () => {
  const { page, panel, focus } = makePage();
  focus.redraw(HTML);
  const link = linkOf(panel);
  link.focus({ preventScroll: true });
  focus.redraw(HTML.replace('Reading a file', 'Writing a file').replace('Agent', 'Workflow').replace('/pr/1', '/pr/2'));
  assert.equal(page.active, link);
  assert.equal(linkOf(panel), link);
  assert.equal(link.getAttribute('href'), '/pr/2');
});

test('focus whose control a redraw removes goes to the Close button, not to the page', () => {
  const { page, panel, focus } = makePage();
  focus.redraw(HTML);
  linkOf(panel).focus({ preventScroll: true });
  focus.redraw(HTML.replace('<a href="/pr/1">PR</a>', '<p>No pull request</p>'));
  assert.equal(page.active, closeOf(panel));
});

test('a redraw leaves focus alone when it is outside the panel', () => {
  const { page, card, focus } = makePage();
  focus.redraw(HTML);
  card.focus({ preventScroll: true });
  focus.redraw('<button data-close>x</button><p>This item is no longer on the map.</p>');
  assert.equal(page.active, card);
  page.active = page.body;
  focus.redraw(HTML);
  assert.equal(page.active, page.body);
});

test('only a key press moves focus to the Close button when the panel opens', () => {
  for (const [event, moves] of [
    [KEY, true],
    [KEY_CLICK, true],
    [MOUSE, false],
    [{ type: 'pointerup' }, false],
    [{ type: 'message' }, false],
    [{ type: 'click' }, false],
    [undefined, false],
  ]) {
    const t = makePage();
    openFrom(t, t.card, event);
    assert.equal(t.page.active, moves ? closeOf(t.panel) : t.card, JSON.stringify(event));
  }
});

test('a key press that opens the panel goes no further, so it cannot press the Close button', () => {
  for (const [event, stops] of [[{ type: 'keydown' }, true], [KEY_CLICK, false]]) {
    let stopped = false;
    event.preventDefault = () => { stopped = true; };
    const t = makePage();
    openFrom(t, t.card, event);
    assert.equal(stopped, stops, event.type);
    assert.equal(t.page.active, closeOf(t.panel));
  }
});

test('closing from the keyboard puts focus back on what opened the panel', () => {
  for (const event of [KEY, KEY_CLICK]) {
    const t = makePage();
    const [row] = t.draw(['a']);
    openFrom(t, row, KEY);
    t.window.event = event;
    t.focus.closing(t.card)();
    assert.equal(t.page.active, row);
  }
});

test('a row that its list redrew while the panel was open gets focus back', () => {
  const t = makePage();
  openFrom(t, t.draw(['a', 'b'])[1], KEY);
  const [b] = t.draw(['b', 'a']);
  t.focus.closing(t.card)();
  assert.equal(t.page.active, b);
});

test('closing puts focus back on a control with no data of its own', () => {
  const t = makePage();
  openFrom(t, t.button, KEY);
  t.focus.closing(t.card)();
  assert.equal(t.page.active, t.button);
});

test('a row is found again only in its own list', () => {
  const t = makePage();
  const other = t.page.body.appendChild(new El(t.page, 'SECTION', { id: 'alerts' }));
  openFrom(t, t.draw(['a'])[0], KEY);
  t.draw([]);
  const twin = other.appendChild(new El(t.page, 'LI', { 'data-key': 'a', tabindex: '0' }));
  t.focus.closing(t.card)();
  assert.notEqual(t.page.active, twin);
  assert.equal(t.page.active, t.card);
});

test('closing goes to the card when what opened the panel is hidden', () => {
  const t = makePage();
  openFrom(t, t.draw(['a'])[0], KEY);
  const done = t.focus.closing(t.card);
  t.list.setAttribute('hidden', '');
  done();
  assert.equal(t.page.active, t.card);
});

test('closing with nowhere to go takes focus off the hidden panel', () => {
  const t = makePage();
  openFrom(t, t.page.body, KEY);
  t.focus.closing(undefined)();
  assert.equal(t.page.active, t.page.body);
});

test('a key held down after the panel opens does not press Close', () => {
  const t = makePage();
  for (const [e, stops] of [[{ key: 'Enter', repeat: true }, true], [{ key: ' ', repeat: true }, true], [{ key: 'Enter', repeat: false }, false], [{ key: 'a', repeat: true }, false]]) {
    let stopped = false;
    e.preventDefault = () => { stopped = true; };
    t.panel.listeners.keydown(e);
    assert.equal(stopped, stops, JSON.stringify(e));
  }
});

test('a keyboard open shows the top of the panel, where Close is', () => {
  for (const [event, top] of [[KEY, 0], [MOUSE, 300]]) {
    const t = makePage();
    t.panel.scrollTop = 300;
    openFrom(t, t.card, event);
    assert.equal(t.panel.scrollTop, top);
  }
});

test('closing goes to the card when what opened the panel is gone or was the page', () => {
  const t = makePage();
  openFrom(t, t.draw(['a'])[0], KEY);
  t.draw(['b']);
  t.focus.closing(t.card)();
  assert.equal(t.page.active, t.card);

  t.page.active = t.page.body;
  t.window.event = KEY;
  t.focus.opened();
  assert.equal(t.page.active, closeOf(t.panel));
  t.focus.closing(t.card)();
  assert.equal(t.page.active, t.card);
});

test('a second open from inside the panel keeps the first opener', () => {
  const t = makePage();
  const [row] = t.draw(['a']);
  openFrom(t, row, KEY);
  linkOf(t.panel).focus({ preventScroll: true });
  t.focus.opened();
  assert.equal(t.page.active, closeOf(t.panel));
  t.focus.closing(t.card)();
  assert.equal(t.page.active, row);
});

test('closing leaves focus alone after a mouse click or when focus is outside the panel', () => {
  const a = makePage();
  openFrom(a, a.draw(['a'])[0], KEY);
  a.window.event = MOUSE;
  a.focus.closing(a.card)();
  assert.equal(a.page.active, closeOf(a.panel));

  const b = makePage();
  const [row] = b.draw(['a']);
  openFrom(b, row, KEY);
  b.card.focus({ preventScroll: true });
  b.focus.closing(b.card)();
  assert.equal(b.page.active, b.card);
  row.focus({ preventScroll: true });
  b.focus.closing(b.card)();
  assert.equal(b.page.active, row);
});

test('a mouse open forgets an earlier opener', () => {
  const t = makePage();
  openFrom(t, t.draw(['a'])[0], KEY);
  t.window.event = MOUSE;
  t.focus.opened();
  closeOf(t.panel).focus({ preventScroll: true });
  t.window.event = KEY;
  t.focus.closing(t.card)();
  assert.equal(t.page.active, t.card);
});

test('the page loads panel-focus.js first, draws the panel only through it, names the panel and rings Close', () => {
  const map = fs.readFileSync(path.join(PUBLIC, 'map.js'), 'utf8');
  const page = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.doesNotMatch(map, /panel\.innerHTML/);
  assert.match(map, /if \(panel\.html !== html\) \{\s+const top = panel\.scrollTop;\s+panelFocus\.redraw\(html\);/);
  assert.match(map, /function openPanel\(id\) \{[^}]*?renderPanel\(\);\s+panelFocus\.opened\(\);/);
  assert.match(map, /function closePanel\(\) \{\s+const refocus = panelFocus\.closing\(nodeEls\.get\(selected\)\);\s+selected = null;[^}]*?OVUsage\.onSelect\(\);\s+refocus\(\);\s+\}/);
  assert.ok(page.indexOf('src="/panel-focus.js"') > 0 && page.indexOf('src="/panel-focus.js"') < page.indexOf('src="/map.js"'));
  assert.match(page, /<aside class="panel"[^>]* aria-label="[^"]+"/);
  assert.match(page, /\.p-x:focus-visible \{ outline: 2px solid/);
});
