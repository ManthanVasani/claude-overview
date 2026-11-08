'use strict';

const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'overview');

// the script finds its server by its own folder, so a copy runs a stand-in that never touches the real board
function copy(t, onTerm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'overview'));
  fs.chmodSync(path.join(dir, 'overview'), 0o755);
  fs.writeFileSync(path.join(dir, 'server.js'), 'setInterval(() => {}, 1000);\nprocess.on("SIGTERM", () => { ' + onTerm + ' });\n');
  const run = (cmd) => cp.spawnSync('bash', [path.join(dir, 'overview'), cmd], { encoding: 'utf8', timeout: 20000 });
  t.after(() => {
    const pid = /pid (\d+)/.exec(run('status').stdout);
    if (pid) process.kill(Number(pid[1]), 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return run;
}

const pidOf = (r) => Number(/pid (\d+)/.exec(r.stdout)[1]);

test('stop returns once the server has closed, so a start right after it starts a new one', { skip: process.platform === 'win32' && 'the script is bash' }, (t) => {
  const run = copy(t, 'setTimeout(() => process.exit(0), 1000);');
  const first = run('start');
  assert.match(first.stdout, /^Started \(pid \d+\)/);
  const stop = run('stop');
  assert.deepEqual([stop.status, stop.stdout.trim()], [0, 'Stopped (pid ' + pidOf(first) + ')']);
  const again = run('start');
  assert.match(again.stdout, /^Started \(pid \d+\)/);
  assert.notEqual(pidOf(again), pidOf(first));
  assert.equal(run('stop').status, 0);
  assert.equal(run('status').stdout.trim(), 'Not running');
});

test('stop says so and fails when the server is still running after the wait', { skip: process.platform === 'win32' && 'the script is bash' }, (t) => {
  const run = copy(t, '');
  const first = run('start');
  const stop = run('stop');
  assert.deepEqual([stop.status, stop.stdout.trim()], [1, 'Still closing (pid ' + pidOf(first) + '): run stop again in a moment']);
  assert.match(run('status').stdout, /^Running \(pid \d+\)/);
});
