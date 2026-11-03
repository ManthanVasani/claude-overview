'use strict';

// kept apart from the board's own reading of Claude Code's output, so a change cannot pass by changing both

const iso = (t) => new Date(t).toISOString();
let seq = 0;

function prompt(t, text) {
  return { type: 'user', timestamp: iso(t), message: { role: 'user', content: text || 'do the work' } };
}

function call(t, name, input, id) {
  const n = ++seq;
  return { type: 'assistant', timestamp: iso(t), message: { id: 'm' + n, role: 'assistant', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: id || 'tu' + n, name, input }] } };
}

function said(t, text) {
  return { type: 'assistant', timestamp: iso(t), message: { id: 'm' + (++seq), role: 'assistant', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: text || 'done' }] } };
}

function result(t, id, toolUseResult, text) {
  const r = { type: 'user', timestamp: iso(t), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text || 'ok' }] } };
  if (toolUseResult) r.toolUseResult = toolUseResult;
  return r;
}

function launched(t, id, task) {
  return result(t, id, null, 'Command running in background with ID: ' + task + '. Output is being written to: /x/tasks/' + task + '.output');
}

function notification(t, task) {
  return prompt(t, '<task-notification>\n<task-id>' + task + '</task-id>\n<status>completed</status>\n</task-notification>');
}

const PERMISSION = { status: 'waiting', waitingFor: 'permission prompt' };
const SCREEN = { status: 'waiting', waitingFor: 'dialog open' };

function quote(cmd) {
  return /^[A-Za-z0-9_./:=@+,-]+$/.test(cmd) ? cmd : "'" + cmd.replace(/'/g, `'"'"'`) + "'";
}

const SCRUB = '__cc_uc=; ( LC_ALL=C \\builtin eval \': "${__cc_uc^^}"\' ) 2>/dev/null && __cc_uc=b; \\builtin test -n "$__cc_uc" || { ( LC_ALL=C \\builtin eval \': "${(U)__cc_uc}"\' ) 2>/dev/null && __cc_uc=z; } || \\builtin true && __cc_upper="$__cc_name"; case "$__cc_uc" in b) LC_ALL=C \\builtin eval \'__cc_upper="${__cc_name^^}"\';; z) LC_ALL=C \\builtin eval \'__cc_upper="${(U)__cc_name}"\';; esac && \\builtin eval "__cc_set=\\${$__cc_name+x}"; \\builtin test -n "$__cc_set"';

const SNAPSHOT = { bash: '/home/u/.claude/shell-snapshots/snapshot-bash-1-x.sh', zsh: '/Users/u/.claude/shell-snapshots/snapshot-zsh-1-x.sh' };

function toolScript(afterEval, opts) {
  const o = Object.assign({ shell: 'bash', prelude: '', cwdFile: '/tmp/claude-ab12-cwd' }, opts);
  // zsh has no shopt
  const reset = o.shell === 'bash' ? "shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; }" : "{ \\builtin unalias -- 'unsetenv'; }";
  return 'source ' + SNAPSHOT[o.shell] + ' 2>/dev/null || true && ' + reset + ' >/dev/null 2>&1 || true && ' + (o.prelude ? o.prelude + ' && ' : '') + 'eval ' + afterEval + ' && pwd -P >| ' + o.cwdFile;
}

function toolShellArgv(afterEval, opts) {
  return ['/bin/' + ((opts && opts.shell) || 'bash'), '-c', toolScript(afterEval, opts)];
}

// /proc's line ends with the space its last NUL becomes
function toolShellLine(afterEval, opts) {
  return toolShellArgv(afterEval, opts).join(' ') + ' ';
}

module.exports = { prompt, call, said, result, launched, notification, PERMISSION, SCREEN, quote, SCRUB, toolScript, toolShellArgv, toolShellLine };
