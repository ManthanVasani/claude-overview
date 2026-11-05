'use strict';

// fs is patched in the worker's own thread, which a test's patch cannot reach
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { systemError } = require('./system-error');

const { name, as, once, cut } = workerData.fail;
const fds = new Map();
const { openSync, closeSync, readSync } = fs;
const now = Date.now;
let shift = 0;
let reads = 0;
let regrow = null;

// so a test need not wait for the scanner's next walk
Date.now = () => now() + shift;
parentPort.on('message', (m) => { shift += m.shift; });
fs.openSync = (p, ...rest) => {
  const ours = path.basename(String(p)) === name;
  if (ours && (as === 'eacces' || as === 'enoent')) {
    parentPort.postMessage({ reads: ++reads });
    throw as === 'eacces' ? systemError('EACCES', -13, 'open') : systemError('ENOENT', -2, 'open');
  }
  const fd = openSync(p, ...rest);
  if (ours) fds.set(fd, String(p));
  return fd;
};
fs.closeSync = (fd) => {
  fds.delete(fd);
  return closeSync(fd);
};
fs.readSync = (fd, ...rest) => {
  if (regrow && fds.has(fd)) {
    // regrown after the read hit the cut end and before the scanner's second fstat
    fs.writeFileSync(fds.get(fd), regrow);
    regrow = null;
    return 0;
  }
  if (!fds.has(fd) || (once && reads)) return readSync(fd, ...rest);
  parentPort.postMessage({ reads: ++reads });
  if (as === 'half') return readSync(fd, rest[0], rest[1], Math.max(1, rest[2] >> 1), rest[3]);
  if (as === 'empty') return 0;
  if (as === 'cut' || as === 'regrow') {
    if (as === 'regrow') regrow = fs.readFileSync(fds.get(fd));
    fs.truncateSync(fds.get(fd), cut);
    return readSync(fd, ...rest);
  }
  if (as === 'bug') throw new RangeError('The value of "position" is out of range');
  throw systemError('EIO', -5, 'read');
};

require('../../lib/usage-scan');
