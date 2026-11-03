'use strict';

const { POLL_MS, EV_HISTORY_MS } = require('./constants');
const log = require('./log');
const { collect, allSessions } = require('./sessions');
const { histPoll, trimSteps, drainSteps, stepRows } = require('./steps');

const BOOT = Date.now();
let snapshot = { now: Date.now(), boot: BOOT, totals: {}, sessions: [], attention: [], pollMs: POLL_MS, costMs: 0 };
let snapshotJson = JSON.stringify(snapshot);
const clients = new Set();

function send(payload) {
  for (const res of clients) res.write(payload);
}

function poll() {
  const t0 = Date.now();
  const now = t0;
  try {
    const s = collect(now);
    const next = { now, boot: BOOT, pollMs: POLL_MS, costMs: Date.now() - t0, totals: s.totals, attention: s.attention, networkDown: s.networkDown, sessions: s.sessions };
    const json = JSON.stringify({ ...next, now: 0, costMs: 0 });
    const changed = json !== snapshotJson;
    snapshot = next;
    snapshotJson = json;
    if (changed) send('data: ' + JSON.stringify(snapshot) + '\n\n');
    histPoll(allSessions(), now);
    trimSteps(now);
    const steps = drainSteps();
    if (steps) send('event: ev\ndata: ' + JSON.stringify(steps) + '\n\n');
  } catch (e) {
    log.once(e);
  }
  setTimeout(poll, POLL_MS);
}

function current() {
  return snapshot;
}

function subscribe(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  res.write('data: ' + JSON.stringify(snapshot) + '\n\n');
  res.write('event: hist\ndata: ' + JSON.stringify({ a: stepRows(Date.now() - EV_HISTORY_MS) }) + '\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function start() {
  poll();
  setInterval(() => send('event: tick\ndata: ' + Date.now() + '\n\n'), 10000);
}

module.exports = { start, current, subscribe };
