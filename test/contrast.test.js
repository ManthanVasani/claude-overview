'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');

function rules() {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const sel = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (depth && j < css.length) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    if (!sel.startsWith('@')) {
      const decls = {};
      for (const d of css.slice(open + 1, j - 1).split(';')) {
        const k = d.indexOf(':');
        if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
      }
      out.push({ sels: sel.split(',').map((x) => x.trim()), decls });
    }
    i = j;
  }
  return out;
}
const RULES = rules();

function decl(sel, prop) {
  let v;
  for (const r of RULES) if (r.sels.includes(sel) && prop in r.decls) v = r.decls[prop];
  return v;
}

function resolve(v, scope) {
  const m = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(v);
  if (!m) return v;
  const own = scope[m[1]] || decl(':root', m[1]);
  if (own) return resolve(own, scope);
  return m[2] ? resolve(m[2], scope) : undefined;
}

function rgb(h) {
  assert.match(String(h), /^#[0-9a-f]{6}$/i, 'not a colour this check can read: ' + h);
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const over = (c, a, base) => c.map((v, i) => v * a + base[i] * (1 - a));
function lum(c) {
  const [r, g, b] = c.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const STATES = [...new Set(RULES.filter((r) => '--c' in r.decls).flatMap((r) => r.sels)
  .map((s) => /^\.c-([\w-]+)$/.exec(s)).filter(Boolean).map((m) => m[1]))].filter((st) => st !== 'more');
const card = rgb(resolve('var(--card)', {}));
const hovered = rgb(resolve(decl('.card:hover', 'background'), {}));
const panel = rgb(resolve(decl('.panel', 'background'), {}));

function cardsOf(st) {
  const bg = decl('.c-' + st + ' > .card', 'background');
  if (!bg) return [card];
  if (!bg.includes('gradient')) return [rgb(resolve(bg, {}))];
  assert.match(bg, /^linear-gradient\((?:[^()]|rgba\([^()]*\))*\), var\(--card\)$/, 'not a card background this check can read: ' + bg);
  const stops = [...bg.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g)];
  assert.ok(stops.length, 'no stops in ' + bg);
  return stops.map((m) => over(m.slice(1, 4).map(Number), Number(m[4]), card));
}

test('a status label meets 4.5:1 in every state, on cards and in the details panel', () => {
  for (const st of ['working', 'needs-you', 'error', 'lost', 'done', 'ended']) assert.ok(STATES.includes(st), st);
  assert.match(decl('.chip', 'background'), /^color-mix\(in srgb, var\(--c\) \d+%, transparent\)$/);
  const tint = Number(/(\d+)%/.exec(decl('.chip', 'background'))[1]) / 100;
  const chipColour = RULES.filter((r) => 'color' in r.decls && r.sels.some((x) => /\.chip\b/.test(x)));
  assert.deepEqual(chipColour.map((r) => r.sels.join(', ')), ['.chip']);
  const ctHolders = RULES.filter((r) => '--ct' in r.decls).flatMap((r) => r.sels);
  assert.deepEqual(ctHolders.filter((x) => !/^\.(node|p-state)\.c-[\w-]+$/.test(x)), []);
  const low = [];
  for (const st of STATES) {
    const c = resolve(decl('.c-' + st, '--c'), {});
    for (const [where, holder, bases] of [['card', '.node', [...cardsOf(st), hovered]], ['panel', '.p-state', [panel]]]) {
      const ct = decl(holder + '.c-' + st, '--ct');
      const text = rgb(resolve(decl('.chip', 'color'), { '--c': c, '--ct': ct }));
      for (const base of bases) {
        const r = ratio(text, over(rgb(c), tint, base));
        if (!(r >= 4.5)) low.push(st + ' on the ' + where + ' ' + r.toFixed(2));
      }
    }
  }
  assert.deepEqual(low, []);
});

test('the result of a failed or killed background command meets 4.5:1 when its row is hovered', () => {
  for (const st of ['failed', 'died']) {
    const text = rgb(resolve(decl('.c-' + st + ' > .shell .tm', 'color'), {}));
    const base = rgb(resolve(decl('.shell:hover', 'background'), {}));
    assert.ok(ratio(text, base) >= 4.5, st + ' ' + ratio(text, base).toFixed(2));
  }
});
