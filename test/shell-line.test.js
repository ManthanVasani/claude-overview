'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { claudeQuote, cmdKey, evalCommand } = require('../lib/shell-line');
const real = require('./fixtures/tool-shell-lines.json');
const { quote, SCRUB, toolShellLine } = require('./helpers/claude-code');

test('reads the command from tool shell lines Claude Code wrote', () => {
  for (const { argv, command } of real.lines) assert.equal(evalCommand(argv.join(' ') + ' '), command);
});

const CASES = [
  ['one word, with < /dev/null', toolShellLine('make < /dev/null'), 'make'],
  ['one word, no redirect', toolShellLine('pytest'), 'pytest'],
  ['a quote and a < of its own', toolShellLine(quote("build --tag 'v1' < notes.txt")), "build --tag 'v1' < notes.txt"],
  ['several lines', toolShellLine(quote('echo a\necho b')), 'echo a\necho b'],
  ['a command that runs eval itself', toolShellLine(quote('eval "$(ssh-agent)"')), 'eval "$(ssh-agent)"'],
  ['a command ending in a quote', toolShellLine(quote("echo hi'there'")), "echo hi'there'"],
  ["a quote written '\\''", toolShellLine("'it'\\''s x' < /dev/null"), "it's x"],
  ['after the credential-scrub prelude', toolShellLine(quote('git status') + ' < /dev/null', { prelude: SCRUB }), 'git status'],
  ['older quoting: a quoted command and \\<', toolShellLine("'npm run dev' \\< /dev/null"), 'npm run dev'],
  ['older quoting: a bare word with an escape and \\<', toolShellLine('make\\:all \\< /dev/null'), 'make:all'],
  ['after an env file that runs eval', toolShellLine(quote("npm test -- --grep 'a b'"), { prelude: 'eval "$(conda shell.bash hook)"\nconda activate x\n:' }), "npm test -- --grep 'a b'"],
];

for (const [name, line, want] of CASES) {
  test('reads the command: ' + name, () => assert.equal(evalCommand(line), want));
}

test("a shell running echo hi'there' is not the call echo hi", () => {
  assert.notEqual(evalCommand(toolShellLine(quote("echo hi'there'"))), 'echo hi');
});

test('a line cut inside its quote has no command', () => {
  const line = toolShellLine(quote('echo a b'));
  assert.equal(evalCommand(line.slice(0, line.indexOf(' b'))), null);
});

test('a line that is not a tool shell has no command', () => {
  assert.equal(evalCommand('/bin/sh -c ~/.claude/hooks/perm.sh'), null);
  assert.equal(evalCommand(null), null);
});

test('every command Claude Code quotes reads back as itself', () => {
  const pieces = ['echo ', 'grep ', "'", '"', '\\', ' ', '\t', '\n', 'M-', '^', 'ç', 'で', '§', '😀', '\\012', 'x', '$HOME', '<', '|', 'a b', ' eval ', ' && pwd -P >| '];
  let seed = 11;
  const r = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 20000; k++) {
    let cmd = 'x';
    for (let n = Math.floor(r() * 8); n >= 0; n--) cmd += pieces[Math.floor(r() * pieces.length)];
    const line = toolShellLine(claudeQuote(cmd) + (cmd.includes('<') ? '' : ' < /dev/null'));
    assert.equal(evalCommand(line), cmd, JSON.stringify(cmd));
  }
});

test('the Monitor key is the text before the first quote or line break, and none when that is short', () => {
  assert.equal(cmdKey("tail -f /var/log/app.log | grep 'E'"), 'tail -f /var/log/app.log | grep');
  assert.equal(cmdKey('tail -f /var/log/app.log\ngrep E'), 'tail -f /var/log/app.log');
  assert.equal(cmdKey("grep 'E' x"), null);
  assert.equal(cmdKey(null), null);
});

test('a Monitor key cut inside an emoji drops the half left at its start', () => {
  const cmd = 'tail -f /x/\u{1F600}/' + 'a'.repeat(47) + ".log | grep 'E'";
  const key = cmdKey(cmd);
  assert.ok(!/^[\udc00-\udfff]/.test(key));
  assert.ok(cmd.includes(key));
});
