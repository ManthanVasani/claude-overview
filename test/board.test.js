'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');
const { Board, runningToolShell, sleep, SERVER_TEST_MS } = require('./helpers/board');
const { prompt, call, said, result, launched, notification, PERMISSION, SCREEN, quote, SCRUB } = require('./helpers/claude-code');
const { AGENT_FIRST_BYTES, BACKFILL_CHUNK, BACKFILL_PER_FILE, BACKFILL_PER_RUN, SESSION_FIRST_BYTES, POLL_MS, STARTER_KEEP_MS } = require('../lib/constants');
const { noteStarters } = require('../lib/sessions');

// a line the board reads as a tool shell, kept running by its sleep
const body = (word) => 'sleep 600; : /x/shell-snapshots/s.sh eval ' + word + ' && pwd -P >| /dev/null';

// what the page counts in the header while it hides a session
function pageTotals(snap) {
  const window = { addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'hidden.js'), 'utf8'), { window, localStorage: { getItem: () => null, setItem() {} } });
  return JSON.parse(JSON.stringify(window.OVHidden.totals(snap.sessions, snap.attention)));
}

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
  // its process has already exited, so the header counts an ended session and the problem row it leaves
  b.session('gone', {}, [prompt(T0), said(T0 + 1000)], b.spawn('true', []));
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
  b.session('old-flight', PERMISSION, [prompt(T0), call(T0 + 1000, 'WebFetch', { url: 'https://example.com/slow' })]);
  const old = Date.now() - 400000;
  b.session('restart', { status: 'idle', statusUpdatedAt: Date.now() - 300000 }, [prompt(old), said(old + 1000)]);
  // sized past the first read and one backwards chunk, so a call's line crosses a chunk edge
  const big = 'x'.repeat(256 << 10);
  const writes = Array.from({ length: 24 }, (_, i) => '/x/f' + i + '.txt');
  b.session('long-history', { status: 'idle', statusUpdatedAt: Date.now() - 300000 }, [prompt(T0), ...writes.map((f, i) => call(T0 + 1000 + i, 'Write', { file_path: f, content: big })), ...Array.from({ length: 20 }, () => said(T0 + 2000, big))]);
  // past an agent's first read, so the launch before it is read only by looking back
  const pad = () => Array.from({ length: 5 }, () => said(T0 + 3000, big));
  b.session('agent-early-shell', { status: 'busy' }, [prompt(T0), call(T0 + 1000, 'Agent', { description: 'Watch the build', prompt: 'watch', subagent_type: 'general-purpose' }, 'toolAB')], b.shells(['sleep 600', b.task('bagent1')]));
  b.agent('agent-early-shell', 'ab', { description: 'Watch the build', agentType: 'general-purpose', toolUseId: 'toolAB' }, [prompt(T0 + 2000), call(T0 + 2100, 'Bash', { command: 'npm run watch', description: 'Run the watcher', run_in_background: true }, 'tuAB'), launched(T0 + 2200, 'tuAB', 'bagent1'), call(T0 + 2300, 'Bash', { command: 'tail /x/tasks/bagent1.output', description: 'Read the watch output' }, 'tuTl'), result(T0 + 2400, 'tuTl', null, 'bagent1: watching'), call(T0 + 2500, 'Bash', { command: 'grep -h bagent1 /x/log.jsonl', description: 'Search the log' }, 'tuGr'), result(T0 + 2600, 'tuGr', null, '{"text":"Command running in background with ID: bagent1."}'), ...pad(), call(Date.now() - 4000, 'Bash', { command: 'ls /x/tasks', description: 'List the task files' }, 'tuLs'), result(Date.now() - 3900, 'tuLs', null, 'bagent1.output'), call(Date.now() - 3000, 'Read', { file_path: '/x/notes.md' }, 'tuRd'), result(Date.now() - 2900, 'tuRd', null, 'Command running in background with ID: bagent1.')]);
  b.session('wf-early-shell', { status: 'busy' }, [prompt(T0), said(T0 + 500)], b.shells(['sleep 600', b.task('bwf1')]));
  b.workflow('wf-early-shell', 'wf_early1', 'w1', 'build:docs', [prompt(T0 + 2000), call(T0 + 2100, 'Bash', { command: 'npm run docs', description: 'Build the docs', run_in_background: true }, 'tuWF'), launched(T0 + 2200, 'tuWF', 'bwf1'), ...pad(), call(Date.now() - 3000, 'Read', { file_path: '/x/docs.md' }, 'tuWR'), result(Date.now() - 2900, 'tuWR')]);
  b.session('wf-done-shell', { status: 'busy' }, [prompt(T0), said(T0 + 500)], b.shells(['sleep 600', b.task('bwf2')]));
  const doneJournal = b.workflow('wf-done-shell', 'wf_done1', 'w2', 'build:site', [prompt(T0 + 2000), call(T0 + 2100, 'Bash', { command: 'npm run site', description: 'Build the site', run_in_background: true }, 'tuW2'), launched(T0 + 2200, 'tuW2', 'bwf2'), ...pad(), call(Date.now() - 3000, 'Bash', { command: 'ls /x/tasks', description: 'List the task files' }, 'tuW2l'), result(Date.now() - 2900, 'tuW2l', null, 'bwf2.output')]);
  fs.appendFileSync(doneJournal, JSON.stringify({ type: 'result', agentId: 'w2', result: {} }) + '\n');
  const manual = (key, id, data) => b.session(key, { status: 'busy' }, [prompt(T0), call(T0 + 1000, 'Bash', { command: 'npm start', description: 'Start the app' }, 'tuMb'), result(T0 + 1100, 'tuMb', data, 'Command was manually backgrounded by user with ID: ' + id + '. Output is being written to: /x/tasks/' + id + '.output'), said(T0 + 3000, 'x'.repeat(SESSION_FIRST_BYTES))], b.shells(['sleep 600', b.task(id)]));
  manual('manual-shell', 'bman1', { backgroundTaskId: 'bman1' });
  manual('manual-text-shell', 'bman2', null);
  // the first read starts at the line it cuts, a backwards chunk after it: either can hold a result without its call
  const straddle = (resultLine, sidechain, tail) => {
    const json = (l) => JSON.stringify(sidechain ? Object.assign(l, { isSidechain: true }) : l).length + 1;
    const rest = said(T0 + 3000, '');
    rest.message.content[0].text = 'x'.repeat(tail - json(resultLine) - json(rest));
    return [resultLine, rest];
  };
  b.session('agent-edge-shell', { status: 'busy' }, [prompt(T0), call(T0 + 1000, 'Agent', { description: 'Run on the edge', prompt: 'edge', subagent_type: 'general-purpose' }, 'toolAE')], b.shells(['sleep 600', b.task('bedge1')]));
  b.agent('agent-edge-shell', 'ae', { description: 'Run on the edge', agentType: 'general-purpose', toolUseId: 'toolAE' }, [prompt(T0 + 2000), call(T0 + 2100, 'Bash', { command: 'npm run edge', description: 'Run the edge', run_in_background: true }, 'tuEd'), ...straddle(launched(T0 + 2200, 'tuEd', 'bedge1'), true, AGENT_FIRST_BYTES + 50)]);
  b.session('session-edge-shell', { status: 'busy' }, [prompt(T0), call(T0 + 1000, 'Bash', { command: 'npm run serve', description: 'Serve on the edge', run_in_background: true }, 'tuSe'), ...straddle(launched(T0 + 1100, 'tuSe', 'bsedge1'), false, SESSION_FIRST_BYTES + 50)], b.shells(['sleep 600', b.task('bsedge1')]));
  b.session('chunk-edge-shell', { status: 'busy' }, [prompt(T0), call(T0 + 1000, 'Agent', { description: 'Run on a chunk edge', prompt: 'edge', subagent_type: 'general-purpose' }, 'toolAC')], b.shells(['sleep 600', b.task('bchunk1')]));
  b.agent('chunk-edge-shell', 'ac', { description: 'Run on a chunk edge', agentType: 'general-purpose', toolUseId: 'toolAC' }, [prompt(T0 + 2000), call(T0 + 2100, 'Bash', { command: 'npm run chunk', description: 'Run the chunk job', run_in_background: true }, 'tuCh'), ...straddle(launched(T0 + 2200, 'tuCh', 'bchunk1'), true, BACKFILL_CHUNK - 10)]);
  b.session('quoted-shell', { status: 'busy' }, [prompt(T0), call(T0 + 1000, 'Bash', { command: 'npm run server', description: 'Run the server', run_in_background: true }, 'tuQs'), launched(T0 + 1100, 'tuQs', 'bquote1'), call(T0 + 1200, 'Bash', { command: 'grep -h bquote1 /x/log.jsonl', description: 'Search the log' }, 'tuQg'), result(T0 + 1300, 'tuQg', null, '{"text":"Command running in background with ID: bquote1."}'), call(T0 + 1400, 'Bash', { command: 'head -1 /x/notes.txt', description: 'Read the first note' }, 'tuQh'), result(T0 + 1500, 'tuQh', { stdout: 'Command running in background with ID: bquote1.', stderr: '', interrupted: false }, 'Command running in background with ID: bquote1.')], b.shells(['sleep 600', b.task('bquote1')]));
  b.session('budget-shell', { status: 'busy' }, [prompt(T0), call(T0 + 1000, 'Agent', { description: 'Run the job', prompt: 'job', subagent_type: 'general-purpose' }, 'toolRB')], b.shells(['sleep 600', b.task('bbudget1')]));
  const budgetAgent = b.agent('budget-shell', 'rb', { description: 'Run the job', agentType: 'general-purpose', toolUseId: 'toolRB' }, [prompt(T0 + 2000), call(T0 + 2100, 'Bash', { command: 'npm run job', description: 'Run the job', run_in_background: true }, 'tuRb'), launched(T0 + 2200, 'tuRb', 'bbudget1'), ...pad()]).replace('.meta.json', '.jsonl');
  fs.utimesSync(budgetAgent, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  // sparse; newer than the agent, so a search by age alone reaches them first
  for (let i = 1; i <= BACKFILL_PER_RUN / BACKFILL_PER_FILE; i++) {
    const journal = b.workflow('budget-shell', 'wf_big' + i, 'g' + i, 'build:big', [prompt(T0 + 2000), said(T0 + 2100)]);
    const fd = fs.openSync(path.join(path.dirname(journal), 'agent-g' + i + '.jsonl'), 'r+');
    for (let at = BACKFILL_CHUNK; at < BACKFILL_PER_FILE; at += BACKFILL_CHUNK) fs.writeSync(fd, '\n', at);
    fs.writeSync(fd, '\n', BACKFILL_PER_FILE);
    fs.closeSync(fd);
  }
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
    assert.deepEqual(rows, ['agent', 'agent', 'answer', 'ask', 'bg-wait', 'held', 'hook', 'late', 'lone', 'no-status', 'no-version', 'old-flight', 'old-beta', 'old-version', 'one-word', 'sandbox', 'same-head', 'stop-late', 'stopped-agent', 'twin', 'two', 'two-shells', 'stolen', 'quote-tail', 'prelude'].sort());
  });
  await check('the header counts each session that needs you once', () => assert.equal(snap.totals.needsYou, 24));
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
  await check('the page counts the header as the server does', () => assert.deepEqual(pageTotals(snap), snap.totals));
  await check('background shells the transcript does not name: each shows its own command', () => {
    assert.deepEqual((view('unknown-bg').shells || []).map((x) => x.desc).sort(), ["$ build --tag 'v1' < /dev/null", '$ deploy']);
  });
  const early = (key) => (view(key).shells || []).map((x) => [x.desc, x.owner, x.startedAt]);
  await check("a background shell an agent started before the part of its transcript read first, with later calls naming its id: the agent's launch", () => assert.deepEqual(early('agent-early-shell'), [['Run the watcher', 'ab', T0 + 2100]]));
  await check('a background shell a workflow agent started before the part of its transcript read first: its launch and its agent', () => assert.deepEqual(early('wf-early-shell'), [['Build the docs', 'wf:wf_early1:w1', T0 + 2100]]));
  await check('a background shell of a workflow agent the board never read, with a later command whose output names its id: its launch and its agent', () => assert.deepEqual(early('wf-done-shell'), [['Build the site', 'wf:wf_done1:w2', T0 + 2100]]));
  await check('a command backgrounded by hand before the part of the transcript read first: its launch', () => assert.deepEqual(early('manual-shell'), [['Start the app', null, T0 + 1000]]));
  await check('a command backgrounded by hand before the first read, known only from its result text: its launch', () => assert.deepEqual(early('manual-text-shell'), [['Start the app', null, T0 + 1000]]));
  await check("a background launch whose call is before an agent's first read and whose result is after it: the launch", () => assert.deepEqual(early('agent-edge-shell'), [['Run the edge', 'ae', T0 + 2100]]));
  await check("a background launch whose call is before the session's first read and whose result is after it: the launch", () => assert.deepEqual(early('session-edge-shell'), [['Serve on the edge', null, T0 + 1000]]));
  await check("a background launch whose call and result are in different chunks of the search back: the launch", () => assert.deepEqual(early('chunk-edge-shell'), [['Run the chunk job', 'ac', T0 + 2100]]));
  await check("a later command whose output quotes a running shell's launch: that shell's own launch", () => assert.deepEqual(early('quoted-shell'), [['Run the server', null, T0 + 1000]]));
  await check("a background shell an agent started before its first read, with enough workflow agents to use up the search: the agent's launch", () => assert.deepEqual(early('budget-shell'), [['Run the job', 'rb', T0 + 2100]]));
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

test('the board keeps sessions whose transcripts it cannot read, and leaves off only a session it fails on', { timeout: SERVER_TEST_MS, skip: process.platform !== 'linux' && 'the /proc path is Linux only' }, async (t) => {
  const T0 = Date.now() - 60000;
  const b = new Board('unreadable-', { startedAt: T0 - 5000 });
  t.after(() => b.stop());
  // a shell the board has no launch for, so it searches the agents' files for one
  b.session('readable', { status: 'busy' }, [prompt(T0), said(T0 + 1000, 'Reading it')], b.shells([runningToolShell(['serve'], 'serve < /dev/null'), b.task('bwant1')]));
  const agentMeta = b.agent('readable', 'h1', { description: 'Check the logs', agentType: 'general-purpose', toolUseId: 'toolH1' }, [prompt(T0 + 2000), call(Date.now() - 100, 'WebFetch', { url: 'https://example.com/' })]);
  // a directory opens and then fails to read, as a file on a failing disk would
  const dir = agentMeta.replace('h1.meta.json', 'd1.jsonl');
  fs.mkdirSync(dir);
  // btrfs gives an empty directory size 0, and the board reads nothing from a file of size 0
  fs.writeFileSync(path.join(dir, 'x'), '');
  b.session('unreadable', PERMISSION, [prompt(T0), said(T0 + 1000, 'Hidden')]);
  // a status file the board fails on, as a later Claude Code could write
  b.session('odd', { sessionId: 4242, name: '' }, [prompt(T0)]);
  const files = [b.transcript('unreadable'), agentMeta.replace(/\.meta\.json$/, '.jsonl')];
  // the status files stay readable and the transcripts do not, as after a sudo claude that kept HOME
  for (const f of files) fs.chmodSync(f, 0);
  try {
    fs.closeSync(fs.openSync(files[0], 'r'));
    return t.skip('file modes do not bind the user running the tests');
  } catch { /* unreadable, as wanted */ }
  await b.start();
  let snap = await b.listed(2);
  await t.test('the sessions with unreadable files are on the board, the unreadable one from its status file', () => {
    assert.equal(b.view(snap, 'readable').said.text, 'Reading it');
    assert.equal(b.view(snap, 'readable').agents.find((a) => a.id === 'h1').steps, 0);
    assert.equal(b.view(snap, 'unreadable').state, 'needs-you');
    assert.equal(b.view(snap, 'unreadable').said, null);
  });
  await t.test('a session the board fails on is left off and its error logged', () => {
    assert.equal(snap.sessions.find((v) => v.id === 4242), undefined);
    assert.match(b.errors, /session 4242: TypeError/);
  });
  for (const f of files) fs.chmodSync(f, 0o600);
  await b.polls(2);
  snap = await b.waitFor('the running shell', (st) => b.view(st, 'readable').shells.length > 0);
  await t.test('once they can be read: their conversations', () => {
    assert.equal(b.view(snap, 'unreadable').said.text, 'Hidden');
    assert.equal(b.view(snap, 'readable').agents.find((a) => a.id === 'h1').steps, 1);
    assert.deepEqual(b.view(snap, 'readable').shells.map((k) => k.id), ['bwant1']);
  });
  await t.test('the server logs each unreadable file once', () => {
    assert.equal(b.errors.split('EACCES').length - 1, files.length, b.errors);
    assert.equal(b.errors.split('EISDIR').length - 1, 1, b.errors);
    assert.match(b.errors, /cannot read \S*agent-d1\.jsonl \(EISDIR\)/);
  });
});

test('a session started from another keeps who started it after that one ends, and not once it runs again on its own', { timeout: SERVER_TEST_MS, skip: process.platform !== 'linux' && 'the /proc path is Linux only' }, async (t) => {
  const T0 = Date.now() - 60000;
  const b = new Board('started-', { startedAt: T0 });
  t.after(() => b.stop());
  const pidFile = path.join(b.dir, 'child.pid');
  const starter = b.spawn('sh', ['-c', 'sleep 600 & echo $! > "$0"; wait', pidFile]);
  while (!(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim())) await sleep(20);
  const lines = [prompt(T0), said(T0 + 1000)];
  const by = b.session('starter', { status: 'busy' }, lines, starter);
  const sid = b.session('started', { status: 'busy' }, lines, { pid: Number(fs.readFileSync(pidFile, 'utf8')) });
  await b.start();
  let snap = await b.waitFor('the started session under its starter', (s) => (b.view(s, 'started') || {}).parentSid === by);
  assert.deepEqual(snap.startedBy, { [sid]: by });
  process.kill(starter.pid, 'SIGKILL');
  snap = await b.waitFor('its starter gone', (s) => b.view(s, 'started') && !b.view(s, 'started').parentSid);
  assert.deepEqual(snap.startedBy, { [sid]: by });
  b.restart('started', { status: 'busy' });
  snap = await b.waitFor('its new process', (s) => (b.view(s, 'started') || {}).pid === b.sessions.started.pid);
  assert.deepEqual(snap.startedBy, {});
});

test('who started a session is kept while it or a session it started is on the board, until its steps leave every page, and not for a new process of it', () => {
  const K = STARTER_KEEP_MS;
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'live.js'), 'utf8');
  const held = Function('return ' + page.match(/const HIST_MS = ([^;]+);/)[1])() + Number(page.match(/now\(\) - HIST_MS - ([^;]+);/)[1]);
  assert.ok(K >= held + POLL_MS, 'a page keeps a step for ' + held + ' ms');
  const known = new Map();
  const c = (o) => Object.assign({ id: 'c', pid: 7, alive: true }, o);
  const d = { id: 'd', pid: 9, alive: true };
  assert.deepEqual(noteStarters(known, [c({ parentSid: 'p' })], 0), { c: 'p' });
  assert.deepEqual(noteStarters(known, [c({ alive: false })], 2 * K), { c: 'p' });
  assert.deepEqual(noteStarters(known, [], 3 * K), { c: 'p' });
  assert.deepEqual(noteStarters(known, [], 3 * K + 1), {});
  noteStarters(known, [c({ parentSid: 'p' }), Object.assign({ parentSid: 'c' }, d)], 0);
  assert.deepEqual(noteStarters(known, [d], 2 * K), { c: 'p', d: 'c' });
  assert.deepEqual(noteStarters(known, [c({ pid: 8 }), d], 2 * K + 1), { d: 'c' });
});

test('a busy session whose turn has ended waits on the background agents and workflows still running for it until a report or a message wakes it, and is stalled once none runs', { timeout: SERVER_TEST_MS, skip: process.platform !== 'linux' && 'the /proc path is Linux only' }, async (t) => {
  const Q0 = Date.now() - 20 * 60000;
  const b = new Board('bgwait-', { startedAt: Q0 - 5000 });
  t.after(() => b.stop());
  const busy = { status: 'busy', statusUpdatedAt: Q0 };
  const start = (id, desc) => [call(Q0 + 1000, 'Agent', { description: desc, prompt: 'watch', subagent_type: 'general-purpose', run_in_background: true }, id), result(Q0 + 1100, id, null, 'Async agent launched successfully.')];
  const meta = (id, desc) => ({ description: desc, agentType: 'general-purpose', toolUseId: id, requestShape: 'background' });
  const working = [prompt(Q0 + 1200), call(Date.now() - 100, 'Bash', { command: 'tail deploy.log' })];
  const report = '<task-notification>\n<task-id>gdone</task-id>\n<status>completed</status>\n</task-notification>';
  const queue = (t) => [{ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(t).toISOString(), content: report }, { type: 'queue-operation', operation: 'dequeue', timestamp: new Date(t + 10).toISOString() }];
  const peer = (t) => ({ type: 'user', isMeta: true, timestamp: new Date(t).toISOString(), message: { role: 'user', content: 'Another Claude session sent a message' } });
  b.session('one', busy, [prompt(Q0), ...start('tuOne', 'Watch the deploy'), said(Q0 + 2000)]);
  b.agent('one', 'g1', meta('tuOne', 'Watch the deploy'), working);
  b.agent('one', 'g1b', { description: 'Read the logs', agentType: 'general-purpose', toolUseId: 'tuSub', parentAgentId: 'g1', spawnDepth: 2 }, working);
  b.session('two', busy, [prompt(Q0), ...start('tuTwoA', 'Watch the deploy'), ...start('tuTwoB', 'Check the logs'), said(Q0 + 2000)]);
  b.agent('two', 'g2', meta('tuTwoA', 'Watch the deploy'), working);
  b.agent('two', 'g3', meta('tuTwoB', 'Check the logs'), working);
  b.session('flow', busy, [prompt(Q0), said(Q0 + 2000)]);
  b.workflow('flow', 'wf_bg1', 'w1', 'build:docs', working);
  b.session('flow-done', busy, [prompt(Q0), said(Q0 + 2000)]);
  b.workflow('flow-done', 'wf_bg2', 'w2', 'build:site', [prompt(Q0 + 1200), said(Q0 + 1500)]);
  fs.mkdirSync(path.join(b.projDir, b.sessions['flow-done'].sid, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(b.projDir, b.sessions['flow-done'].sid, 'workflows', 'wf_bg2.json'), JSON.stringify({ status: 'completed' }));
  b.session('cut', busy, [prompt(Q0), ...start('tuCut', 'Watch the deploy'), call(Q0 + 1500, 'Bash', { command: 'make' }), prompt(Q0 + 2000, '[Request interrupted by user]')]);
  b.agent('cut', 'g4', meta('tuCut', 'Watch the deploy'), working);
  b.session('shelled', busy, [prompt(Q0), ...start('tuSh', 'Run the watcher'), said(Q0 + 2000)], b.shells(['sleep 600', b.task('bwait1')]));
  b.agent('shelled', 'g6', meta('tuSh', 'Run the watcher'), [prompt(Q0 + 1200), call(Q0 + 1300, 'Bash', { command: 'npm run watch', description: 'Run the watcher', run_in_background: true }, 'tuW6'), launched(Q0 + 1400, 'tuW6', 'bwait1'), said(Q0 + 1500)]);
  b.session('orphan', busy, [prompt(Q0), ...start('tuOr', 'Plan the release'), said(Q0 + 2000)]);
  b.agent('orphan', 'g8', meta('tuOr', 'Plan the release'), [prompt(Q0 + 1200), said(Q0 + 1500)]);
  b.agent('orphan', 'g8b', { description: 'Read the logs', agentType: 'general-purpose', toolUseId: 'tuOrSub', parentAgentId: 'g8', spawnDepth: 2 }, working);
  b.session('stopped', busy, [prompt(Q0), ...start('tuSt', 'Plan the release'), said(Q0 + 2000)]);
  b.agent('stopped', 'g13', Object.assign(meta('tuSt', 'Plan the release'), { stoppedByUser: true }), [prompt(Q0 + 1200), said(Q0 + 1500)]);
  b.agent('stopped', 'g13b', { description: 'Read the logs', agentType: 'general-purpose', toolUseId: 'tuStSub', parentAgentId: 'g13', spawnDepth: 2 }, working);
  b.session('woken', busy, [prompt(Q0), ...start('tuWk', 'Watch the deploy'), said(Q0 + 2000), ...queue(Q0 + 2900), notification(Q0 + 3000, 'gdone')]);
  b.agent('woken', 'g9', meta('tuWk', 'Watch the deploy'), working);
  b.session('messaged', busy, [prompt(Q0), ...start('tuMs', 'Watch the deploy'), said(Q0 + 2000), ...queue(Q0 + 2900), peer(Q0 + 3000)]);
  b.agent('messaged', 'g10', meta('tuMs', 'Watch the deploy'), working);
  b.session('again', busy, [prompt(Q0), ...start('tuAg', 'Watch the deploy'), prompt(Q0 + 2000, '[Request interrupted by user]'), notification(Q0 + 2500, 'gdone'), said(Q0 + 3000)]);
  b.agent('again', 'g14', meta('tuAg', 'Watch the deploy'), working);
  b.session('cut-woken', busy, [prompt(Q0), ...start('tuCw', 'Watch the deploy'), prompt(Q0 + 2000, '[Request interrupted by user]'), peer(Q0 + 3000)]);
  b.agent('cut-woken', 'g11', meta('tuCw', 'Watch the deploy'), working);
  b.session('fg-cut', busy, [prompt(Q0), call(Q0 + 1000, 'Agent', { description: 'Check the logs', prompt: 'look', subagent_type: 'general-purpose' }, 'tuFg'), prompt(Q0 + 2000, '[Request interrupted by user]')]);
  b.agent('fg-cut', 'g12', { description: 'Check the logs', agentType: 'general-purpose', toolUseId: 'tuFg' }, working);
  b.session('mid', busy, [prompt(Q0), ...start('tuMid', 'Watch the deploy'), call(Date.now() - 2000, 'Bash', { command: 'make check', description: 'Check it' })]);
  b.agent('mid', 'g7', meta('tuMid', 'Watch the deploy'), working);
  b.session('none', busy, [prompt(Q0), ...start('tuNone', 'Watch the deploy'), said(Q0 + 2000)]);
  b.agent('none', 'g5', meta('tuNone', 'Watch the deploy'), [prompt(Q0 + 1200), said(Q0 + 1500)]);
  for (const k of ['one', 'two', 'flow', 'cut', 'shelled', 'orphan', 'stopped', 'flow-done', 'fg-cut', 'none']) fs.utimesSync(b.transcript(k), new Date(Q0 + 2000), new Date(Q0 + 2000));
  for (const k of ['woken', 'messaged', 'again', 'cut-woken']) fs.utimesSync(b.transcript(k), new Date(Q0 + 3000), new Date(Q0 + 3000));
  await b.start();
  const snap = await b.waitFor('the agent waiting on its shell', (st) => st.sessions.length >= 15 && b.view(st, 'shelled').agents.some((a) => a.state === 'waiting'));
  const look = (k) => { const v = b.view(snap, k); return [v.state, v.act && v.act.label, v.trouble && v.trouble.kind]; };
  const stalled = (k) => snap.attention.some((a) => a.sid === b.sessions[k].sid && a.text === 'No activity while working');
  assert.deepEqual(look('one'), ['working', 'Waiting on background agent: Watch the deploy', null]);
  assert.equal(b.view(snap, 'one').since, Q0 + 2000);
  assert.deepEqual(look('two'), ['working', 'Waiting on 2 background agents', null]);
  assert.deepEqual(look('flow'), ['working', 'Waiting on workflow: wf_bg1', null]);
  assert.deepEqual(look('cut'), ['working', 'Waiting on background agent: Watch the deploy', null]);
  assert.equal(b.view(snap, 'cut').since, Q0 + 2000);
  assert.deepEqual(look('orphan'), ['working', 'Waiting on background agent: Read the logs', null]);
  assert.deepEqual(look('again'), ['working', 'Waiting on background agent: Watch the deploy', null]);
  assert.equal(b.view(snap, 'again').since, Q0 + 3000);
  for (const k of ['stopped', 'flow-done', 'woken', 'messaged', 'cut-woken', 'fg-cut']) assert.deepEqual(look(k), ['working', 'Thinking', 'stalled'], k);
  assert.deepEqual(look('shelled'), ['working', 'Waiting on background agent: Run the watcher', null]);
  assert.deepEqual(look('mid'), ['working', 'Check it', null]);
  assert.deepEqual(look('none'), ['working', 'Thinking', 'stalled']);
  assert.deepEqual(['one', 'two', 'flow', 'cut', 'shelled', 'orphan', 'again', 'none'].map(stalled), [false, false, false, false, false, false, false, true]);
});
