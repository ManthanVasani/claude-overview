'use strict';

const MIN = 60000;
const HOUR = 60 * MIN;
const EV_KEEP_MS = 3 * HOUR;

module.exports = {
  MIN,
  HOUR,
  POLL_MS: 2000,
  RESCAN_MS: 30000,
  NEW_SESSION_RESCAN_MS: 3000,
  SESSION_FIRST_BYTES: 4 << 20,
  AGENT_FIRST_BYTES: 1 << 20,
  JOURNAL_FIRST_BYTES: 16 << 20,
  MAX_READ_PER_POLL: 32 << 20,
  MAX_PENDING_LINE: 64 << 20,
  HEAD_BYTES: 64 << 10,
  BACKFILL_CHUNK: 4 << 20,
  BACKFILL_PER_FILE: 64 << 20,
  BACKFILL_PER_RUN: 256 << 20,
  HIST_SLICE: 16 << 20,
  HIST_PER_FILE: 192 << 20,
  LATE_ENDS_MAX: 20000,
  DONE_VISIBLE_MS: 2 * HOUR,
  PROBLEM_VISIBLE_MS: 12 * HOUR,
  ENDED_VISIBLE_MS: 2 * HOUR,
  ATTENTION_MS: 2 * HOUR,
  SHELL_DONE_VISIBLE_MS: 10 * MIN,
  SHELL_PROBLEM_VISIBLE_MS: HOUR,
  WF_DONE_VISIBLE_MS: 30 * MIN,
  WORKFLOW_STALE_MS: 2 * HOUR,
  STALL_MS: 8 * MIN,
  LOST_MS: 2 * HOUR,
  RETRY_FRESH_MS: 10 * MIN,
  PERMISSION_MS: 15000,
  // a prompt usually comes right after its call and that call's hooks
  PROMPT_LEAD_MS: 5000,
  DEATH_GRACE_MS: 20000,
  FINAL_SETTLE_MS: 5000,
  BUCKET_MS: 15000,
  BUCKETS: 40,
  EV_KEEP_MS,
  // a page holds a step a little longer than the server does
  STARTER_KEEP_MS: EV_KEEP_MS + 5 * MIN,
  EV_HISTORY_MS: 3 * HOUR,
  EV_MAX: 60000,
  NEEDS_YOU_TOOLS: new Set(['AskUserQuestion', 'ExitPlanMode']),
  AGENT_TOOLS: new Set(['Agent', 'Task']),
  SHELL_TOOLS: new Set(['Bash', 'Monitor']),
};
