'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { Tail } = require('../lib/files');
const { histPoll } = require('../lib/steps');

function withReads(fail, fn) {
  const readSync = fs.readSync;
  fs.readSync = () => { throw fail(); };
  try { return fn(); } finally { fs.readSync = readSync; }
}

function ioError() {
  const e = new Error('EIO: i/o error, read');
  e.code = 'EIO';
  return e;
}

function transcript() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'read-errors-')), 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } }) + '\n');
  return file;
}

test('a history read that fails ends that file and the next file is still read', () => {
  const bad = transcript();
  const good = transcript();
  const files = [bad, good].map((file) => ({ file, backFrom: fs.statSync(file).size, owner: null, conv: {}, S: {} }));
  withReads(ioError, () => assert.doesNotThrow(() => histPoll(files.slice(0, 1), Date.now())));
  assert.doesNotThrow(() => histPoll(files, Date.now()));
});

test('the transcript reader passes on an error that is not a file error', () => {
  const tail = new Tail(transcript(), 1 << 20);
  withReads(() => new TypeError('not a file error'), () => assert.throws(() => tail.read(), TypeError));
});
