'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PROC_FS } = require('../../lib/config');
const { apply, newConv } = require('../../lib/conversation');
const { newSession, waitedOn } = require('../../lib/sessions');
const { matchForeground } = require('../../lib/shells');
const { appleVis } = require('./apple-vis');
const { call, PERMISSION, quote, toolShellArgv, toolShellLine } = require('./claude-code');
const { rng } = require('./rng');

const T = 1000000;
const NOW = T + 40000;
const CMDS = ["printf 'a\tb'", 'echo café', 'echo ç', 'make one\nmake two', 'make one\\012make two', 'npm test', 'make', 'git status', 'pytest', "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"", 'ls -la', "grep 'M-' notes.txt", "echo 'で'"];

function toolShell(cmd, mac, devNull) {
  const afterEval = quote(cmd) + (devNull && !cmd.includes('<') ? ' < /dev/null' : '');
  return mac ? appleVis(toolShellArgv(afterEval, { shell: 'zsh' }).join(' ')) : toolShellLine(afterEval);
}

function scenario(r, mac, held) {
  const n = 2 + Math.floor(r() * 2);
  const w = Math.floor(r() * n);
  const wAt = T + 5000 + Math.floor(r() * 10000);
  const late = r() < 1 / 6;
  const calls = [];
  const procs = [];
  for (let i = 0; i < n; i++) {
    const waits = i === w;
    const tool = waits ? r.pick(['Bash', 'Bash', 'Write']) : r.pick(['Bash', 'Bash', 'Bash', 'WebFetch']);
    const at = waits ? wAt : T + Math.floor(r() * 25000);
    const cmd = tool === 'Bash' ? r.pick(CMDS) : null;
    if (!(waits && late)) calls.push({ owner: 'agent' + i, tool, at, cmd });
    if (!waits && tool === 'Bash') procs.push({ start: at + 50 + Math.floor(r() * 300), task: 'bt' + i, cmd: toolShell(cmd, mac, r() < 0.5) });
    if (waits && r() < 0.5) procs.push({ start: at + 100, task: null, cmd: '/bin/sh -c ~/.claude/hooks/permission-request.sh' });
  }
  if (r() < 0.3) procs.push({ start: T + Math.floor(r() * 25000), task: null, cmd: '/bin/sh -c ~/.claude/hooks/statusline.sh' });
  const lead = held ? 5500 + Math.floor(r() * 14500) : 50;
  return { n, waiting: 'agent' + w, late, wAt, lead, calls, procs };
}

function build(sc) {
  const reg = Object.assign({ pid: 1, sessionId: 's', startedAt: 1, statusUpdatedAt: sc.wAt + sc.lead, version: '2.1.316' }, PERMISSION);
  const S = newSession('s', { reg, alive: true, mt: NOW });
  for (let i = 0; i < sc.n; i++) {
    const id = 'agent' + i;
    S.agents.set(id, { id, S, meta: {}, startedAt: T, tail: { mtimeMs: 0 }, conv: newConv(S, id) });
  }
  for (const c of sc.calls) {
    const input = c.tool === 'Bash' ? { command: c.cmd } : c.tool === 'Write' ? { file_path: '/x', content: 'x' } : { url: 'https://example.com/' };
    apply(S.agents.get(c.owner).conv, call(c.at, c.tool, input));
  }
  sc.procs.sort((a, b) => a.start - b.start).forEach((p, i) => S.procs.set(String(1000 + i), Object.assign({ pid: String(1000 + i) }, p)));
  return S;
}

// a waiting call not yet written cannot be seen, so a lone open call that starts no process can take its name
function run(count, seed, mac, held) {
  const r = rng(seed);
  const tally = { written: 0, right: 0, wrong: [], late: 0, lateNamed: 0, lateNamedShell: [] };
  for (let k = 0; k < count; k++) {
    const sc = scenario(r, mac, held);
    const S = build(sc);
    const named = waitedOn(S, matchForeground(S, NOW), NOW, new Map());
    const p = named.length ? named[0].p : null;
    if (sc.late) {
      tally.late++;
      if (p) tally.lateNamed++;
      if (p && p.name === 'Bash') tally.lateNamedShell.push({ calls: sc.calls, named: p.label });
      continue;
    }
    tally.written++;
    if (!p) continue;
    if (named[0].c.owner === sc.waiting) tally.right++;
    else tally.wrong.push({ calls: sc.calls, waiting: sc.waiting, named: p.label });
  }
  return tally;
}

function takesFor(shellCmd, callCmd, mac) {
  const S = build({ n: 1, wAt: T, lead: 50, calls: [{ owner: 'agent0', tool: 'Bash', at: T, cmd: callCmd }], procs: [{ start: T + 100, task: 'bt0', cmd: toolShell(shellCmd, mac, true) }] });
  return matchForeground(S, NOW).running.size === 1;
}

// how often the waiting call is named, so a change that names none cannot pass as never naming a wrong one
const FLOOR = 0.55;

function suite(mac) {
  const cached = {};
  const runs = (held) => cached[held] || (cached[held] = [1, 7, 42].map((seed) => ({ seed, t: run(10000, seed, mac, held) })));
  test('the forced platform gives the ' + (mac ? 'macOS ps' : 'Linux /proc') + ' path', () => assert.equal(PROC_FS, !mac));
  test('a permission prompt raised as its call is written, over several agents: the waiting call is named, or none is', () => {
    for (const { seed, t } of runs(false)) {
      assert.deepEqual(t.wrong.slice(0, 3), [], 'seed ' + seed);
      assert.ok(t.right / t.written >= FLOOR, 'seed ' + seed + ': ' + t.right + ' of ' + t.written + ' named');
    }
  });
  test('a permission prompt a hook holds back more than 5 s, over several agents: no other call takes its name', () => {
    for (const { seed, t } of runs(true)) assert.deepEqual(t.wrong.slice(0, 3), [], 'seed ' + seed);
  });
  test('a waiting call not yet written: only an open call that starts no process can take its name', () => {
    for (const { seed, t } of runs(false)) assert.deepEqual(t.lateNamedShell.slice(0, 3), [], 'seed ' + seed);
  });
}

module.exports = { takesFor, suite };
