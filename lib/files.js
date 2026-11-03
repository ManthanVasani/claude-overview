'use strict';

const fs = require('fs');
const { MAX_READ_PER_POLL, MAX_PENDING_LINE, HEAD_BYTES, BACKFILL_CHUNK } = require('./constants');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function statMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function firstTimestamp(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const m = /"timestamp":"([^"]+)"/.exec(buf.toString('utf8', 0, n));
    const t = m ? Date.parse(m[1]) : NaN;
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; } finally { fs.closeSync(fd); }
}

function readFully(fd, buf, n, pos) {
  let got = 0;
  while (got < n) {
    const r = fs.readSync(fd, buf, got, n - got, pos + got);
    if (!r) break;
    got += r;
  }
  return got;
}

function readBack(fd, end, carry) {
  const n = Math.min(BACKFILL_CHUNK, end);
  const buf = Buffer.allocUnsafe(n);
  const got = readFully(fd, buf, n, end - n);
  const pos = end - n;
  const data = Buffer.concat([buf.subarray(0, got), carry]);
  if (pos === 0) return { pos, text: data.toString('utf8'), carry: Buffer.alloc(0) };
  const nl = data.indexOf(10);
  if (nl === -1) return { pos, text: null, carry: data.length > MAX_PENDING_LINE ? Buffer.alloc(0) : data };
  return { pos, text: data.toString('utf8', nl + 1), carry: Buffer.from(data.subarray(0, nl)) };
}

function lineStart(file, pos) {
  if (pos <= 0) return 0;
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return -1; }
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let end = pos; end > 0 && pos - end < MAX_PENDING_LINE;) {
      const n = Math.min(buf.length, end);
      const got = fs.readSync(fd, buf, 0, n, end - n);
      const i = got > 0 ? buf.lastIndexOf(10, got - 1) : -1;
      if (i >= 0) return end - n + i + 1;
      end -= n;
    }
    return pos >= MAX_PENDING_LINE ? -1 : 0;
  } catch { return -1; } finally { fs.closeSync(fd); }
}

class Tail {
  constructor(file, firstBytes) {
    this.file = file;
    this.firstBytes = firstBytes;
    this.offset = null;
    this.startOffset = 0;
    this.pending = null;
    this.ino = null;
    this.mtimeMs = 0;
  }

  read() {
    let st;
    try { st = fs.statSync(this.file); } catch { return []; }
    this.mtimeMs = st.mtimeMs;
    if (this.ino !== null && (st.ino !== this.ino || st.size < this.offset)) {
      this.offset = null;
      this.pending = null;
    }
    this.ino = st.ino;
    if (this.offset === null) {
      const from = Math.max(0, st.size - this.firstBytes);
      const at = lineStart(this.file, from);
      this.offset = at < 0 ? from : at;
      this.startOffset = this.offset;
      this.skipping = at < 0;
    }
    if (st.size <= this.offset) return [];
    const want = Math.min(st.size - this.offset, MAX_READ_PER_POLL);
    const buf = Buffer.allocUnsafe(want);
    let got;
    const fd = fs.openSync(this.file, 'r');
    try {
      got = readFully(fd, buf, want, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    const base = this.offset - (this.pending ? this.pending.length : 0);
    this.offset += got;
    const data = this.pending ? Buffer.concat([this.pending, buf.subarray(0, got)]) : buf.subarray(0, got);
    const nl = data.lastIndexOf(10);
    if (nl === -1) {
      this.pending = data.length > MAX_PENDING_LINE ? null : Buffer.from(data);
      return [];
    }
    this.pending = nl + 1 < data.length ? Buffer.from(data.subarray(nl + 1)) : null;
    const lines = data.subarray(0, nl).toString('utf8').split('\n');
    if (this.skipping) {
      this.skipping = false;
      // the history reader starts at startOffset, so it has to sit on a line boundary
      this.startOffset = base + data.indexOf(10) + 1;
      lines.shift();
    }
    const out = [];
    for (const line of lines) {
      if (!line || line.startsWith('{"type":"api-request')) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial or foreign line */ }
    }
    return out;
  }
}

module.exports = { readJson, statMs, fileSize, firstTimestamp, readBack, Tail };
