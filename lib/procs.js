'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const { PROC_FS } = require('./config');
const { oneLine } = require('./text');

const CLK_TCK = 100;

let bootMs = readBootMs();
let psTable = new Map();
let psKids = new Map();

function readBootMs() {
  if (!PROC_FS) return 0;
  try {
    const m = /btime (\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8'));
    return m ? Number(m[1]) * 1000 : 0;
  } catch { return 0; }
}

function refreshProcs() {
  if (PROC_FS) {
    // btime moves when the wall clock is stepped, as WSL does after the host sleeps
    bootMs = readBootMs();
    return;
  }
  const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C', TZ: 'UTC' }), timeout: 5000, maxBuffer: 64 << 20 });
  // a failed listing keeps the last one, so live sessions do not flash to ended
  if (r.status !== 0 || !r.stdout) return;
  const table = new Map();
  const kids = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}) ?(.*)$/.exec(line);
    if (!m) continue;
    table.set(m[1], { ppid: m[2], token: m[3], start: Date.parse(m[3] + ' UTC'), cmd: m[4] });
    if (!kids.has(m[2])) kids.set(m[2], []);
    kids.get(m[2]).push(m[1]);
  }
  psTable = table;
  psKids = kids;
}

function procInfo(pid) {
  if (!PROC_FS) return psTable.get(String(pid)) || null;
  let s;
  try { s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); } catch { return null; }
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return { ppid: f[1], token: f[19], start: bootMs + Number(f[19]) * 1000 / CLK_TCK };
}

// procStart is what Claude Code recorded: the /proc start tick on Linux, ps's lstart (day space-padded) on macOS
function alive(pid, procStart) {
  const p = procInfo(pid);
  if (!p) return false;
  return procStart == null || p.token.replace(/\s+/g, ' ') === String(procStart).trim().replace(/\s+/g, ' ');
}

// Apple's ps prints each command through strvis(VIS_TAB | VIS_NL | VIS_NOSLASH), here in the C locale
function psText(s) {
  if (PROC_FS || typeof s !== 'string') return s;
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = b & 0x7f;
    if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else if (b === 0x09 || b === 0x0a || b === 0xa0) out += '\\' + b.toString(8).padStart(3, '0');
    else out += (b & 0x80 ? 'M' : '') + (c < 0x20 || c === 0x7f ? '^' + String.fromCharCode(c ^ 0x40) : '-' + String.fromCharCode(c));
  }
  return out;
}

function cmdOf(pid) {
  if (!PROC_FS) { const p = psTable.get(String(pid)); return p ? p.cmd : null; }
  try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' '); } catch { return null; }
}

// whole arguments, so a prompt that mentions -p is not the flag; ps only gives the joined line
function argsOf(pid) {
  if (!PROC_FS) return (cmdOf(pid) || '').split(' ').filter(Boolean);
  try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean); } catch { return []; }
}

// with --no-session-persistence a claude -p run writes no transcript
function headlessOf(pid) {
  const words = argsOf(pid);
  const i = words.findIndex((w) => w === '-p' || w === '--print');
  if (i < 0) return null;
  let j = i + 1;
  while (j < words.length && words[j][0] !== '-') j++;
  return { prompt: j > i + 1 ? oneLine(words.slice(i + 1, j).join(' '), 400) : null, kept: !words.includes('--no-session-persistence') };
}

// a background shell's stdout is its task output file
function stdoutOf(pids) {
  const out = new Map();
  if (!pids.length) return out;
  if (PROC_FS) {
    for (const pid of pids) {
      try { out.set(pid, fs.readlinkSync('/proc/' + pid + '/fd/1')); } catch { /* gone or not ours */ }
    }
    return out;
  }
  const r = spawnSync('lsof', ['-w', '-a', '-p', pids.join(','), '-d', '1', '-Fn'], { encoding: 'utf8', timeout: 5000 });
  let pid = null;
  for (const line of (r.stdout || '').split('\n')) {
    if (line[0] === 'p') pid = line.slice(1);
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1));
  }
  return out;
}

function childrenOf(pid) {
  if (!PROC_FS) return psKids.get(String(pid)) || [];
  const out = new Set();
  let tids = [];
  try { tids = fs.readdirSync('/proc/' + pid + '/task'); } catch { return []; }
  for (const tid of tids) {
    let s = '';
    try { s = fs.readFileSync('/proc/' + pid + '/task/' + tid + '/children', 'utf8'); } catch { continue; }
    for (const c of s.split(' ')) if (c.trim()) out.add(c.trim());
  }
  return [...out];
}

module.exports = { refreshProcs, procInfo, alive, psText, cmdOf, headlessOf, stdoutOf, childrenOf };
