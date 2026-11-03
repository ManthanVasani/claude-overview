'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const test = require('node:test');
const { Board, runningToolShell, sleep, SERVER_TEST_MS } = require('./helpers/board');
const { prompt, call, said, result, notification, PERMISSION, SCREEN, quote, SCRUB } = require('./helpers/claude-code');

// a line the board reads as a tool shell, kept running by its sleep
const body = (word) => 'sleep 600; : /x/shell-snapshots/s.sh eval ' + word + ' && pwd -P >| /dev/null';

test('the board reads each session from Claude Code status, on the /proc path', { timeout: SERVER_TEST_MS, skip: process.platform !== 'linux' && 'the /proc path is Linux only' }, async (t) => {
  const T0 = Date.now() - 60000;
  const b = new Board('board-', { startedAt: T0 - 5000 });
  t.after(() => b.stop());

  const stamp = Date.now() - 4000;
  b.session('lone', Object.assign({ statusUpdatedAt: stamp }, PERMISSION), [prompt(T0), call(stamp - 50, 'Bash', { command: 'make build', description: 'Build it' })]);
  b.session('two', PERMISSION, [prompt(T0), { type: 'assistant', timestamp: new Date(T0 + 1000).toISOString(), message: { id: 'mx', role: 'assistant', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'make a' } }, { type: 'tool_use', id: 'x2', name: 'WebFetch', input: { url: 'https://example.com/' } }] } }]);
  b.session('answer', { status: 'waiting', waitingFor: 'input needed' }, [prompt(T0), call(T0 + 1000, 'mcp__x__y', {})]);
  b.session('screen-idle', SCREEN, [prompt(T0), said(T0 + 1000)]);
  b.session('screen-busy', { status: 'busy' }, [prompt(T0), call(T0 + 1000, 'Read', { file_path: '/x' })]);
  b.session('shell', { status: 'shell' }, [prompt(T0), said(T0 + 1000)]);
  b.session('busy-old-call', { status: 'busy' }, [prompt(T0), call(T0 + 1000, 'Bash', { command: 'sleep 99' })]);
  b.session('no-status', {}, [prompt(Date.now() - 30000), call(Date.now() - 25000, 'Bash', { command: 'make deploy' })]);
  b.session('ask', PERMISSION, [prompt(T0), call(T0 + 1000, 'AskUserQuestion', { questions: [{ question: 'Which one?' }] })]);
  b.session('agent', PERMISSION, [prompt(T0), call(T0 + 1000, 'Agent', { description: 'Check the logs', prompt: 'look', subagent_type: 'general-purpose' }, 'toolAg')]);
  b.agent('agent', 'a1', { description: 'Check the logs', agentType: 'general-purpose', toolUseId: 'toolAg' }, [prompt(T0 + 2000), call(Date.now() - 100, 'Bash', { command: 'grep error app.log' })]);
  b.session('idle-then-screen', { status: 'idle', statusUpdatedAt: Date.now() - 300000 }, [prompt(Date.now() - 400000), said(Date.now() - 399000)]);
  const late = Date.now() - 20000;
  b.session('late', Object.assign({ statusUpdatedAt: late }, PERMISSION), [prompt(late - 3000), call(late - 50, 'Bash', { command: 'make late', description: 'Build late' }), call(late + 5000, 'Read', { file_path: '/y' })]);
  b.session('sandbox', { status: 'waiting', waitingFor: 'sandbox request' }, [prompt(T0), call(T0 + 1000, 'Bash', { command: 'curl example.com', description: 'Fetch it' })]);
  b.session('stopped-agent', PERMISSION, [prompt(T0), call(T0 + 1000, 'Agent', { description: 'Look around', prompt: 'look', subagent_type: 'general-purpose' }, 'toolSt'), call(Date.now() - 100, 'Bash', { command: 'make check', description: 'Check it' })]);
  b.agent('stopped-agent', 's1', { description: 'Look around', agentType: 'general-purpose', toolUseId: 'toolSt', stoppedByUser: true }, [prompt(T0 + 2000), call(Date.now() - 200, 'WebFetch', { url: 'https://example.com/' })]);
  b.session('stop-late', PERMISSION, [prompt(T0), call(T0 + 1000, 'Agent', { description: 'Look later', prompt: 'look', subagent_type: 'general-purpose' }, 'toolSL'), call(Date.now() - 100, 'Bash', { command: 'make late-stop', description: 'Stop late' })]);
  const lateStopMeta = b.agent('stop-late', 'l1', { description: 'Look later', agentType: 'general-purpose', toolUseId: 'toolSL' }, [prompt(T0 + 2000), call(Date.now() - 200, 'WebFetch', { url: 'https://example.com/' })]);
  b.session('bg-wait', PERMISSION, [prompt(T0), call(Date.now() - 100, 'Bash', { command: 'make serve', description: 'Serve it', run_in_background: true })]);
  b.session('old-version', { status: 'busy', version: '2.1.283' }, [prompt(Date.now() - 30000), call(Date.now() - 25000, 'Bash', { command: 'make old' })]);
  // a permission hook runs as a child of the Claude process while the call waits
  b.session('hook', PERMISSION, [prompt(Date.now() - 3000), call(Date.now() - 1000, 'Bash', { command: 'make hooked', description: 'Hooked' })], b.spawn('sh', ['-c', 'sleep 600 & wait']));
  b.session('screen-turn-ends', { status: 'busy' }, [prompt(T0), call(T0 + 1000, 'Bash', { command: 'make long', description: 'Long' }, 'tuE')]);
  b.session('notify-turn', { status: 'idle', statusUpdatedAt: Date.now() - 300000 }, [prompt(Date.now() - 400000), said(Date.now() - 399000)]);
  b.session('fast-turn', { status: 'idle', statusUpdatedAt: Date.now() - 300000 }, [prompt(T0), said(T0 + 1000)]);
  b.session('two-shells', PERMISSION, [prompt(Date.now() - 5000), call(Date.now() - 3000, 'Bash', { command: 'make waiting', description: 'Wait here' }), call(Date.now() - 2000, 'Bash', { command: 'make running', description: 'Run this' })], b.shells([body(quote('make running')), b.task('brun')]));
  b.session('same-head', PERMISSION, [prompt(Date.now() - 5000), call(Date.now() - 3000, 'Bash', { command: "grep -rn 'alpha' .", description: 'Find alpha' }), call(Date.now() - 2000, 'Bash', { command: "grep -rn 'beta' .", description: 'Find beta' })], b.shells([body(quote("grep -rn 'beta' .")), b.task('bsame')]));
  b.session('twin', PERMISSION, [prompt(Date.now() - 5000), call(Date.now() - 3000, 'Bash', { command: 'make twin', description: 'Twin wait' }), call(Date.now() - 2000, 'Bash', { command: 'make twin', description: 'Twin run' })], b.shells([body(quote('make twin')), b.task('btwin')]));
  b.session('one-word', PERMISSION, [prompt(Date.now() - 5000), call(Date.now() - 3000, 'Bash', { command: 'make word-wait', description: 'Word wait' }), call(Date.now() - 2000, 'Bash', { command: 'pytest', description: 'Run tests' })], b.shells([body('pytest < /dev/null'), b.task('bword')]));
  const P0 = Date.now();
  const phantom = b.shells('sleep 600 & sleep 0.1;', [body('make < /dev/null'), b.task('pmake')], 'sleep 1;', [body(quote('npm run lint') + ' < /dev/null'), b.task('plint')]);
  b.session('phantom', { status: 'busy' }, [prompt(P0 - 5000), call(P0 - 200, 'Bash', { command: 'make', description: 'Make it' }), call(P0 + 900, 'Bash', { command: 'npm run lint', description: 'Lint it' }), call(P0 + 3500, 'Bash', { command: 'git push', description: 'Push it' })], phantom);
  const stolen = b.shells('sleep 600 & sleep 1;', [body(quote('sleep 30') + ' < /dev/null'), b.task('bstolen')]);
  const S0 = Date.now();
  b.session('stolen', Object.assign({ statusUpdatedAt: S0 }, PERMISSION), [prompt(S0 - 5000), call(S0 - 500, 'Bash', { command: 'sleep 30', description: 'Sleep thirty' })], stolen);
  b.session('unknown-bg', { status: 'shell' }, [prompt(T0), said(T0 + 1000)], b.shells([runningToolShell(['build'], quote("build --tag 'v1' < /dev/null")), b.task('bdesc1')], [runningToolShell(['deploy'], 'deploy < /dev/null'), b.task('bdesc2')]));
  b.session('quote-tail', PERMISSION, [prompt(Date.now() - 5000), call(Date.now() - 3000, 'Bash', { command: 'echo hi', description: 'Say hi' }), call(Date.now() - 2000, 'Bash', { command: "echo hi'there'", description: 'Say there' })], b.shells([runningToolShell(['echo'], quote("echo hi'there'")), b.task('bquote')]));
  // without __cc_name the scrub fails and the command after it never runs
  b.session('prelude', PERMISSION, [prompt(Date.now() - 5000), call(Date.now() - 3000, 'Bash', { command: 'git push', description: 'Push' }), call(Date.now() - 2000, 'Bash', { command: 'npm test', description: 'Run tests' })], b.shells([runningToolShell(['npm'], quote('npm test'), '__cc_name=PATH; ' + SCRUB), b.task('bprelude')]));
  const busyAt = Date.now() - 3000;
  b.session('cmd-under-screen', { status: 'busy', statusUpdatedAt: busyAt }, [prompt(T0), said(T0 + 1000), prompt(busyAt - 100, '<command-message>review</command-message>')]);
  b.session('prompt-under-screen', { status: 'idle', statusUpdatedAt: Date.now() - 300000 }, [prompt(Date.now() - 400000), said(Date.now() - 399000)]);
  b.session('dangling-screen', Object.assign({ startedAt: Date.now() - 10000 }, SCREEN), [prompt(Date.now() - 60000), call(Date.now() - 59000, 'Bash', { command: 'make gone', description: 'Gone' })]);
  b.session('old-beta', { status: 'busy', version: '2.1.250-beta.0' }, [prompt(Date.now() - 30000), call(Date.now() - 25000, 'Bash', { command: 'make beta' })]);
  b.session('queued-under-screen', { status: 'busy' }, [prompt(T0), call(T0 + 1000, 'Read', { file_path: '/q' }, 'tuQ')]);
  b.session('prompt-after-end-screen', SCREEN, [prompt(T0), said(T0 + 1000), prompt(Date.now() - 2000)]);
  b.session('notify-under-screen', { status: 'idle', statusUpdatedAt: Date.now() - 300000 }, [prompt(Date.now() - 400000), said(Date.now() - 399000)]);
  b.session('no-version', { status: 'busy', version: null }, [prompt(Date.now() - 30000), call(Date.now() - 25000, 'Bash', { command: 'make nover' })]);
  const H0 = Date.now();
  b.session('held', Object.assign({ statusUpdatedAt: H0 }, PERMISSION), [prompt(H0 - 20000), call(H0 - 19000, 'Agent', { description: 'Write the notes', prompt: 'write', subagent_type: 'general-purpose' }, 'toolH1'), call(H0 - 19000, 'Agent', { description: 'Fetch the page', prompt: 'fetch', subagent_type: 'general-purpose' }, 'toolH2')]);
  b.agent('held', 'h1', { description: 'Write the notes', agentType: 'general-purpose', toolUseId: 'toolH1' }, [prompt(H0 - 18000), call(H0 - 8000, 'Write', { file_path: '/x/notes.txt', content: 'hi' })]);
  b.agent('held', 'h2', { description: 'Fetch the page', agentType: 'general-purpose', toolUseId: 'toolH2' }, [prompt(H0 - 18000), call(H0 - 2000, 'WebFetch', { url: 'https://example.com/' })]);
  b.session('answered', Object.assign({ statusUpdatedAt: H0 }, PERMISSION), [prompt(H0 - 30000), call(H0 - 20000, 'WebFetch', { url: 'https://example.com/a' }, 'tuA1'), result(H0 - 15000, 'tuA1'), call(H0 - 50, 'Write', { file_path: '/x/answered.txt', content: 'hi' })]);
  b.session('old-flight', PERMISSION, [prompt(T0), call(T0 + 1000, 'WebFetch', { url: 'https://example.com/slow' })]);
  const old = Date.now() - 400000;
  b.session('restart', { status: 'idle', statusUpdatedAt: Date.now() - 300000 }, [prompt(old), said(old + 1000)]);
  // sized past the first read and one backwards chunk, so a call's line crosses a chunk edge
  const big = 'x'.repeat(256 << 10);
  const writes = Array.from({ length: 24 }, (_, i) => '/x/f' + i + '.txt');
  b.session('long-history', { status: 'idle', statusUpdatedAt: Date.now() - 300000 }, [prompt(T0), ...writes.map((f, i) => call(T0 + 1000 + i, 'Write', { file_path: f, content: big })), ...Array.from({ length: 20 }, () => said(T0 + 2000, big))]);
  const spawned = Date.now();

  await b.start();
  await b.listed(Object.keys(b.sessions).length);
  let snap = await b.polls(2);
  const view = (key) => b.view(snap, key);
  const st = (key) => {
    const s = view(key);
    return s && { state: s.state, act: s.act && s.act.label, since: s.act && s.act.since };
  };
  const check = (name, fn) => t.test(name, fn);
  const needsYou = (key, act) => {
    const s = st(key);
    assert.equal(s.state, 'needs-you');
    if (act instanceof RegExp) assert.match(s.act || '', act);
    else assert.equal(s.act, act);
  };
  const ALONE = 'Waiting for your permission';

  await check('waiting for permission, one open call: needs you, names the call', () => {
    needsYou('lone', /^Waiting for your permission: /);
    assert.equal(st('lone').since, stamp);
  });
  await check('waiting for permission, two open calls: needs you, names none', () => needsYou('two', ALONE));
  await check('input needed: needs you, waiting for your answer', () => needsYou('answer', 'Waiting for your answer'));
  await check('a screen open when the server starts: your turn', () => assert.equal(st('screen-idle').state, 'your-turn'));
  await check('idle with a background shell: your turn', () => assert.equal(st('shell').state, 'your-turn'));
  await check('busy with a call that started no process for a minute: working, no guess', () => assert.equal(st('busy-old-call').state, 'working'));
  await check('a Claude Code that writes no status: the timing guess names the call', () => needsYou('no-status', /make deploy/));
  await check('a question: needs you with its text', () => needsYou('ask', /Which one/));
  await check("an agent's lone open call: the agent shows the permission", () => {
    const a1 = view('agent').agents.find((a) => a.id === 'a1');
    assert.equal(a1.trouble.kind, 'permission');
    assert.match(a1.trouble.text, /grep error/);
  });
  await check("an agent's lone open call: the session names the agent", () => needsYou('agent', /\(agent: Check the logs\)$/));
  await check('waiting carries the wording', () => assert.deepEqual(view('lone').waiting && { text: view('lone').waiting.text, since: view('lone').waiting.since }, { text: ALONE, since: stamp }));
  await check('a screen gives no wording', () => assert.equal(view('screen-idle').waiting.text, null));
  await check('needs rows: only the sessions that wait', () => {
    const rows = snap.attention.filter((a) => a.level === 'needs').map((a) => a.session).sort();
    assert.deepEqual(rows, ['agent', 'agent', 'answer', 'answered', 'ask', 'bg-wait', 'held', 'hook', 'late', 'lone', 'no-status', 'no-version', 'old-flight', 'old-beta', 'old-version', 'one-word', 'sandbox', 'same-head', 'stop-late', 'stopped-agent', 'twin', 'two', 'two-shells', 'stolen', 'quote-tail', 'prelude'].sort());
  });
  await check('the header counts each session that needs you once', () => assert.equal(snap.totals.needsYou, 25));
  await check('a waiting call beside a running one that is its command and a quote more: names the waiting one', () => needsYou('quote-tail', /echo hi$|Say hi/));
  await check("a waiting call beside a running one whose shell evals Claude Code's prelude first: names the waiting one", () => needsYou('prelude', /git push$|Push/));
  await check('two open calls, one written after the prompt: names neither', () => needsYou('late', ALONE));
  await check('a running call whose shell lost its pairing to a stray child: not named', () => needsYou('stolen', ALONE));
  await check("a waiting call beside another call's running shell: names the waiting one", () => needsYou('two-shells', /make waiting|Wait here/));
  await check('a waiting call beside a running one that reads the same up to its first quote: names the waiting one', () => needsYou('same-head', /Find alpha|alpha/));
  await check('a screen open over a call left by an earlier process: your turn', () => assert.equal(st('dangling-screen').state, 'your-turn'));
  await check('an older version with a suffix: needs you by the timing guess', () => assert.equal(st('old-beta').state, 'needs-you'));
  await check('an agent and the session each with an open call: names neither', () => needsYou('stop-late', ALONE));
  await check('a sandbox request: needs you, names no call', () => needsYou('sandbox', ALONE));
  await check('a background command waiting for approval: named', () => needsYou('bg-wait', /make serve|Serve it/));
  await check('a prompt that starts long after the only open call: names no call', () => needsYou('old-flight', ALONE));
  await check("a prompt a hook held back more than 5 s, beside another agent's newer open call: names no call and no agent", () => {
    needsYou('held', ALONE);
    assert.deepEqual(view('held').agents.filter((a) => a.trouble && a.trouble.kind === 'permission').map((a) => a.desc), []);
  });
  await check('a prompt raised at once beside an older call that has its result: names the waiting call', () => needsYou('answered', /answered\.txt/));
  await check('a status with no readable version: the timing guess names the call', () => needsYou('no-version', /make nover/));
  await check('a screen open when the server starts, over a prompt sent after the last turn ended: working', () => assert.equal(st('prompt-after-end-screen').state, 'working'));
  await check('a version not known to write waiting: the timing guess names the call', () => needsYou('old-version', /make old/));
  await check('two calls with the same command, one running: names neither', () => needsYou('twin', ALONE));
  await check('a waiting call beside a running one-word command: names the waiting one', () => needsYou('one-word', /make word-wait|Word wait/));
  await check('a hook process beside the waiting call: the call is named', () => needsYou('hook', /make hooked|Hooked/));
  await check('the calls before the part of a long transcript read first: each in the history once', async () => {
    const rows = (await b.history()).filter((r) => r[1] === b.sessions['long-history'].sid);
    assert.deepEqual(rows.map((r) => r[7]).sort(), writes.map((f) => 'Writing ' + f).sort());
  });

  const idleSince = view('idle-then-screen').since;
  const restartWas = view('restart').since;
  b.writeReg('screen-busy', SCREEN);
  b.writeReg('cmd-under-screen', SCREEN);
  b.append('prompt-under-screen', [prompt(Date.now() - 200)]);
  b.writeReg('prompt-under-screen', SCREEN);
  b.writeReg('idle-then-screen', SCREEN);
  const turnAt = Date.now();
  b.append('fast-turn', [prompt(turnAt - 1500), said(turnAt - 1000)]);
  b.writeReg('fast-turn', { status: 'idle', statusUpdatedAt: turnAt });
  b.writeReg('screen-turn-ends', SCREEN);
  b.writeReg('queued-under-screen', SCREEN);
  b.append('queued-under-screen', [result(turnAt - 1500, 'tuQ'), said(turnAt - 1000), prompt(turnAt - 500)]);
  b.writeReg('notify-under-screen', SCREEN);
  b.append('screen-turn-ends', [result(turnAt - 1500, 'tuE'), said(turnAt - 1000)]);
  b.append('notify-turn', [notification(turnAt - 1500, 'b1'), said(turnAt - 1000)]);
  b.writeReg('notify-turn', { status: 'idle', statusUpdatedAt: turnAt });
  b.restart('restart', { status: 'idle', statusUpdatedAt: turnAt, startedAt: turnAt - 1000 });
  await b.polls(2);
  // a shell nobody claims is listed as a background command after 5 s
  snap = await b.until(spawned + 6000);

  await check('a child that is not a tool shell beside three calls: no tool shell is listed as a background command', () => assert.deepEqual(view('phantom').shells || [], []));
  await check('background shells the transcript does not name: each shows its own command', () => {
    assert.deepEqual((view('unknown-bg').shells || []).map((x) => x.desc).sort(), ["$ build --tag 'v1' < /dev/null", '$ deploy']);
  });
  await check('a screen opened while working: stays working', () => assert.equal(st('screen-busy').state, 'working'));
  await check("a screen opened while a command's turn starts: stays working", () => assert.equal(st('cmd-under-screen').state, 'working'));
  await check('a prompt and a screen between two polls: working', () => assert.equal(st('prompt-under-screen').state, 'working'));
  await check("a stopped agent's open call is not the one the prompt waits for", () => needsYou('stopped-agent', /make check|Check it/));
  await check('a turn that ends while a screen is open: your turn', () => assert.equal(st('screen-turn-ends').state, 'your-turn'));
  await check('a prompt sent as the turn under a screen ends: working', () => assert.equal(st('queued-under-screen').state, 'working'));
  await check('a turn started by a task notification between two polls: your turn from its end', () => assert.deepEqual([view('notify-turn').state, view('notify-turn').since], ['your-turn', turnAt]));
  await check('a turn that starts and ends between two polls: your turn from its end', () => assert.deepEqual([view('fast-turn').state, view('fast-turn').since], ['your-turn', turnAt]));
  await check("a session restarted in another process: your turn from that process's status", () => {
    assert.notEqual(restartWas, turnAt);
    assert.deepEqual([view('restart').state, view('restart').since], ['your-turn', turnAt]);
  });
  await check('a screen opened on an idle session: your turn, same since', () => assert.deepEqual([view('idle-then-screen').state, view('idle-then-screen').since], ['your-turn', idleSince]));

  b.writeReg('idle-then-screen', { status: 'idle' });
  const shellSince = view('shell').since;
  b.writeReg('shell', { status: 'idle' });
  const screenTurnAt = Date.now();
  b.append('notify-under-screen', [notification(screenTurnAt - 1500, 'b2'), said(screenTurnAt - 1000)]);
  snap = await b.polls(2);

  await check('a turn a task notification starts and ends under a screen, between two polls: your turn from its end', () => assert.deepEqual([view('notify-under-screen').state, view('notify-under-screen').since], ['your-turn', screenTurnAt - 1000]));
  await check('the screen closed: your turn, same since', () => assert.deepEqual([view('idle-then-screen').state, view('idle-then-screen').since], ['your-turn', idleSince]));
  await check('the background shell ended: your turn, same since', () => assert.deepEqual([view('shell').state, view('shell').since], ['your-turn', shellSince]));

  b.writeReg('lone', { status: 'busy' });
  snap = await b.polls(2);

  await check('prompt answered: working', () => assert.equal(st('lone').state, 'working'));
  await check('a running call whose shell lost its pairing, once past the wait for a background task: not named, no background row', () => {
    needsYou('stolen', ALONE);
    assert.deepEqual(view('stolen').shells || [], []);
  });

  fs.writeFileSync(lateStopMeta, JSON.stringify({ description: 'Look later', agentType: 'general-purpose', toolUseId: 'toolSL', stoppedByUser: true }));
  const seen = new Set();
  for (let at = snap.now, polls = 0; polls < 2;) {
    await sleep(100);
    const s = await b.state();
    if (s.now !== at) { at = s.now; polls++; }
    const x = b.view(s, 'stop-late');
    const ag = x.agents.find((a) => a.desc === 'Look later');
    seen.add((ag ? ag.state : '-') + ' | ' + (x.act ? x.act.label : '-'));
  }
  await check('an agent that stops: its call stops counting in the snapshot that shows it stopped', () => {
    const list = [...seen];
    assert.ok(list.some((x) => x.startsWith('stopped')), JSON.stringify(list));
    for (const x of list) if (x.startsWith('stopped')) assert.match(x, /Stop late|make late-stop/);
  });
  await check('the server writes nothing to stderr', () => assert.equal(b.errors.trim(), ''));
});
