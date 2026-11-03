'use strict';

const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const LIB = path.join(__dirname, '..', 'lib');
// a Worker's entry, which reads its workerData on load
const WORKER = 'usage-scan.js';
const MODULES = fs.readdirSync(LIB).filter((f) => f.endsWith('.js') && f !== WORKER);

function localRequires(file) {
  const src = fs.readFileSync(path.join(LIB, file), 'utf8');
  return [...src.matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1] + '.js');
}

test('no module requires one that leads back to it', () => {
  const graph = new Map(MODULES.map((f) => [f, localRequires(f)]));
  const state = new Map();
  const visit = (f, trail) => {
    if (state.get(f) === 'done') return;
    assert.notEqual(state.get(f), 'open', 'a cycle: ' + trail.concat(f).join(' -> '));
    state.set(f, 'open');
    for (const d of graph.get(f)) {
      assert.ok(graph.has(d), f + ' requires ' + d + ', which is not in lib');
      visit(d, trail.concat(f));
    }
    state.set(f, 'done');
  };
  for (const f of MODULES) visit(f, []);
});

test('each module loads alone and leaves nothing running', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modules-'));
  try {
    const env = Object.assign({}, process.env, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude') });
    for (const f of MODULES) {
      const r = cp.spawnSync(process.execPath, ['-e', 'require(process.argv[1])', path.join(LIB, f)], { env, timeout: 10000, encoding: 'utf8' });
      assert.equal(r.status, 0, f + ': ' + (r.error || r.stderr));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
