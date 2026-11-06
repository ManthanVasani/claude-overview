(function () {
  'use strict';

  const KEY = 'claude-overview-hidden';
  // a resumed session keeps its id
  const KEEP_MS = 7 * 86400e3;
  const SEEN_MS = 3600e3;
  // longer than the timeline keeps a step
  const LINK_MS = 4 * 3600e3;

  let ids = new Map();
  // the server links a session to the one that started it only while both run, and its steps outlast both
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
      else if (Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number') links.set(k, [x[0], x[1]]);
    }
  }
  // another tab can have changed the list since this one read it, but a list this one could not save is the newer
  function reload() { if (!unsaved) load(); }
  function edit(fn) {
    reload();
    fn();
    const o = {};
    for (const [k, t] of ids) o[k] = t;
    for (const [k, l] of links) if (!ids.has(k)) o[k] = l;
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

  function parentOf(id, byId) {
    const s = byId.get(id);
    if (s && s.parentSid && byId.has(String(s.parentSid))) return String(s.parentSid);
    return links.has(id) ? links.get(id)[0] : null;
  }
  function hiddenAbove(id, byId) {
    const seen = new Set();
    for (let x = String(id); x && !seen.has(x); x = parentOf(x, byId)) {
      if (ids.has(x)) return x;
      seen.add(x);
    }
    return null;
  }

  function refresh(byId, now) {
    let saved = false;
    for (const [id, s] of byId) {
      const l = links.get(id);
      const p = s.parentSid && byId.has(String(s.parentSid)) ? String(s.parentSid) : l && l[0];
      if (!p || (l && l[0] === p && now - l[1] <= SEEN_MS)) continue;
      links.set(id, [p, now]);
      saved = true;
    }
    for (const [id, l] of links) {
      if (byId.has(id) || now - l[1] <= LINK_MS) continue;
      links.delete(id);
      saved = true;
    }
    for (const [id, at] of ids) {
      if (byId.has(id) ? now - at <= SEEN_MS : now - at <= KEEP_MS) continue;
      saved = true;
      if (byId.has(id)) ids.set(id, now); else ids.delete(id);
    }
    return saved;
  }

  // A hidden session stays while it would alert or a session in it waits for you, so no alert points at a missing card.
  // keep is the session whose details are open.
  function view(snap, peek, keep) {
    const all = (snap && snap.sessions) || [];
    const byId = new Map(all.map((s) => [String(s.id), s]));
    if (all.length) {
      const now = Date.now();
      // the save can first read a list another tab wrote, so the changes are made again on it
      if (refresh(byId, now)) edit(() => refresh(byId, now));
    }
    const root = new Map(all.map((s) => [String(s.id), hiddenAbove(s.id, byId)]));
    const loud = new Set();
    for (const a of (snap && snap.attention) || []) if (!a.quiet) loud.add(root.get(String(a.sid)));
    for (const s of all) if (s.alive && s.state === 'needs-you' && !s.headless) loud.add(root.get(String(s.id)));
    const kept = keep != null && byId.has(String(keep)) ? root.get(String(keep)) : null;
    const back = (r) => loud.has(r) || r === kept;
    const away = new Map();
    const gone = new Set();
    const marked = new Set();
    const groups = new Set();
    for (const s of all) {
      const id = String(s.id);
      const r = root.get(id);
      if (!r) continue;
      groups.add(r);
      if (!back(r) && !peek) gone.add(id);
      else if (!(s.parentSid && byId.has(String(s.parentSid)))) marked.add(id);
    }
    return {
      count: [...groups].filter((r) => !loud.has(r)).length,
      gone,
      marked,
      concealed(sid) {
        if (!ids.size) return false;
        sid = String(sid);
        if (byId.has(sid)) return gone.has(sid);
        if (!away.has(sid)) away.set(sid, hiddenAbove(sid, byId));
        const r = away.get(sid);
        return !!r && !peek && !back(r);
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
    // another tab also saves the times and the links, which this one takes from the same snapshots
    if ([...ids.keys()].sort().join() !== was) changed();
  });

  window.OVHidden = { has, set, view, totals, on(fn) { subs.push(fn); } };
})();
