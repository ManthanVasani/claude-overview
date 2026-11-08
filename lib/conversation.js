'use strict';

const { BUCKET_MS, BUCKETS, RETRY_FRESH_MS, STALL_MS, NEEDS_YOU_TOOLS, AGENT_TOOLS, SHELL_TOOLS } = require('./constants');
const { cmdKey } = require('./shell-line');
const { recordStep, stepById, endStep, noteLateEnd, cutPending } = require('./steps');
const { oneLine, plainText, entryTime, textOf, toolError } = require('./text');
const { describe, shellDesc } = require('./tools');

const COMMAND_ECHO_RE = /^<(command-name|command-message|local-command-|bash-(input|stdout|stderr)|user-memory-input)/;
// a command's output can quote another task's launch line
const TASK_ID_RE = /^(?:Command running in background with ID: |Command did not complete within [^\n]*?background \(ID: |Command was manually backgrounded by user with ID: |Monitor started \(task )([A-Za-z0-9_-]+)/;

function startedId(result, r) {
  if (r) return r.backgroundTaskId || r.taskId || null;
  const mm = TASK_ID_RE.exec(textOf(result.content) || '');
  return mm ? mm[1] : null;
}

function stoppedCommand(result) {
  try {
    const o = JSON.parse(textOf(result.content));
    return o.task_type === 'local_bash' ? o.task_id || null : null;
  } catch { return null; }
}

// the live reader and the backward search must agree on what launched a task
function launchId(name, result, r) {
  return SHELL_TOOLS.has(name) ? startedId(result, r) : null;
}

function newConv(S, owner) {
  return {
    S,
    owner,
    pending: new Map(),
    prompt: null,
    promptAt: 0,
    lastPromptEntry: null,
    aiTitle: null,
    customTitle: null,
    branch: null,
    model: null,
    ctx: 0,
    prs: new Map(),
    lastAt: 0,
    lastActAt: 0,
    endedAt: 0,
    endedBy: null,
    handback: 0,
    said: null,
    steps: 0,
    agentPrompts: new Map(),
    recent: [],
    buckets: new Map(),
    workflows: new Map(),
    apiErr: null,
    fatal: null,
    interruptedAt: 0,
  };
}

function liveConvs(S) {
  const out = [S.conv];
  for (const a of S.agents.values()) if (a.conv) out.push(a.conv);
  for (const w of S.wfs.values()) if (w.agents) for (const a of w.agents.values()) if (a.conv) out.push(a.conv);
  return out;
}

function endRecord(status, at) {
  return { status, at, summary: null, exit: null, waiting: false };
}

function setEnd(S, key, rec) {
  if (!S || !key) return;
  const prev = S.ends.get(key);
  if (prev && prev.at > rec.at) return;
  S.ends.delete(key);
  S.ends.set(key, rec);
  if (S.ends.size > 4000) S.ends.delete(S.ends.keys().next().value);
}

function noteNotification(c, content, t) {
  if (typeof content !== 'string' || content.indexOf('<task-notification>') === -1) return;
  const st = /<status>([^<]+)<\/status>/.exec(content);
  if (!st) return;
  const summary = /<summary>([^<]*)<\/summary>/.exec(content);
  const exit = /exit code (\d+)/.exec(summary ? summary[1] : '');
  const rec = {
    status: st[1].trim(),
    at: t,
    summary: summary ? oneLine(summary[1], 200) : null,
    exit: exit ? Number(exit[1]) : null,
    waiting: content.indexOf('waiting on its own background work') !== -1,
  };
  const task = /<task-id>([^<]+)<\/task-id>/.exec(content);
  const tool = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(content);
  if (task) setEnd(c.S, task[1].trim(), rec);
  if (tool) setEnd(c.S, tool[1].trim(), rec);
}

function newTask(id, owner, startedAt, needsInfo) {
  return { id, owner, ownerSure: false, desc: null, kind: 'shell', startedAt, cmdKey: null, timeoutMs: null, seenRunning: 0, goneAt: 0, needsInfo, tried: false, fallback: null };
}

function registerTask(c, id, info) {
  const S = c.S;
  if (!S || !id) return;
  let k = S.tasks.get(id);
  if (!k) {
    k = newTask(id, c.owner, 0, false);
    S.tasks.set(id, k);
  }
  if (info.launch) {
    k.owner = c.owner;
    k.ownerSure = true;
    if (info.at) k.startedAt = info.at;
  } else if (!k.ownerSure) {
    k.owner = c.owner;
  }
  if (info.desc) { k.desc = info.desc; k.needsInfo = false; }
  if (info.kind) k.kind = info.kind;
  if (info.cmd && !k.cmdKey) k.cmdKey = cmdKey(info.cmd);
  if (info.cmd) k.timed = /(?:^|[\s;&|(])timeout\s/.test(info.cmd);
  if (info.timeoutMs) k.timeoutMs = info.timeoutMs;
  if (!k.startedAt && info.at) k.startedAt = info.at;
}

function bump(c, t) {
  if (!t) return;
  const b = Math.floor(t / BUCKET_MS);
  c.buckets.set(b, (c.buckets.get(b) || 0) + 1);
  if (c.buckets.size > BUCKETS * 2) {
    const min = Math.floor(Date.now() / BUCKET_MS) - BUCKETS;
    for (const k of c.buckets.keys()) if (k < min) c.buckets.delete(k);
  }
}

function applyAssistant(c, d, t) {
  const m = d.message || {};
  if (d.gitBranch) c.branch = d.gitBranch;
  if (d.isApiErrorMessage) {
    c.fatal = { text: oneLine(textOf(m.content) || d.error || 'API error', 220), kind: d.apiError || d.error || null, at: t };
    c.apiErr = null;
    cutPending(c, t);
    c.pending.clear();
    c.endedAt = t;
    c.endedBy = 'error';
    return;
  }
  if (m.model === '<synthetic>') return;
  c.fatal = null;
  c.apiErr = null;
  c.lastActAt = t;
  if (m.model) c.model = m.model;
  const u = m.usage;
  if (u) {
    const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
    if (ctx > 0) c.ctx = ctx;
  }
  const stop = m.stop_reason || null;
  c.endedAt = stop === 'end_turn' ? t : 0;
  c.endedBy = 'reply';
  for (const x of Array.isArray(m.content) ? m.content : []) {
    if (!x) continue;
    if (x.type === 'tool_use') {
      const input = x.input || {};
      if (x.name === 'SubagentHandback') c.handback = t || Date.now();
      if (AGENT_TOOLS.has(x.name) && input.prompt) {
        c.agentPrompts.set(x.id, oneLine(plainText(input.prompt), 900));
        if (c.agentPrompts.size > 400) c.agentPrompts.delete(c.agentPrompts.keys().next().value);
      }
      const label = describe(x.name, input);
      c.steps++;
      const shell = SHELL_TOOLS.has(x.name);
      c.pending.set(x.id, {
        name: x.name,
        label,
        at: t,
        bg: x.name === 'Monitor' || !!input.run_in_background,
        desc: shell ? shellDesc(input) : null,
        cmd: shell ? input.command : null,
        ev: recordStep(c, x.id, x.name, input, label, t, d.cwd),
      });
      c.recent.push({ at: t, label, tool: x.name });
      if (c.recent.length > 8) c.recent.shift();
      bump(c, t);
    } else if (x.type === 'text' && x.text && x.text.trim()) {
      c.said = { text: oneLine(plainText(x.text), 240), at: t };
    }
  }
  if (stop === 'end_turn') {
    cutPending(c, t);
    c.pending.clear();
  }
}

function applyUser(c, d, t) {
  const m = d.message || {};
  if (d.gitBranch) c.branch = d.gitBranch;
  const content = m.content;
  let isResult = false;
  if (Array.isArray(content)) {
    for (const x of content) {
      if (!x || x.type !== 'tool_result') continue;
      isResult = true;
      const p = c.pending.get(x.tool_use_id);
      c.pending.delete(x.tool_use_id);
      const ev = stepById(x.tool_use_id);
      const err = toolError(x);
      if (ev) endStep(ev, t, x.is_error ? 0 : 1, err);
      else noteLateEnd(x.tool_use_id, t, x.is_error ? 0 : 1, err);
      const r = d.toolUseResult && typeof d.toolUseResult === 'object' ? d.toolUseResult : null;
      const launched = r && r.status === 'async_launched';
      if (launched && r.runId) c.workflows.set(r.runId, { name: r.workflowName || null, summary: r.summary || null, at: t });
      if (!launched && p && AGENT_TOOLS.has(p.name)) {
        setEnd(c.S, x.tool_use_id, endRecord(x.is_error ? 'failed' : 'completed', t));
      }
      // a command stopped with TaskStop mostly gets no notification of its end, unlike an agent
      const stopped = p && p.name === 'TaskStop' ? stoppedCommand(x) : null;
      if (stopped) setEnd(c.S, stopped, endRecord('stopped', t));
      const id = p ? launchId(p.name, x, r) : null;
      if (id) registerTask(c, id, { launch: true, desc: p.desc, kind: p.name === 'Monitor' ? 'monitor' : 'shell', at: p.at, cmd: p.cmd, timeoutMs: r && r.timeoutMs });
    }
  }
  if (isResult) {
    c.apiErr = null;
    c.lastActAt = t;
  }
  // a compaction summary is neither a turn nor your prompt, and the session can go on after it
  if (d.isCompactSummary) {
    c.fatal = null;
    c.apiErr = null;
    return;
  }
  const text = isResult ? '' : textOf(content).trim();
  // a command's echo starts no turn; a command that prompts the model adds the prompt as its own entry
  if (!d.queueTranscriptOnly && !COMMAND_ECHO_RE.test(text)) c.endedAt = 0;
  if (isResult || d.isMeta) return;
  if (!text) return;
  if (text.indexOf('<task-notification>') !== -1) {
    noteNotification(c, text, t);
    return;
  }
  if (text.startsWith('[Request interrupted')) {
    c.interruptedAt = t;
    c.endedAt = t;
    c.endedBy = 'interrupt';
    c.apiErr = null;
    cutPending(c, t);
    c.pending.clear();
    return;
  }
  if (d.isSidechain || text[0] === '<') return;
  c.prompt = text;
  c.promptAt = t;
  cutPending(c, t);
  c.pending.clear();
  c.fatal = null;
  c.apiErr = null;
  c.interruptedAt = 0;
}

function apply(c, d) {
  if (!d || typeof d !== 'object') return;
  const t = entryTime(d);
  if (t > c.lastAt) c.lastAt = t;
  switch (d.type) {
    case 'last-prompt': if (d.lastPrompt) c.lastPromptEntry = d.lastPrompt; break;
    case 'ai-title': if (d.aiTitle) c.aiTitle = d.aiTitle; break;
    case 'custom-title': if (d.customTitle) c.customTitle = d.customTitle; break;
    case 'pr-link':
      if (d.prNumber) c.prs.set((d.prRepository || '') + '#' + d.prNumber, { n: d.prNumber, url: d.prUrl || null, repo: d.prRepository || null });
      break;
    case 'queue-operation': noteNotification(c, d.content, t); break;
    case 'assistant': applyAssistant(c, d, t); break;
    case 'user': applyUser(c, d, t); break;
    case 'system':
      if (d.subtype === 'api_error') {
        const e = d.error || {};
        c.apiErr = {
          text: oneLine(e.formatted || e.message || 'API error', 160),
          attempt: d.retryAttempt || null,
          max: d.maxRetries || null,
          down: !!e.isNetworkDown,
          at: t,
        };
      } else if (d.subtype === 'stop_hook_summary') {
        // outside bare mode, Claude Code runs the model again on context a Stop or SubagentStop hook adds
        const more = Array.isArray(d.hookAdditionalContext) && d.hookAdditionalContext.length > 0;
        if (more && !d.preventedContinuation) c.endedAt = 0;
      }
      break;
    case 'attachment': {
      const a = d.attachment;
      if (!a) break;
      if (a.type === 'queued_command' && typeof a.prompt === 'string') noteNotification(c, a.prompt, t);
      else if (a.type === 'task_status' && a.taskId && !/agent|workflow/.test(a.taskType || '')) {
        registerTask(c, a.taskId, { desc: a.description ? oneLine(a.description, 140) : null, at: t, cmd: a.shell && a.shell.command, kind: /monitor/.test(a.taskType || '') ? 'monitor' : null });
        if (a.status && a.status !== 'running' && c.S && !c.S.ends.has(a.taskId)) {
          setEnd(c.S, a.taskId, endRecord(a.status, t));
        }
      }
      break;
    }
    default: break;
  }
}

function agentNow(conv) {
  if (!conv) return null;
  const pend = [...conv.pending.values()].sort((a, b) => b.at - a.at);
  if (pend.length) return { label: pend[0].label, since: pend[0].at, tool: pend[0].name };
  if (conv.lastAt) return { label: 'Thinking', since: conv.lastAt };
  return null;
}

function permissionOf(blocked, conv) {
  const b = blocked.find((x) => x.c === conv);
  return b ? { kind: 'permission', text: 'Waiting for your permission: ' + b.p.label, since: b.since, tool: b.p.name } : null;
}

function troubleOf(c, now, blocked, hasProc) {
  if (c.apiErr && now - c.apiErr.at < RETRY_FRESH_MS) {
    const n = c.apiErr.attempt && c.apiErr.max ? ' · retry ' + c.apiErr.attempt + ' of ' + c.apiErr.max : '';
    return { kind: 'retrying', text: c.apiErr.text + n, since: c.apiErr.at, down: c.apiErr.down };
  }
  const perm = permissionOf(blocked, c);
  if (perm) return perm;
  const lastAt = c.lastAt;
  if (!lastAt) return null;
  const waitingOnChild = [...c.pending.values()].some((p) => AGENT_TOOLS.has(p.name) || NEEDS_YOU_TOOLS.has(p.name) || (p.name === 'Bash' && !p.bg && hasProc));
  if (!waitingOnChild && now - lastAt > STALL_MS) return { kind: 'stalled', text: 'No activity', since: lastAt };
  return null;
}

module.exports = { newConv, liveConvs, newTask, launchId, startedId, apply, agentNow, permissionOf, troubleOf };
