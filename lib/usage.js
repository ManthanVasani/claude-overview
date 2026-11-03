'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { ROOT, PROJECTS_DIR, USAGE_INDEX, CSWAP_DIR } = require('./config');
const { MIN } = require('./constants');
const { pad, dayKey } = require('./days');
const { readJson } = require('./files');
const log = require('./log');
const { HOME_RE } = require('./text');

let usageSummary = null;

function start() {
  let w;
  try {
    w = new Worker(path.join(__dirname, 'usage-scan.js'), { workerData: { root: PROJECTS_DIR, index: USAGE_INDEX, seed: path.join(ROOT, 'usage-index.json') } });
  } catch (e) { log.once(e); return; }
  w.on('message', (m) => {
    if (m.notice) log.once(m.notice);
    else usageSummary = m;
  });
  w.on('error', log.once);
  w.on('exit', () => setTimeout(start, MIN));
}

// cswap's credentials are never read.
function cswapAccounts() {
  const seq = readJson(path.join(CSWAP_DIR, 'sequence.json'));
  if (!seq || !seq.accounts) return null;
  const store = readJson(path.join(CSWAP_DIR, 'cache', 'usage.json'));
  const rows = (store && store.schemaVersion === 2 && store.accounts) || {};
  const sw = readJson(path.join(CSWAP_DIR, 'autoswitch_state.json')) || {};
  const now = Date.now();
  const win = (w) => {
    if (!w || typeof w.pct !== 'number') return null;
    const at = w.resets_at ? Date.parse(w.resets_at) : 0;
    // a window whose reset has passed has rolled over, so its stored percentage is stale
    return at && at <= now ? { pct: 0, at: 0 } : { pct: w.pct, at };
  };
  const nums = Array.isArray(seq.sequence) && seq.sequence.length ? seq.sequence : Object.keys(seq.accounts).map(Number);
  const list = [];
  for (const num of nums) {
    const a = seq.accounts[String(num)];
    if (!a) continue;
    const row = rows[String(num)];
    const ok = !!row && row.email === a.email;
    const g = (ok && row.lastGood) || {};
    list.push({
      num,
      email: a.email || '',
      alias: a.alias || '',
      org: a.organizationName || '',
      active: num === seq.activeAccountNumber,
      disabled: !!a.disabled,
      apiKey: a.kind === 'api_key',
      h5: win(g.five_hour),
      d7: win(g.seven_day),
      scoped: (Array.isArray(g.scoped) ? g.scoped : []).map((x) => Object.assign({ name: String(x.name || '') }, win(x))).filter((x) => x.pct != null),
      fetched: ok && row.fetchedAt ? row.fetchedAt * 1000 : 0,
      error: (ok && row.lastError) || null,
      dead: ok && (row.authDeadStrikes || 0) >= 1,
    });
  }
  return { list, lastSwitch: sw.lastSwitchAt ? { at: sw.lastSwitchAt * 1000, from: sw.lastSwitchFrom, to: sw.lastSwitchTo } : null };
}

function localDay(back) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return dayKey(d);
}
function addInto(a, b) { for (let i = 0; i < 5; i++) a[i] += b[i]; }

function usageReply(range, snapshot) {
  const RANGES = { today: 1, '7d': 7, '30d': 30, month: 0, all: 0 };
  if (!Object.prototype.hasOwnProperty.call(RANGES, range)) range = '7d';
  const out = { now: Date.now(), range, accounts: cswapAccounts(), progress: usageSummary ? usageSummary.progress : null };
  const u = usageSummary;
  if (!u) return out;
  const today = localDay(0);
  const keys = [];
  if (range === 'all' || range === 'month') {
    const first = range === 'all' ? Object.keys(u.days).sort()[0] || today : today.slice(0, 8) + '01';
    for (let i = 0; ; i++) {
      const k = localDay(i);
      if (k < first) break;
      keys.unshift(k);
    }
  } else for (let i = RANGES[range] - 1; i >= 0; i--) keys.push(localDay(i));
  const totals = [0, 0, 0, 0, 0];
  const agents = [0, 0, 0, 0, 0];
  const models = {};
  const projects = {};
  const sessions = {};
  for (const k of keys) {
    const D = u.days[k];
    if (!D) continue;
    for (const m in D.m) { addInto(totals, D.m[m]); addInto(models[m] || (models[m] = [0, 0, 0, 0, 0]), D.m[m]); }
    for (const p in D.p) addInto(projects[p] || (projects[p] = [0, 0, 0, 0, 0]), D.p[p]);
    for (const sid in D.s) addInto(sessions[sid] || (sessions[sid] = [0, 0, 0, 0, 0]), D.s[sid]);
    addInto(agents, D.ag);
  }
  let series;
  if (range === 'today') {
    series = [];
    for (let h = 0; h <= new Date().getHours(); h++) series.push({ k: today + 'T' + pad(h), m: u.hours[today + 'T' + pad(h)] || {} });
  } else series = keys.map((k) => ({ k, m: (u.days[k] && u.days[k].m) || {} }));
  const live = new Map((snapshot && snapshot.sessions || []).map((x) => [x.id, x.name]));
  const byOut = (a, b) => b[1][2] - a[1][2];
  out.totals = totals;
  out.agents = agents;
  out.series = series;
  out.models = Object.entries(models).sort(byOut);
  out.projects = Object.entries(projects).sort(byOut).slice(0, 8).map(([p, a]) => [p ? p.replace(HOME_RE, '~') : '', a]);
  out.sessions = Object.entries(sessions).sort(byOut).slice(0, 10).map(([sid, a]) => {
    const meta = u.sess[sid] || {};
    return { sid, a, name: live.get(sid) || '', title: meta.t || '', cwd: meta.c ? meta.c.replace(HOME_RE, '~') : '', last: meta.l || 0, live: live.has(sid) };
  });
  return out;
}

module.exports = { start, usageReply };
