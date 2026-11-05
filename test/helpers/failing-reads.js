'use strict';

// fs is patched in the worker's own thread, which a test's patch cannot reach
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const { systemError } = require('./system-error');

const { name, as, once } = workerData.fail;
const fds = new Set();
const { openSync, closeSync, readSync } = fs;
const now = Date.now;
let shift = 0;
let reads = 0;

// so a test need not wait for the scanner's next walk
Date.now = () => now() + shift;
parentPort.on('message', (m) => { shift += m.shift; });
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
  if (as === 'half') return readSync(fd, rest[0], rest[1], Math.max(1, rest[2] >> 1), rest[3]);
  if (as === 'empty') return 0;
  if (as === 'bug') throw new RangeError('The value of "position" is out of range');
  throw systemError('EIO', -5, 'read');
};

require('../../lib/usage-scan');
