(function () {
  'use strict';

  const KEY = 'claude-overview-hidden';
  // a resumed session keeps its id
  const KEEP_MS = 7 * 86400e3;
  const SEEN_MS = 3600e3;

  let ids = load() || new Map();
  // remembered for sessions that have left the board while their steps stay in the timeline
  const tops = new Map();
  const subs = [];

  function load() {
    let raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return null; }
    let v = null;
    try { v = JSON.parse(raw); } catch (e) { /* corrupt */ }
    const m = new Map();
    if (v && typeof v === 'object') for (const k of Object.keys(v)) if (typeof v[k] === 'number') m.set(k, v[k]);
    return m;
  }
  // another tab can have changed the list since this one read it
  function edit(fn) {
    ids = load() || ids;
    fn(ids);
    const o = {};
    for (const [k, t] of ids) o[k] = t;
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* storage unavailable */ }
  }
  function changed() { for (const fn of subs) fn(); }

  function has(id) { return ids.has(String(id)); }
  function set(id, on) {
    id = String(id);
    edit((m) => { if (on) m.set(id, Date.now()); else m.delete(id); });
    changed();
  }

  function topOf(s, byId) {
    const seen = new Set([String(s.id)]);
    let t = s;
    while (t.parentSid && byId.has(String(t.parentSid)) && !seen.has(String(t.parentSid))) {
      t = byId.get(String(t.parentSid));
      seen.add(String(t.id));
    }
    return String(t.id);
  }

  // A hidden session stays on the board while it would send a desktop alert, so no alert points at a missing card.
  function view(snap, peek) {
    const all = (snap && snap.sessions) || [];
    const byId = new Map(all.map((s) => [String(s.id), s]));
    for (const s of all) tops.set(String(s.id), topOf(s, byId));
    const loud = new Set();
    for (const a of (snap && snap.attention) || []) if (!a.quiet) loud.add(tops.get(String(a.sid)));
    for (const s of all) if (s.alive && s.state === 'needs-you' && !s.headless) loud.add(tops.get(String(s.id)));
    const gone = new Set();
    const marked = new Map();
    let count = 0;
    for (const s of all) {
      const id = String(s.id);
      const top = tops.get(id);
      if (!ids.has(top)) continue;
      const back = loud.has(top);
      if (id === top) {
        if (!back) count++;
        if (back || peek) marked.set(id, back);
      }
      if (!back && !peek) gone.add(id);
    }
    if (all.length) {
      const now = Date.now();
      const stale = [...ids].filter(([id, at]) => (byId.has(id) ? now - at > SEEN_MS : now - at > KEEP_MS));
      if (stale.length) edit((m) => { for (const [id] of stale) if (m.has(id)) { if (byId.has(id)) m.set(id, now); else m.delete(id); } });
    }
    return {
      count,
      gone,
      marked,
      concealed(sid) {
        const top = tops.get(String(sid)) || String(sid);
        return byId.has(top) ? gone.has(top) : !peek && ids.has(top);
      },
    };
  }

  function totals(list, attention) {
    const t = { sessions: 0, working: 0, yourTurn: 0, needsYou: 0, problems: 0, agentsRunning: 0, shellsRunning: 0, workflowsRunning: 0, ended: 0 };
    for (const v of list) {
      if (v.alive) t.sessions++;
      else t.ended++;
      if (v.state === 'working' || v.state === 'retrying') t.working++;
      else if (v.state === 'your-turn' || v.state === 'error') t.yourTurn++;
      else if (v.state === 'needs-you') t.needsYou++;
      for (const a of v.agents) if (a.state === 'running') t.agentsRunning++;
      for (const w of v.workflows) {
        if (w.state === 'running') t.workflowsRunning++;
        t.agentsRunning += w.running;
      }
      for (const x of v.shells) if (x.state === 'running') t.shellsRunning++;
    }
    t.problems = attention.filter((x) => x.level !== 'needs').length;
    return t;
  }

  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    const was = [...ids.keys()].sort().join();
    ids = load() || ids;
    // another tab keeps the times fresh, which changes nothing on the board
    if ([...ids.keys()].sort().join() !== was) changed();
  });

  window.OVHidden = { has, set, view, totals, on(fn) { subs.push(fn); } };
})();
