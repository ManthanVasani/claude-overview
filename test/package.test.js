'use strict';

const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { Board, SERVER_TEST_MS } = require('./helpers/board');
const { version } = require('../package.json');

const ROOT = path.join(__dirname, '..');

test('the published package runs on its own files', { timeout: SERVER_TEST_MS }, async (t) => {
  // hooks run in the order they are added, and the server must stop before its files go
  const b = new Board('packed-');
  t.after(() => b.stop());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pack = cp.spawnSync('npm', ['pack', '--json', '--pack-destination', dir], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const [{ filename, files }] = JSON.parse(pack.stdout);
  const shipped = files.map((f) => f.path);
  for (const f of ['server.js', 'lib/feed.js', 'lib/usage-scan.js', 'public/index.html', 'public/vendor/d3.min.js', 'public/vendor/d3-LICENSE']) assert.ok(shipped.includes(f), f + ' is not in the package');
  assert.deepEqual(shipped.filter((f) => f.startsWith('test/')), []);
  const tar = cp.spawnSync('tar', ['-xzf', path.join(dir, filename), '-C', dir]);
  assert.equal(tar.status, 0, String(tar.stderr));
  const server = path.join(dir, 'package', 'server.js');

  const v = cp.spawnSync(process.execPath, [server, '--version'], { encoding: 'utf8' });
  assert.equal(v.stdout.trim(), version);

  await b.start({ server });
  for (const p of ['/', '/map.js', '/live.js', '/usage-ui.js', '/alerts.js', '/vendor/d3.min.js', '/state.json', '/usage']) {
    assert.equal((await b.get(p)).status, 200, p);
  }
  assert.equal(b.errors, '');
});
