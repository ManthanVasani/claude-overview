'use strict';

const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'overview');
const OPTS = { skip: !['linux', 'darwin'].includes(process.platform) && 'the script runs on bash and ps' };
const URL = 'http://127.0.0.1:3999/';
// the script starts the node on PATH: this one, so each Node version under test runs it
const env = Object.assign({}, process.env, { PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH, CLAUDE_OVERVIEW_PORT: '3999' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// the script finds its server by its own folder, so a copy runs a stand-in that never touches the real board
function copy(t, onTerm) {
  // the script resolves its own folder, and macOS's temp folder is a symlink
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overview-')));
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
const SLOW_EXIT = 'require("fs").writeFileSync(__dirname + "/got-term", ""); setTimeout(() => process.exit(0), 1000);';

test('stop returns once the server has closed, so a start right after it starts a new one', OPTS, (t) => {
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

test('stop says so and fails when the server is still running after the wait', OPTS, (t) => {
  const { run } = copy(t, '');
  const first = run('start');
  assert.match(first.stdout, /^Started \(pid \d+\)/);
  const stop = run('stop');
  const pid = pidOf(first);
  assert.deepEqual([stop.status, stop.stdout.trim()], [1, 'Still running (pid ' + pid + '); kill -9 ' + pid + ' ends it']);
  assert.equal(run('status').stdout.trim(), 'Running (pid ' + pid + '): ' + URL);
});

test('stop counts a server that has exited as stopped while its parent has not yet collected it', OPTS, async (t) => {
  const { dir, run } = copy(t, 'process.exit(0);');
  const server = path.join(dir, 'server.js');
  // named for the server, so the cleanup by folder ends this parent too
  cp.spawn('bash', ['-c', '"$0" "$1" & exec -a "$1" sleep 30', process.execPath, server], { stdio: 'ignore' });
  let status;
  for (let i = 0; i < 100; i++) { await wait(50); status = run('status'); if (status.stdout.startsWith('Running')) break; }
  const pid = pidOf(status);
  const stop = run('stop');
  assert.deepEqual([stop.status, stop.stdout.trim()], [0, 'Stopped (pid ' + pid + ')']);
  assert.equal(run('status').stdout.trim(), 'Not running');
});

test('stop waits only for the server it stopped, not for a copy started while it waits', OPTS, async (t) => {
  const { dir, run } = copy(t, SLOW_EXIT);
  const first = run('start');
  assert.match(first.stdout, /^Started \(pid \d+\)/);
  const stopping = cp.spawn('bash', [path.join(dir, 'overview'), 'stop'], { env });
  let out = '';
  stopping.stdout.on('data', (d) => { out += d; });
  const done = new Promise((r) => stopping.on('close', r));
  for (let i = 0; i < 250 && !fs.existsSync(path.join(dir, 'got-term')); i++) await wait(20);
  const fresh = cp.spawn(process.execPath, [path.join(dir, 'server.js')], { stdio: 'ignore' });
  const code = await done;
  assert.deepEqual([code, out.trim()], [0, 'Stopped (pid ' + pidOf(first) + ')']);
  assert.equal(run('status').stdout.trim(), 'Running (pid ' + fresh.pid + '): ' + URL);
});

test('the server is found by its arguments under this Node version, and a shell or another program given its path is not', OPTS, async (t) => {
  const { dir, run } = copy(t, '');
  const server = path.join(dir, 'server.js');
  cp.spawn('bash', ['-c', 'while :; do sleep 1; done', 'x', '/usr/bin/node', server], { stdio: 'ignore' });
  cp.spawn('bash', ['-c', 'exec -a less "$0" "$1"', process.execPath, server], { stdio: 'ignore' });
  await wait(500);
  assert.equal(run('status').stdout.trim(), 'Not running');
  const first = run('start');
  assert.match(first.stdout, /^Started \(pid \d+\)/);
  assert.equal(run('status').stdout.trim(), 'Running (pid ' + pidOf(first) + '): ' + URL);
});
