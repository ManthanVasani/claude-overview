'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// strvis is in libc on macOS and in libbsd on Linux
function buildOracle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strvis-'));
  const out = path.join(dir, 'oracle');
  const src = path.join(__dirname, 'strvis-oracle.c');
  for (const lib of [[], ['-lbsd'], ['-l:libbsd.so.0']]) {
    const r = cp.spawnSync('cc', ['-o', out, src, ...lib], { encoding: 'utf8' });
    if (r.status === 0) return { run: (strings) => runOracle(out, strings), dir };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return null;
}

function runOracle(bin, strings) {
  const input = strings.map((s) => Buffer.from(s, 'utf8').toString('hex')).join('\n') + '\n';
  const out = cp.execFileSync(bin, { input, env: { LC_ALL: 'C' }, maxBuffer: 1 << 28 }).toString('latin1');
  return out.split('\n').slice(0, strings.length);
}

module.exports = { buildOracle };
