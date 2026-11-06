(function () {
  'use strict';

  const KEY = 'claude-overview-hidden';
  // a resumed session keeps its id
  const KEEP_MS = 7 * 86400e3;
  const SEEN_MS = 3600e3;
  // longer than the timeline keeps a step
  const LINK_MS = 4 * 3600e3;

  let ids = new Map();
  // a started session leaves its steps in the timeline after it leaves the board
  const links = new Map();
  let unsaved = false;
  const subs = [];
  load();

  function load() {
    let raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return; }
    let v = null;
    try { v = JSON.parse(raw); } catch (e) { /* corrupt */ }
    ids = new Map();
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      const x = v[k];
      if (typeof x === 'number') ids.set(k, x);
      else if (Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number' && !(links.has(k) && links.get(k)[1] > x[1])) links.set(k, [x[0], x[1]]);
    }
  }
  // another tab can have changed the list since this one read it, but a list this one could not save is the newer
  function edit(fn) {
    if (!unsaved) load();
    fn();
    const o = {};
    for (const [k, t] of ids) o[k] = t;
    for (const [k, l] of links) if (ids.has(l[0]) && !ids.has(k)) o[k] = l;
    try {
      localStorage.setItem(KEY, JSON.stringify(o));
      unsaved = false;
    } catch (e) { unsaved = true; }
  }
  function changed() { for (const fn of subs) fn(); }

  function has(id) { return ids.has(String(id)); }
  function set(id, on) {
    id = String(id);
    edit(() => { if (on) ids.set(id, Date.now()); else ids.delete(id); });
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

  function refresh(byId, tops, now) {
    let saved = false;
    for (const [id, top] of tops) {
      if (id === top) continue;
      const l = links.get(id);
      if (l && l[0] === top && now - l[1] <= SEEN_MS) continue;
      if (ids.has(top) || (l && ids.has(l[0]))) saved = true;
      links.set(id, [top, now]);
    }
    for (const [id, l] of links) {
      if (byId.has(id) || now - l[1] <= LINK_MS) continue;
      if (ids.has(l[0])) saved = true;
      links.delete(id);
    }
    for (const [id, at] of ids) {
      if (byId.has(id) ? now - at <= SEEN_MS : now - at <= KEEP_MS) continue;
      saved = true;
      if (byId.has(id)) ids.set(id, now); else ids.delete(id);
    }
    return saved;
  }

  // A hidden session stays while it would alert or a session in it waits for you, so no alert points at a missing card.
  function view(snap, peek, keep) {
    const all = (snap && snap.sessions) || [];
    const byId = new Map(all.map((s) => [String(s.id), s]));
    const tops = new Map(all.map((s) => [String(s.id), topOf(s, byId)]));
    if (all.length) {
      const now = Date.now();
      // the save reads the list again first, so the changes are made again on what it read
      if (refresh(byId, tops, now)) edit(() => refresh(byId, tops, now));
    }
    const loud = new Set();
    if (keep != null && tops.has(String(keep))) loud.add(tops.get(String(keep)));
    for (const a of (snap && snap.attention) || []) if (!a.quiet) loud.add(tops.get(String(a.sid)));
    for (const s of all) if (s.alive && s.state === 'needs-you' && !s.headless) loud.add(tops.get(String(s.id)));
    const gone = new Set();
    const marked = new Set();
    let count = 0;
    for (const [id, top] of tops) {
      if (!ids.has(top)) continue;
      const back = loud.has(top);
      if (id === top) {
        if (!back) count++;
        if (back || peek) marked.add(id);
      }
      if (!back && !peek) gone.add(id);
    }
    return {
      count,
      gone,
      marked,
      concealed(sid) {
        sid = String(sid);
        if (!ids.size) return false;
        const top = tops.get(sid) || (links.has(sid) ? links.get(sid)[0] : sid);
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
    load();
    // another tab keeps the times fresh, which changes nothing on the board
    if ([...ids.keys()].sort().join() !== was) changed();
  });

  window.OVHidden = { has, set, view, totals, on(fn) { subs.push(fn); } };
})();
