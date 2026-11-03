'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { Tail } = require('../lib/files');
const log = require('../lib/log');
const { backfillTasks } = require('../lib/shells');
const { histPoll, stepRows } = require('../lib/steps');

function withReads(fail, fn) {
  const readSync = fs.readSync;
  fs.readSync = (...args) => {
    const e = fail();
    if (e) throw e;
    return readSync(...args);
  };
  try { return fn(); } finally { fs.readSync = readSync; }
}

function once(make) {
  let used = false;
  return () => {
    if (used) return null;
    used = true;
    return make();
  };
}

function systemError(code, errno, syscall) {
  return Object.assign(new Error(code + ': ' + syscall), { code, errno, syscall });
}

const ioError = () => systemError('EIO', -5, 'read');
const argError = () => Object.assign(new RangeError('The value of "position" is out of range'), { code: 'ERR_OUT_OF_RANGE' });

function transcript(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, entries.map((d) => JSON.stringify(d) + '\n').join(''));
  return file;
}

const prompt = () => ({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } });
const call = (id) => ({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } }] } });
const histFile = (file, sid) => ({ file, backFrom: fs.statSync(file).size, owner: null, conv: {}, S: { id: sid } });

test('the history reader goes on to the next file after a read that fails', (t) => {
  const files = [histFile(transcript(t, [call('toolu_bad')]), 'bad'), histFile(transcript(t, [call('toolu_good')]), 'good')];
  withReads(once(ioError), () => histPoll(files, Date.now()));
  assert.deepEqual(stepRows(0).map((r) => r[1]), ['good']);
});

test('the history reader passes on an error that is not a file error', (t) => {
  const files = [histFile(transcript(t, [call('toolu_bug')]), 'bug')];
  withReads(argError, () => assert.throws(() => histPoll(files, Date.now()), RangeError));
});

test('the search for a shell launch passes on an error that is not a file error', (t) => {
  const S = { tasks: new Map([['b1', { id: 'b1', needsInfo: true, tried: false, seenRunning: true }]]), backfillAt: 0 };
  const transcripts = [{ file: transcript(t, [prompt()]), owner: null }];
  withReads(argError, () => assert.throws(() => backfillTasks(S, Date.now(), transcripts), RangeError));
});

test('the transcript reader passes on an error that is not a file error', (t) => {
  const tail = new Tail(transcript(t, [prompt()]), 1 << 20);
  withReads(argError, () => assert.throws(() => tail.read(), RangeError));
});

test('a transcript removed before it is opened counts as missing, not unreadable', (t) => {
  const tail = new Tail(transcript(t, [prompt()]), 1 << 20);
  const openSync = fs.openSync;
  const error = log.error;
  const logged = [];
  fs.openSync = () => { throw systemError('ENOENT', -2, 'open'); };
  log.error = (msg) => logged.push(msg);
  try { assert.deepEqual(tail.read(), []); } finally { fs.openSync = openSync; log.error = error; }
  assert.deepEqual(logged, []);
});
