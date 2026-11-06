(function () {
  'use strict';

  const KEY = 'claude-overview-hidden';
  // a resumed session keeps its id
  const KEEP_MS = 7 * 86400e3;
  const SEEN_MS = 3600e3;

  let ids = new Map();
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
    for (const k of Object.keys(v)) if (typeof v[k] === 'number') ids.set(k, v[k]);
  }
  // another tab can have changed the list since this one read it, but a list this one could not save is the newer
  function reload() { if (!unsaved) load(); }
  function edit(fn) {
    reload();
    fn();
    const o = {};
    for (const [k, t] of ids) o[k] = t;
    try {
      localStorage.setItem(KEY, JSON.stringify(o));
      unsaved = false;
    } catch (e) { unsaved = true; }
  }
  function changed() { for (const fn of subs) fn(); }

  function has(id) { return ids.has(String(id)); }
  function within(id, snap) { return !!ids.size && rootOf(id, (snap && snap.startedBy) || {}) !== null; }
  function set(id, on) {
    id = String(id);
    edit(() => { if (on) ids.set(id, Date.now()); else ids.delete(id); });
    changed();
  }
  // a session stays hidden while anything above it is hidden
  function unhide(id, snap) {
    const startedBy = (snap && snap.startedBy) || {};
    const seen = new Set();
    edit(() => { for (let x = String(id); x && !seen.has(x); x = startedBy[x]) { ids.delete(x); seen.add(x); } });
    changed();
  }

  // the topmost, so the sessions on the board above a shown one are shown too
  function rootOf(id, startedBy) {
    let r = null;
    const seen = new Set();
    for (let x = String(id); x && !seen.has(x); x = startedBy[x]) {
      if (ids.has(x)) r = x;
      seen.add(x);
    }
    return r;
  }

  function refresh(byId, now) {
    let saved = false;
    for (const [id, at] of ids) {
      if (byId.has(id) ? now - at <= SEEN_MS : now - at <= KEEP_MS) continue;
      saved = true;
      if (byId.has(id)) ids.set(id, now); else ids.delete(id);
    }
    return saved;
  }

  function view(snap, peek, open) {
    const all = (snap && snap.sessions) || [];
    const startedBy = (snap && snap.startedBy) || {};
    const byId = new Map(all.map((s) => [String(s.id), s]));
    if (all.length) {
      const now = Date.now();
      // the save can first read a list another tab wrote, so the changes are made again on it
      if (refresh(byId, now)) edit(() => refresh(byId, now));
    }
    const root = new Map(all.map((s) => [String(s.id), rootOf(s.id, startedBy)]));
    const loud = new Set();
    for (const a of (snap && snap.attention) || []) if (!a.quiet && a.level === 'needs') loud.add(root.get(String(a.sid)));
    for (const s of all) if (s.alive && s.state === 'needs-you' && !s.headless) loud.add(root.get(String(s.id)));
    const kept = open != null && byId.has(String(open)) ? root.get(String(open)) : null;
    const back = (r) => loud.has(r) || r === kept;
    const away = new Map();
    const awayHidden = (sid) => {
      if (!away.has(sid)) away.set(sid, rootOf(sid, startedBy));
      const r = away.get(sid);
      return !!r && !peek && !back(r);
    };
    const gone = new Set();
    const marked = new Set();
    const counted = new Set();
    for (const s of all) {
      const id = String(s.id);
      const r = root.get(id);
      if (!r) continue;
      if (!loud.has(r)) counted.add(r);
      if (!back(r) && !peek) gone.add(id);
      else if (ids.has(id) || !(s.parentSid && byId.has(String(s.parentSid)))) marked.add(id);
    }
    const key = [...gone];
    // only a hidden id or a session started from another can be hidden off the board
    if (ids.size) for (const id of new Set([...ids.keys(), ...Object.keys(startedBy)])) if (!byId.has(id) && awayHidden(id)) key.push(id);
    return {
      count: counted.size,
      counted,
      gone,
      marked,
      key: key.sort().join(),
      concealed(sid) {
        if (!ids.size) return false;
        sid = String(sid);
        return byId.has(sid) ? gone.has(sid) : awayHidden(sid);
      },
      held(sid) {
        const r = root.get(String(sid));
        return !!r && r === kept && !loud.has(r) && !peek;
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
    reload();
    // another tab keeps the times fresh, which changes nothing on the board
    if ([...ids.keys()].sort().join() !== was) changed();
  });

  window.OVHidden = { has, within, set, unhide, view, totals, on(fn) { subs.push(fn); } };
})();
