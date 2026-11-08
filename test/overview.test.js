'use strict';

const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'overview');
// the script starts the node on PATH: this one, so each Node version under test runs it
const env = Object.assign({}, process.env, { PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// the script finds its server by its own folder, so a copy runs a stand-in that never touches the real board
function copy(t, onTerm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'overview'));
  fs.chmodSync(path.join(dir, 'overview'), 0o755);
  fs.writeFileSync(path.join(dir, 'server.js'), 'setInterval(() => {}, 1000);\nprocess.on("SIGTERM", () => { ' + onTerm + ' });\n');
  const run = (cmd) => cp.spawnSync('bash', [path.join(dir, 'overview'), cmd], { encoding: 'utf8', timeout: 20000, env });
  t.after(() => {
    // by the folder, so a script that cannot find its server still leaves nothing running
    const ps = cp.spawnSync('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'args='], { encoding: 'utf8' }).stdout;
    for (const line of ps.split('\n')) {
      const m = /^\s*(\d+)\s(.*)$/.exec(line);
      if (!m || !m[2].includes(dir)) continue;
      try { process.kill(Number(m[1]), 'SIGKILL'); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, run };
}

const pidOf = (r) => Number(/pid (\d+)/.exec(r.stdout)[1]);
const SLOW_EXIT = 'setTimeout(() => process.exit(0), 1000);';

test('stop returns once the server has closed, so a start right after it starts a new one', (t) => {
  const { run } = copy(t, SLOW_EXIT);
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

test('stop says so and fails when the server is still running after the wait', (t) => {
  const { run } = copy(t, '');
  const first = run('start');
  assert.match(first.stdout, /^Started \(pid \d+\)/);
  const stop = run('stop');
  const pid = pidOf(first);
  assert.deepEqual([stop.status, stop.stdout.trim()], [1, 'Still running after 5 s (pid ' + pid + '); kill -9 ' + pid + ' ends it']);
  assert.equal(run('status').stdout.trim(), 'Running (pid ' + pid + '): http://127.0.0.1:3100/');
});

test('stop waits only for the server it stopped, not for a copy started while it waits', async (t) => {
  const { dir, run } = copy(t, SLOW_EXIT);
  const first = run('start');
  assert.match(first.stdout, /^Started \(pid \d+\)/);
  const stopping = cp.spawn('bash', [path.join(dir, 'overview'), 'stop'], { env });
  let out = '';
  stopping.stdout.on('data', (d) => { out += d; });
  const done = new Promise((r) => stopping.on('close', r));
  await wait(300);
  const fresh = cp.spawn(process.execPath, [path.join(dir, 'server.js')], { stdio: 'ignore' });
  const code = await done;
  assert.deepEqual([code, out.trim()], [0, 'Stopped (pid ' + pidOf(first) + ')']);
  assert.equal(run('status').stdout.trim(), 'Running (pid ' + fresh.pid + '): http://127.0.0.1:3100/');
});

test('the server is found by its own arguments under this Node version, and a shell or an editor that names it is not', (t) => {
  const { dir, run } = copy(t, '');
  cp.spawn('bash', ['-c', 'sleep 30', 'x', '/usr/bin/node', path.join(dir, 'server.js')], { stdio: 'ignore' });
  cp.spawn('bash', ['-c', 'exec -a vim "$0" "$1"', process.execPath, path.join(dir, 'server.js')], { stdio: 'ignore' });
  cp.spawnSync('sleep', ['0.5']);
  assert.equal(run('status').stdout.trim(), 'Not running');
  const first = run('start');
  assert.match(first.stdout, /^Started \(pid \d+\)/);
  assert.equal(run('status').stdout.trim(), 'Running (pid ' + pidOf(first) + '): http://127.0.0.1:3100/');
});
