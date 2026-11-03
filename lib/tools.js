'use strict';

const path = require('path');
const { HOME } = require('./config');
const { HOME_RE, oneLine, shortPath, host } = require('./text');

const SCRATCH_OWNER_RE = /^.*?\/claude-\d+\/[^/]+\/([0-9a-f-]{36})\/scratchpad/;
const TASK_OUTPUT_RE = /\/claude-\d+\/[^ ]*\/tasks\/[^/]+\.output$/;
const FILE_TOOLS = new Set(['grep', 'rg', 'sed', 'cat', 'head', 'tail', 'wc', 'ls', 'awk', 'diff', 'cmp', 'find', 'stat', 'du', 'less', 'jq', 'cut', 'sort', 'uniq', 'tr', 'file', 'md5sum', 'sha256sum', 'cp', 'mv', 'mkdir', 'touch', 'chmod', 'tee']);
const RUNNERS = new Set(['node', 'python', 'python3', 'ruby', 'bash', 'sh', 'perl']);
const PATHLIKE = /^(?:[~./]|[\w-]+\/)[^\s'"|;&<>()$`*]*$|^[\w.-]+\.(?:rb|js|ts|json|md|ya?ml|html|erb|css|scss|py|sh|txt|log|tsv|csv|sql|output)$/;

function describe(name, i) {
  i = i || {};
  switch (name) {
    case 'Bash': return i.description ? oneLine(i.description, 140) : '$ ' + oneLine(i.command, 140);
    case 'Read': return 'Reading ' + shortPath(i.file_path);
    case 'Edit':
    case 'MultiEdit': return 'Editing ' + shortPath(i.file_path);
    case 'Write': return 'Writing ' + shortPath(i.file_path);
    case 'NotebookEdit': return 'Editing ' + shortPath(i.notebook_path);
    case 'Grep': return 'Searching for "' + oneLine(i.pattern, 60) + '"' + (i.path ? ' in ' + shortPath(i.path) : '');
    case 'Glob': return 'Finding files ' + oneLine(i.pattern, 70);
    case 'Agent':
    case 'Task': return 'Starting agent: ' + oneLine(i.description || i.subagent_type, 100);
    case 'Workflow': {
      const m = /name:\s*['"]([^'"]+)/.exec(i.script || '');
      return 'Starting workflow ' + (m ? m[1] : (i.name || ''));
    }
    case 'WebSearch': return 'Web search: ' + oneLine(i.query, 100);
    case 'WebFetch': return 'Fetching ' + host(i.url);
    case 'AskUserQuestion': {
      const q = Array.isArray(i.questions) && i.questions[0] && i.questions[0].question;
      return 'Asking you: ' + oneLine(q, 140);
    }
    case 'ExitPlanMode': return 'Waiting for you to approve its plan';
    case 'Skill': return 'Running skill /' + (i.skill || '');
    case 'ToolSearch': return 'Loading tools';
    case 'TodoWrite': return 'Updating its to-do list';
    case 'ScheduleWakeup': return 'Sleeping ' + Math.max(1, Math.round((i.delaySeconds || 0) / 60)) + ' min';
    case 'SendMessage': return 'Messaging ' + oneLine(i.to, 60);
    case 'Monitor': return 'Watching: ' + oneLine(i.description || i.command, 100);
    case 'TaskStop': return 'Stopping a task';
    case 'StructuredOutput': return 'Writing its result';
    case 'Artifact': return 'Publishing a page';
  }
  if (typeof name === 'string' && name.startsWith('mcp__')) {
    const parts = name.split('__');
    const server = (parts[1] || '').replace(/^claude_ai_/, '');
    return server + ' · ' + (parts.slice(2).join('__') || '') + (i.url ? ' ' + host(i.url) : '');
  }
  return String(name || 'tool');
}

function shellDesc(i) {
  i = i || {};
  return oneLine(i.description || ('$ ' + (i.command || '')), 140);
}

function fileKey(p, cwd) {
  if (!p) return null;
  p = String(p).replace(/^['"]|['"]$/g, '');
  if (cwd && !p.startsWith('/') && !p.startsWith('~')) p = path.join(cwd, p);
  if (p.startsWith('~')) p = HOME + p.slice(1);
  if (TASK_OUTPUT_RE.test(p)) return null;
  // each session has its own scratchpad: the key keeps whose it is
  return 'file:' + path.normalize(p).replace(/(.)\/$/, '$1').replace(SCRATCH_OWNER_RE, (all, sid) => 'scratchpad@' + sid.slice(0, 8)).replace(HOME_RE, '~');
}

function commandKey(cmd, cwd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (/\bgh\s+(?:pr|api|issue|run|repo)\b|\bgit\s+(?:push|fetch|pull|ls-remote)\b/.test(cmd)) return 'svc:github';
  let m = /\bssh\s+(?:-[BbcDEeFIiJLlmOopQRSWw]\s*\S+\s+|-[46AaCfGgKkMNnqsTtVvXxYy]+\s+)*(?:[\w.-]+@)?([\w.][\w.-]*)/.exec(cmd);
  if (m) return 'host:' + m[1];
  m = /\bcurl\b[^|;&]*?https?:\/\/([\w.-]+(?::\d+)?)/.exec(cmd);
  if (m) return 'host:' + m[1];
  if (/\brspec\b/.test(cmd)) return 'tool:rspec';
  if (/playwright|chromium|puppeteer/.test(cmd)) return 'tool:browser';
  const vars = {};
  let dir = cwd || null;
  const sub = (x) => x.replace(/\$\{?(\w+)\}?/g, (all, v) => (v in vars ? vars[v] : all));
  for (let seg of cmd.split(/\s*(?:&&|\|\||;|\n)\s*/)) {
    seg = seg.replace(/^(?:do|then|else|\{|\()\s+/, '').split(/\s\|\s?/)[0].trim();
    if (!seg || /^(?:done|fi|esac|\}|\))$/.test(seg)) continue;
    m = /^(\w+)=(\S*)$/.exec(seg);
    if (m) { vars[m[1]] = sub(m[2].replace(/^['"]|['"]$/g, '')); continue; }
    m = /^cd\s+(\S+)$/.exec(seg);
    if (m) {
      const target = sub(m[1].replace(/^['"]|['"]$/g, '')).replace(/^~(?=\/|$)/, HOME);
      dir = target.startsWith('/') ? target : path.join(dir || HOME, target);
      continue;
    }
    const words = seg.split(/\s+/).map(sub);
    let i = 0;
    while (i < words.length && (/^\w+=/.test(words[i]) || /^(?:timeout|nice|ionice|time|sudo|exec|env|bundle|-\S*|\d+[smh]?)$/.test(words[i]))) i++;
    const w = path.basename((words[i] || '').replace(/^['"(]+|['");]+$/g, ''));
    if (!w || !/^[\w.-]+$/.test(w)) continue;
    if (/^(?:for|while|until|if|case|echo|printf|sleep|true|false|test|\[|\[\[|export|local|set|read|wait|trap|source|\.)$/.test(w)) continue;
    if (w === 'git') {
      const c = words.indexOf('-C', i);
      return c > 0 && words[c + 1] ? fileKey(words[c + 1], dir) : dir ? fileKey(dir) : 'tool:git';
    }
    const args = words.slice(i + 1).filter((x) => x && x[0] !== '-' && !/^\d*>|^\/dev\//.test(x)).map((x) => (x.indexOf('*') > 0 ? x.slice(0, x.lastIndexOf('/', x.indexOf('*')) + 1) : x)).filter(Boolean);
    if (FILE_TOOLS.has(w)) {
      for (let j = args.length - 1; j >= 0; j--) if (PATHLIKE.test(args[j])) return fileKey(args[j], dir);
      continue;
    }
    if (RUNNERS.has(w)) {
      const a0 = args.find((x) => PATHLIKE.test(x));
      return a0 ? fileKey(a0, dir) : dir && dir !== cwd ? fileKey(dir) : 'cmd:' + w;
    }
    return 'cmd:' + w;
  }
  return dir && dir !== cwd ? fileKey(dir) : null;
}

function classify(name, i, cwd) {
  i = i || {};
  switch (name) {
    case 'Read': return { k: 'read', r: fileKey(i.file_path) };
    case 'Edit':
    case 'MultiEdit':
    case 'Write': return { k: 'edit', r: fileKey(i.file_path) };
    case 'NotebookEdit': return { k: 'edit', r: fileKey(i.notebook_path) };
    case 'Grep':
    case 'Glob': return { k: 'search', r: fileKey(i.path || cwd) };
    case 'Bash':
    case 'Monitor': return { k: 'run', r: commandKey(i.command, cwd) };
    case 'WebFetch': return { k: 'web', r: 'web:' + host(i.url) };
    case 'WebSearch': return { k: 'web', r: 'web:search' };
    case 'Agent':
    case 'Task':
    case 'Workflow': return { k: 'agent', r: null };
    case 'AskUserQuestion':
    case 'ExitPlanMode': return { k: 'ask', r: null };
    case 'Skill': return { k: 'other', r: i.skill ? 'skill:' + i.skill : null };
  }
  if (typeof name === 'string' && name.startsWith('mcp__')) return { k: 'svc', r: 'svc:' + (name.split('__')[1] || '').replace(/^claude_ai_/, '') };
  return { k: 'other', r: null };
}

module.exports = { describe, shellDesc, classify };
