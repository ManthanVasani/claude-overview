'use strict';

const TOOL_SHELL_RE = /\/shell-snapshots\//;

// Claude Code's quoting rewrites each quote
function cmdKey(cmd) {
  if (typeof cmd !== 'string') return null;
  const head = cmd.split(/['\n]/)[0].trim();
  // the cut can leave half an emoji, and macOS ps prints the whole one
  const key = head.slice(-60).replace(/^[\udc00-\udfff]/, '');
  return key.length >= 12 ? key : null;
}

// Claude Code's own text before the command can eval too
function evalCommand(line) {
  for (let at = line ? line.indexOf(' eval ') : -1; at >= 0; at = line.indexOf(' eval ', at + 1)) {
    const w = shellWord(line, at + 6);
    // older Claude Code wrote the redirect as \<
    if (w && w.cmd && /^(?: \\?< \/dev\/null)? && pwd -P >\| /.test(line.slice(w.end, w.end + 30))) return w.cmd;
  }
  return null;
}

function shellWord(line, i) {
  let cmd = '';
  while (i < line.length && line[i] !== ' ') {
    const q = line[i];
    if (q === '\\') {
      cmd += line.slice(i + 1, i + 2);
      i += 2;
      continue;
    }
    if (q !== "'" && q !== '"') {
      cmd += q;
      i++;
      continue;
    }
    const end = line.indexOf(q, i + 1);
    if (end < 0) return null;
    cmd += line.slice(i + 1, end);
    i = end + 1;
  }
  return { cmd, end: i };
}

// macOS ps prints 0xA7 as M-', so its text cannot be parsed back
function claudeQuote(cmd) {
  if (typeof cmd !== 'string') return null;
  if (/^[A-Za-z0-9_./:=@+,-]+$/.test(cmd)) return cmd;
  return "'" + cmd.replace(/'/g, `'"'"'`) + "'";
}

function evalWordIs(line, word) {
  const at = line ? line.lastIndexOf(' && pwd -P >| ') : -1;
  return at >= 0 && line.slice(0, at).replace(/ \\?< \/dev\/null$/, '').endsWith(' eval ' + word);
}

module.exports = { TOOL_SHELL_RE, cmdKey, evalCommand, claudeQuote, evalWordIs };
