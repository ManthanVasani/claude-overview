'use strict';

require('./helpers/darwin');
const assert = require('node:assert/strict');
const fs = require('fs');
const test = require('node:test');
const { PROC_FS } = require('../lib/config');
const { psText } = require('../lib/procs');
const { appleVis } = require('./helpers/apple-vis');
const { rng, takesFor } = require('./helpers/foreground-cases');
const { buildOracle } = require('./helpers/strvis');
const table = require('./fixtures/strvis.json');

const PIECES = ['echo ', 'grep ', "'", '"', '\\', ' ', '\t', '\n', 'M-', 'M^', '^', 'ç', 'で', '§', '¢', 'é', 'ܐ', '😀', '“', ' ', '\u007f', '\u0007', '\\012', 'x', 'y', '$HOME', '<', '|', 'a b'];

function commands(seed, count) {
  const r = rng(seed);
  const out = [];
  for (let k = 0; k < count; k++) {
    let cmd = r.pick(['echo ', 'grep ', 'make ']);
    for (let n = Math.floor(r() * 8); n >= 0; n--) cmd += r.pick(PIECES);
    out.push(cmd);
  }
  return out;
}

function anyText(seed, count) {
  const r = rng(seed);
  const out = [];
  for (let k = 0; k < count; k++) {
    let s = '';
    for (let n = 1 + Math.floor(r() * 12); n > 0; n--) {
      const range = r.pick([[1, 0x7f], [0x80, 0x7ff], [0x800, 0xd7ff], [0x10000, 0x10ffff]]);
      s += String.fromCodePoint(range[0] + Math.floor(r() * (range[1] - range[0] + 1)));
    }
    out.push(s);
  }
  return out;
}

test('the macOS process path is the one under test', () => {
  assert.equal(PROC_FS, false);
});

test('the reference encoder prints every byte as the C library strvis does', () => {
  for (let b = 1; b < 256; b++) assert.equal(appleVis(Buffer.from([b])), table.bytes[b], 'byte ' + b);
});

test("the board's encoder prints what the C library printed for each sample", () => {
  for (const [s, out] of table.samples) assert.equal(psText(s), out, JSON.stringify(s));
});

test("the board's encoder agrees with the reference encoder on any text", () => {
  for (const s of anyText(5, 20000)) assert.equal(psText(s), appleVis(s), JSON.stringify(s));
});

test("the board's encoder agrees with this machine's strvis", (t) => {
  const oracle = buildOracle();
  // CI always has one, so a missing one there is a broken check, not a skip
  if (!oracle && !process.env.CI) return t.skip('no C compiler with strvis here (libbsd-dev on Linux)');
  assert.ok(oracle, 'no C compiler with strvis');
  try {
    const strings = anyText(9, 5000).concat(commands(9, 5000));
    const got = oracle.run(strings);
    strings.forEach((s, i) => assert.equal(psText(s), got[i], JSON.stringify(s)));
  } finally {
    fs.rmSync(oracle.dir, { recursive: true, force: true });
  }
});

test("a call's shell is found in ps's text for every command Claude Code quotes", () => {
  for (const cmd of commands(3, 20000)) assert.ok(takesFor(cmd, cmd, true), JSON.stringify(cmd));
});

test("a shell is never taken for another call's command that ps prints differently", () => {
  const list = commands(4, 2000);
  const r = rng(4);
  let compared = 0;
  for (const a of list) {
    for (let k = 0; k < 20; k++) {
      const b = r.pick(list);
      if (psText(a) === psText(b)) continue;
      compared++;
      assert.ok(!takesFor(a, b, true), JSON.stringify([a, b]));
    }
  }
  assert.ok(compared > 30000);
});
