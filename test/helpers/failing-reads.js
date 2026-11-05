'use strict';

// fs is patched in the worker's own thread, which a test's patch cannot reach
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const { name, as, once } = workerData.fail;
const fds = new Set();
const { openSync, closeSync, readSync } = fs;
const now = Date.now;
let shift = 0;
let reads = 0;

Date.now = () => now() + shift;
fs.openSync = (p, ...rest) => {
  const fd = openSync(p, ...rest);
  if (path.basename(String(p)) === name) fds.add(fd);
  return fd;
};
fs.closeSync = (fd) => {
  fds.delete(fd);
  return closeSync(fd);
};
fs.readSync = (fd, ...rest) => {
  if (!fds.has(fd) || (once && reads)) return readSync(fd, ...rest);
  parentPort.postMessage({ reads: ++reads });
  // a test cannot wait for the scanner's next walk
  if (once) shift = 2 * 60000;
  if (as === 'half') return readSync(fd, rest[0], rest[1], Math.max(1, rest[2] >> 1), rest[3]);
  if (as === 'empty') return 0;
  if (as === 'bug') throw new RangeError('The value of "position" is out of range');
  throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO', errno: -5, syscall: 'read' });
};

require('../../lib/usage-scan');
