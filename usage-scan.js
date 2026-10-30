'use strict';

// Per-file totals and read offsets persist in the index, so a restart reads only what was appended after the last save.
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const ROOT = workerData.root;
const INDEX = workerData.index;
const SEED = workerData.seed;
const VERSION = 1;
const SLICE = 8 << 20;
const MAX_LINE = 128 << 20;
const SLICES_PER_TICK = 4;
const WALK_BUSY_MS = 60000;
const WALK_IDLE_MS = 30000;
const REPORT_MS = 5000;
const SAVE_BUSY_MS = 60000;
const SAVE_IDLE_MS = 10 * 60000;
const HOURS_KEEP_MS = 8 * 864e5;
const RECENT_IDS = 24;
const RECENT_IDLE_MS = 3600000;
const TMP_STALE_MS = 3600000;

let files = {};
let queue = [];
let lastWalk = 0;
let lastReport = 0;
let lastSave = Date.now();
let changed = true;
let unsaved = false;
let scanned = false;

function pad(n) { return n < 10 ? '0' + n : String(n); }
function dayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function hourKey(t) { const d = new Date(t); return dayKey(t) + 'T' + pad(d.getHours()); }

function readFiles(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && d.v === VERSION && d.files ? d.files : null;
  } catch (e) { /* first run, no clone index, or unreadable */ return null; }
}

function load() {
  // a save that does not finish leaves its temporary file behind
  try {
    const dir = path.dirname(INDEX);
    const pre = path.basename(INDEX) + '.';
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (f.startsWith(pre) && f.endsWith('.tmp') && Date.now() - fs.statSync(p).mtimeMs > TMP_STALE_MS) fs.unlinkSync(p);
    }
  } catch (e) { /* left for the next start */ }
  files = readFiles(INDEX);
  if (!files) {
    files = {};
    // an unreadable index can be the only record of deleted transcripts
    if (fs.existsSync(INDEX)) {
      const aside = INDEX + '.unreadable-' + Date.now();
      try {
        fs.renameSync(INDEX, aside);
        parentPort.postMessage({ notice: 'Could not read the usage totals, so they start again. The old file is kept at ' + aside });
      } catch (e) { parentPort.postMessage({ notice: 'Could not keep the unreadable usage totals: ' + e.message }); }
    }
  }
  // a clone's old index holds totals of transcripts deleted since, and may be from another Claude folder
  const seed = readFiles(SEED) || {};
  for (const p in seed) {
    const had = files[p];
    if (!p.startsWith(ROOT + path.sep) || (had && (had.ino !== seed[p].ino || had.off >= seed[p].off))) continue;
    files[p] = seed[p];
    unsaved = true;
  }
}
function save() {
  const now = Date.now();
  for (const p in files) {
    const r = files[p];
    // a file not fully read still needs them, however old it is
    if (r.recent.length && r.off >= r.size && now - r.mtime > RECENT_IDLE_MS) r.recent = [];
  }
  // two servers on different ports can share the index
  const tmp = INDEX + '.' + process.pid + '.tmp';
  try {
    // it holds project paths and session titles
    fs.mkdirSync(path.dirname(INDEX), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, files }), { mode: 0o600 });
    fs.renameSync(tmp, INDEX);
    unsaved = false;
  } catch (e) { parentPort.postMessage({ notice: 'Could not save the usage totals: ' + e.message }); }
  lastSave = now;
}

function blank(p, ino) {
  // <project>/<sid>.jsonl, or <project>/<sid>/subagents/... for its agents and workflow agents
  const rel = path.relative(ROOT, p).split(path.sep);
  const sid = rel.length === 2 ? path.basename(rel[1], '.jsonl') : rel[1];
  return { ino, size: 0, off: 0, mtime: 0, wait: -1, sid, agent: rel.length > 2, cwd: '', title: '', tk: 0, days: {}, hours: {}, recent: [] };
}

// A file reachable by several paths (hard links) or moved is counted once, under one path.
function walk() {
  const found = new Map();
  (function rec(dir, depth) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 6) rec(p, depth + 1); }
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { found.set(p, fs.statSync(p)); } catch (err) { /* removed while walking */ }
      }
    }
  })(ROOT, 0);
  const groups = new Map();
  for (const [p, st] of found) {
    const k = st.dev + ':' + st.ino;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  for (const [k, paths] of groups) {
    paths.sort();
    const canon = paths.find((p) => files[p] && files[p].ino === k && !files[p].alias) || paths[0];
    for (const p of paths) {
      const st = found.get(p);
      if (!files[p] || files[p].ino !== k) { files[p] = blank(p, k); changed = true; }
      const r = files[p];
      r.gone = false;
      r.alias = p === canon ? null : canon;
      r.size = st.size;
      r.mtime = st.mtimeMs;
    }
  }
  for (const p in files) {
    const r = files[p];
    if (found.has(p)) continue;
    r.gone = true;
    const g = groups.get(r.ino);
    // a deleted file's inode can go to an unrelated file; only the same transcript at another path is a move
    const to = g && !r.alias && g.find((q) => !files[q].alias && files[q].sid === r.sid && path.basename(q) === path.basename(p));
    if (to) { r.alias = to; changed = true; }
  }
  const cutoff = Date.now() - HOURS_KEEP_MS;
  const cutKey = hourKey(cutoff);
  for (const p in files) {
    const h = files[p].hours;
    for (const k in h) if (k < cutKey) delete h[k];
  }
  // newest first, so today's numbers settle before the backlog
  queue = Object.keys(files).filter((p) => eligible(files[p])).sort((a, b) => files[b].mtime - files[a].mtime);
  lastWalk = Date.now();
}
function eligible(r) { return !r.gone && !r.alias && r.size > r.off && r.wait !== r.size; }

function bump(r, t, model, v, n) {
  const day = dayKey(t);
  const dm = r.days[day] || (r.days[day] = {});
  const a = dm[model] || (dm[model] = [0, 0, 0, 0, 0]);
  a[0] += n;
  for (let i = 0; i < 4; i++) a[i + 1] += v[i];
  if (t >= Date.now() - HOURS_KEEP_MS) {
    const hk = hourKey(t);
    const hm = r.hours[hk] || (r.hours[hk] = {});
    const b = hm[model] || (hm[model] = [0, 0, 0, 0, 0]);
    b[0] += n;
    for (let i = 0; i < 4; i++) b[i + 1] += v[i];
  }
  changed = true;
}

function handle(r, line) {
  if (line.length < 8192 && (line.indexOf('"custom-title"') >= 0 || line.indexOf('"ai-title"') >= 0)) {
    let d;
    try { d = JSON.parse(line); } catch (e) { return; }
    if (d.type === 'custom-title' && (d.customTitle || d.title)) { r.title = String(d.customTitle || d.title); r.tk = 2; changed = true; }
    else if (d.type === 'ai-title' && d.aiTitle && r.tk < 2) { r.title = String(d.aiTitle); r.tk = 1; changed = true; }
    if (d.type === 'custom-title' || d.type === 'ai-title') return;
  }
  if (line.indexOf('"usage"') < 0 || line.indexOf('"assistant"') < 0) return;
  let d;
  try { d = JSON.parse(line); } catch (e) { return; }
  const m = d && d.type === 'assistant' && d.message;
  const u = m && m.usage;
  if (!u) return;
  if (!r.cwd && d.cwd) r.cwd = d.cwd;
  const model = m.model || 'unknown';
  if (model === '<synthetic>') return;
  const t = Date.parse(d.timestamp);
  if (!t) return;
  const v = [u.input_tokens || 0, u.output_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0];
  if (!v[0] && !v[1] && !v[2] && !v[3]) return;
  const id = m.id || d.requestId || d.uuid;
  // one message is written as several lines that repeat its usage, so only growth past the first line counts
  const prev = id && r.recent.find((x) => x[0] === id);
  if (prev) {
    const add = v.map((x, i) => Math.max(0, x - prev[3 + i]));
    if (!add.some(Boolean)) return;
    for (let i = 0; i < 4; i++) prev[3 + i] = Math.max(prev[3 + i], v[i]);
    bump(r, prev[1], prev[2], add, 0);
    return;
  }
  r.recent.push([id, t, model, v[0], v[1], v[2], v[3]]);
  if (r.recent.length > RECENT_IDS) r.recent.shift();
  bump(r, t, model, v, 1);
}

function readSlice(p) {
  const r = files[p];
  let fd;
  try { fd = fs.openSync(p, 'r'); } catch (e) { r.gone = true; return; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < r.off) {
      // rewritten shorter: count it again from the start
      Object.assign(r, { off: 0, days: {}, hours: {}, recent: [], title: '', tk: 0 });
      changed = true;
    }
    r.size = size;
    if (size <= r.off) return;
    let want = Math.min(SLICE, size - r.off);
    let buf;
    let n;
    let cut;
    for (;;) {
      buf = Buffer.allocUnsafe(want);
      n = fs.readSync(fd, buf, 0, want, r.off);
      cut = buf.lastIndexOf(10, n - 1);
      if (cut >= 0 || r.off + n >= size || want >= MAX_LINE) break;
      want = Math.min(want * 2, MAX_LINE, size - r.off);
    }
    if (cut < 0) {
      // an unfinished last line waits for the file to grow; a line past MAX_LINE is skipped
      if (r.off + n >= size) r.wait = size;
      else { r.off += n; unsaved = true; }
      return;
    }
    const text = buf.toString('utf8', 0, cut);
    r.off += cut + 1;
    r.wait = -1;
    unsaved = true;
    let i = 0;
    while (i < text.length) {
      let j = text.indexOf('\n', i);
      if (j < 0) j = text.length;
      if (j > i) handle(r, text.slice(i, j));
      i = j + 1;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function add(map, key, a) {
  const b = map[key] || (map[key] = [0, 0, 0, 0, 0]);
  for (let i = 0; i < 5; i++) b[i] += a[i];
}
function summary() {
  const days = {};
  const hours = {};
  const sess = {};
  let total = 0;
  let read = 0;
  let pending = 0;
  for (const p in files) {
    const r = files[p];
    if (r.alias) continue;
    if (!r.gone) {
      total += r.size;
      read += Math.min(r.off, r.size);
      if (r.size > r.off && r.wait !== r.size) pending++;
    }
    const s = sess[r.sid] || (sess[r.sid] = { t: '', c: '', l: 0, k: -1 });
    if (r.title && (!r.agent || !s.t) && r.tk >= s.k) { s.t = r.title; s.k = r.tk; }
    if (r.cwd && (!r.agent || !s.c)) s.c = r.cwd;
    s.l = Math.max(s.l, r.mtime);
    for (const day in r.days) {
      const D = days[day] || (days[day] = { m: {}, p: {}, s: {}, ag: [0, 0, 0, 0, 0] });
      for (const model in r.days[day]) {
        const a = r.days[day][model];
        add(D.m, model, a);
        add(D.p, r.cwd || '', a);
        add(D.s, r.sid, a);
        if (r.agent) for (let i = 0; i < 5; i++) D.ag[i] += a[i];
      }
    }
    for (const hk in r.hours) {
      const H = hours[hk] || (hours[hk] = {});
      for (const model in r.hours[hk]) add(H, model, r.hours[hk][model]);
    }
  }
  for (const sid in sess) {
    sess[sid] = { t: sess[sid].t, c: sess[sid].c, l: sess[sid].l };
  }
  return { days, hours, sess, progress: { total, read, pending, files: Object.keys(files).length }, at: Date.now() };
}

function tick() {
  const now = Date.now();
  if (now - lastWalk > (queue.length ? WALK_BUSY_MS : WALK_IDLE_MS)) walk();
  let n = SLICES_PER_TICK;
  while (n > 0 && queue.length) {
    const p = queue[0];
    if (!files[p] || !eligible(files[p])) { queue.shift(); continue; }
    readSlice(p);
    n--;
  }
  if (changed && now - lastReport > REPORT_MS) {
    parentPort.postMessage(summary());
    lastReport = now;
    changed = false;
  }
  // a foreground run is often stopped soon after its first scan ends
  const first = !scanned && !queue.length;
  if (first) scanned = true;
  if (unsaved && (first || now - lastSave > (queue.length ? SAVE_BUSY_MS : SAVE_IDLE_MS))) save();
  setTimeout(tick, queue.length ? 25 : 2000);
}

load();
walk();
parentPort.postMessage(summary());
tick();
