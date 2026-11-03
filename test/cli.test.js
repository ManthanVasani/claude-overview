'use strict';

const assert = require('node:assert/strict');
const cp = require('child_process');
const path = require('path');
const test = require('node:test');
const { version } = require('../package.json');

const SERVER = path.join(__dirname, '..', 'server.js');
const LIB = path.join(__dirname, '..', 'lib') + path.sep;
const run = (args, env) => cp.spawnSync(process.execPath, [SERVER, ...args], { encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, env) });

test('--version and -v print the version', () => {
  for (const a of ['--version', '-v']) {
    const r = run([a]);
    assert.deepEqual([r.status, r.stdout.trim()], [0, version]);
  }
});

test('--help and -h print the usage with the port', () => {
  for (const a of ['--help', '-h']) {
    const r = run([a], { CLAUDE_OVERVIEW_PORT: '3999' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage: claude-overview\n.*127\.0\.0\.1:3999/);
  }
});

test('an unknown argument exits 1 with the usage', () => {
  const r = run(['--nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Unknown argument: --nope\nUsage: claude-overview/);
});

test('a port that is not a port number exits 1 before anything starts', () => {
  for (const port of ['0', '70000', 'abc', '31.5']) {
    const r = run([], { CLAUDE_OVERVIEW_PORT: port });
    assert.equal(r.status, 1, port);
    assert.match(r.stderr, /CLAUDE_OVERVIEW_PORT must be a port number/);
  }
});

test('--version loads none of the server but its config', () => {
  const probe = "process.on('exit', () => console.error(JSON.stringify(Object.keys(require.cache).filter((f) => f.startsWith(" + JSON.stringify(LIB) + ")).map((f) => require('path').basename(f))))); process.argv[2] = '--version'; require(process.argv[1]);";
  const r = cp.spawnSync(process.execPath, ['-e', probe, SERVER], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.stdout.trim(), version);
  assert.deepEqual(JSON.parse(r.stderr), ['config.js']);
});
