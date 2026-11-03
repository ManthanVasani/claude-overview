'use strict';

const assert = require('node:assert/strict');
const cp = require('child_process');
const test = require('node:test');
const { Board, runningToolShell, SERVER_TEST_MS } = require('./helpers/board');
const { prompt, call, said, result, PERMISSION, quote } = require('./helpers/claude-code');

// the board's ps path calls lsof, and on Linux its ps is a stand-in that reads procps ps and /proc
const runnable = process.platform === 'darwin' || (process.platform === 'linux' && !cp.spawnSync('lsof', ['-v']).error && cp.spawnSync('/usr/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)]).status === 0);

test('the board on the macOS process path, where ps prints each command through strvis', { timeout: SERVER_TEST_MS, skip: !runnable && process.env.CI !== 'true' && 'needs lsof, and on Linux procps ps' }, async (t) => {
  assert.ok(runnable, 'needs lsof, and on Linux procps ps');
  const t0 = Date.now();
  const b = new Board('board-macos-', { startedAt: t0 - 8000, statusUpdatedAt: t0 });
  t.after(() => b.stop());
  const shell = (fns, cmd, out) => b.shells([runningToolShell(fns, quote(cmd) + ' < /dev/null'), out]);
  const besideWaiting = (key, cmd, fns) => b.session(key, PERMISSION, [prompt(t0 - 5000), call(t0 - 3000, 'Bash', { command: 'make waiting', description: 'Wait here' }), call(t0 - 2000, 'Bash', { command: cmd, description: 'Run ' + key })], shell(fns || [cmd.split(' ')[0]], cmd, b.task(key)));
  const monitor = (key, cmd, task) => b.session(key, { status: 'busy', statusUpdatedAt: t0 - 5000 }, [prompt(t0 - 5000), call(t0 - 3000, 'Monitor', { command: cmd, description: 'Watch ' + key }, 'tu-' + key), result(t0 - 2900, 'tu-' + key, { taskId: task }), said(t0 - 2800, 'watching')], shell(['tail', 'grep'], cmd, '/dev/null'));

  const lines = 'make one\nmake two';
  b.session('busy-two-lines', { status: 'busy', statusUpdatedAt: t0 - 5000 }, [prompt(t0 - 5000), call(t0 - 3000, 'Bash', { command: lines, description: 'Two lines' })], shell(['make'], lines, b.task('b1')));
  besideWaiting('beside-newline', lines, ['make']);
  besideWaiting('beside-tab', "printf 'a\tb'");
  besideWaiting('beside-utf8', 'echo café');
  besideWaiting('beside-c-cedilla', 'echo ç');
  besideWaiting('beside-kana', "echo 'で'");
  besideWaiting('beside-typed-m', "grep 'M-' notes.txt");
  b.session('lookalike', PERMISSION, [prompt(t0 - 5000), call(t0 - 3000, 'Bash', { command: 'make one\\012make two', description: 'Look alike' }), call(t0 - 2000, 'Bash', { command: lines, description: 'Run two' })], shell(['make'], lines, b.task('b5')));
  // the Monitor key's cut falls inside the emoji
  const cut = 'tail -f /x/\u{1F600}/' + 'a'.repeat(47) + ".log | grep 'E'";
  monitor('monitor-cut-emoji', cut, 'mon2');
  monitor('monitor-utf8', "tail -f /x/café.log | grep --line-buffered 'E'", 'mon1');
  const spawned = Date.now();

  await b.start({ macOS: true });
  await b.listed(Object.keys(b.sessions).length);
  // a shell nobody claims is listed as a background command after 5 s
  await b.polls(2);
  const snap = await b.until(spawned + 6000);
  const view = (key) => {
    const s = b.view(snap, key);
    return { alive: s.alive, state: s.state, act: s.act && s.act.label, shells: (s.shells || []).map((x) => ({ desc: x.desc, state: x.state })) };
  };
  const check = (name, fn) => t.test(name, fn);
  const namesWaiting = (key) => {
    const s = view(key);
    assert.equal(s.state, 'needs-you');
    assert.match(s.act || '', /make waiting|Wait here/);
  };

  await check('a session is seen alive on the ps path', () => assert.equal(view('busy-two-lines').alive, true));
  await check('a running two-line command: working on it, its shell not listed as a background command', () => {
    const s = view('busy-two-lines');
    assert.equal(s.state, 'working');
    assert.match(s.act || '', /Two lines|make one/);
    assert.deepEqual(s.shells, []);
  });
  await check('a waiting call beside a running two-line command: names the waiting one', () => namesWaiting('beside-newline'));
  await check('a waiting call beside a running command with a tab: names the waiting one', () => namesWaiting('beside-tab'));
  await check('a waiting call beside a running command with non-ASCII text: names the waiting one', () => namesWaiting('beside-utf8'));
  for (const [key, what] of [['beside-c-cedilla', 'a c with a cedilla, which ps prints with a quote'], ['beside-kana', 'a kana character, which ps prints with a quote'], ['beside-typed-m', 'a typed M-, as ps prints a high byte']]) {
    await check('a waiting call beside a running command with ' + what + ': names the waiting one', () => namesWaiting(key));
  }
  await check('a waiting call whose text is the running one as ps prints it: names neither', () => assert.deepEqual([view('lookalike').state, view('lookalike').act], ['needs-you', 'Waiting for your permission']));
  await check('a Monitor whose key cut falls inside an emoji: running', () => assert.deepEqual(view('monitor-cut-emoji').shells.map((x) => x.state), ['running']));
  await check('a Monitor with non-ASCII text before its first quote: running', () => assert.deepEqual(view('monitor-utf8').shells.map((x) => x.state), ['running']));
  await check('the server writes nothing to stderr', () => assert.equal(b.errors.trim(), ''));
});
