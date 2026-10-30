(function () {
  'use strict';

  const OV = window.OV;
  if (!OV) return;

  const SVGNS = 'http://www.w3.org/2000/svg';
  const HIST_MS = 3 * 3600e3;
  const MIN_SPAN = 2 * 60e3;
  const RANGES = { '15m': 15 * 60e3, '1h': 3600e3, '3h': HIST_MS };
  // picked as a set to stay apart for colour-blind readers on the dark dock: change them together
  const KINDS = [
    { id: 'run', label: 'Commands', c: '#3987e5' },
    { id: 'edit', label: 'Edits', c: '#d95926' },
    { id: 'read', label: 'Reads', c: '#199e70' },
    { id: 'web', label: 'Web', c: '#c98500' },
    { id: 'agent', label: 'Agents', c: '#d55181' },
    { id: 'other', label: 'Other', c: '#7c8aa0' },
  ];
  const GROUP = { run: 'run', edit: 'edit', read: 'read', search: 'read', web: 'web', svc: 'web', agent: 'agent', ask: 'other', other: 'other' };
  const KC = {};
  for (const k of KINDS) KC[k.id] = k.c;
  const BAD = '#f43f5e';
  const CUT = '#fb923c';
  const STATE_C = { working: '#34d399', running: '#34d399', 'your-turn': '#fbbf24', 'needs-you': '#f472b6', error: '#f43f5e', died: '#f43f5e', retrying: '#fb923c', ended: '#64748b' };
  const TABS = { files: 'Files', hosts: 'Servers', web: 'Web', tools: 'Tools' };
  const KEYS = { dock: 'claude-overview-dock-dragged', fold: 'claude-overview-dock-folded', span: 'claude-overview-tl-span', hide: 'claude-overview-tl-hide', open: 'claude-overview-tl-open', tab: 'claude-overview-touch-tab', rail: 'claude-overview-rail-hidden', dockAuto: 'claude-overview-dock-auto' };
  const HEAD_H = 38;
  const AXIS = 22;
  const ROW = 26;
  const SUB = 18;
  const MAX_FEED = 80;
  const MAX_TOUCH = 60;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const rail = $('rail');
  const railAlerts = $('r-alerts');
  const alertsEl = $('alerts');
  const alertsHome = alertsEl.nextSibling;
  const dock = $('dock');
  const grip = $('dock-grip');
  const foldBtn = $('dock-fold');
  const railBtn = $('rail-btn');
  const tl = $('tl');
  const cv = $('tl-canvas');
  const ctx = cv.getContext('2d');
  const tip = $('tl-tip');
  const tlEmpty = $('tl-empty');
  const rangeEl = $('tl-range');
  const liveBtn = $('tl-live');
  const kindsEl = $('tl-kinds');
  const rateEl = $('tl-rate');
  const touchList = $('touch-list');
  const touchSub = $('touch-sub');
  const touchTabs = $('touch-tabs');
  const feedEl = $('feed');
  const feedSub = $('feed-sub');
  const feedNew = $('feed-new');
  const wires = $('wires');
  const wHover = wires.querySelector('.w-hover');
  const wPk = wires.querySelector('.w-pk');

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
    return null;
  }
  function parseList(s) {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function flat(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function dur(ms) {
    ms = Math.max(0, ms || 0);
    if (ms < 1000) return (ms / 1000).toFixed(1) + 's';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }
  function clock(t, sec) {
    return new Date(t).toLocaleTimeString([], sec ? { hour: 'numeric', minute: '2-digit', second: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
  }
  const now = () => OV.now();

  // ---------- steps ----------

  const steps = [];
  const bySeq = new Map();
  let snap = null;
  let sessions = [];
  let sessById = new Map();

  function nodeOf(sid, o) {
    if (o == null) return 's:' + sid;
    return o.indexOf('wf:') === 0 ? 'wa:' + sid + ':' + o.slice(3) : 'a:' + sid + ':' + o;
  }
  function toStep(a, fresh) {
    return {
      s: a[0], sid: a[1], o: a[2], t: a[3], n: a[4], k: a[5], g: GROUP[a[5]] || 'other', r: a[6] || null, l: a[7] || a[4],
      e: a[8] || 0, ok: a[9], err: a[10] || null, node: nodeOf(a[1], a[2]), born: fresh ? performance.now() : 0, failAt: 0,
    };
  }
  function addStep(st) {
    bySeq.set(st.s, st);
    let i = steps.length;
    while (i > 0 && steps[i - 1].t > st.t) i--;
    if (i === steps.length) steps.push(st); else steps.splice(i, 0, st);
  }
  function trim() {
    const min = now() - HIST_MS - 60e3;
    let i = 0;
    while (i < steps.length && steps[i].t < min) bySeq.delete(steps[i++].s);
    if (i) steps.splice(0, i);
  }
  function ingest(type, d) {
    if (!d) return;
    if (type === 'hist') {
      steps.length = 0;
      bySeq.clear();
      for (const a of d.a || []) { const st = toStep(a, false); bySeq.set(st.s, st); steps.push(st); }
      steps.sort((x, y) => x.t - y.t || x.s - y.s);
      rebuildFeed();
      histIn = true;
      dirty(true);
      // a panel restored by the reload can open before this history arrives
      OV.repaint();
      return;
    }
    const fresh = [];
    const rows = (d.a || []).filter((a) => !bySeq.has(a[0]));
    // the server also streams history it reads later; only calls from the last moments are news
    const recent = now() - 20e3;
    if (rows.length > 40) {
      for (const a of rows) { const st = toStep(a, a[3] >= recent); bySeq.set(st.s, st); steps.push(st); if (st.born) fresh.push(st); }
      steps.sort((x, y) => x.t - y.t || x.s - y.s);
    } else {
      for (const a of rows) {
        const st = toStep(a, a[3] >= recent);
        addStep(st);
        if (st.born) fresh.push(st);
      }
    }
    for (const x of d.d || []) {
      const st = bySeq.get(x[0]);
      if (!st) continue;
      st.e = x[1];
      st.ok = x[2];
      st.err = x[3] || null;
      if (st.ok === 0) st.failAt = performance.now();
      const li = feedRows.get(st.s);
      if (li) li.querySelector('.fs').outerHTML = statusHtml(st);
    }
    trim();
    if (fresh.length) {
      feedIn(fresh);
      packets(fresh);
    }
    dirty(true);
  }

  function firstIndex(t) {
    let lo = 0;
    let hi = steps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (steps[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function endOf(st, tn) { return st.e || (st.ok === -1 ? tn : st.t); }

  // ---------- names ----------

  function sessName(sid) {
    const s = sessById.get(sid);
    return s ? s.name : 'Session ' + sid.slice(0, 8);
  }
  function ownerName(st) {
    if (st.o == null) return sessName(st.sid);
    return OV.name(st.node) || (st.o.indexOf('wf:') === 0 ? 'Workflow agent' : 'Agent');
  }
  function whoHtml(st) {
    const s = '<span class="who-s">' + esc(sessName(st.sid)) + '</span>';
    return st.o == null ? s : s + '<span class="who-sep">›</span><span class="who-a">' + esc(ownerName(st)) + '</span>';
  }
  function keyType(key) {
    const p = key.slice(0, key.indexOf(':'));
    return p === 'file' ? 'files' : p === 'host' ? 'hosts' : p === 'web' || p === 'svc' ? 'web' : 'tools';
  }
  const SVC = { github: 'GitHub', Slack: 'Slack', monday_com: 'monday.com', 'chrome-devtools': 'Chrome DevTools', Claude_Docs: 'Claude Docs', 'claude-vscode': 'VS Code' };
  function resName(key) {
    const i = key.indexOf(':');
    const p = key.slice(0, i);
    const v = key.slice(i + 1);
    switch (p) {
      case 'file': {
        const own = /^scratchpad@([0-9a-f]{8})/.exec(v);
        if (own) {
          const s = sessions.find((x) => x.s.id.indexOf(own[1]) === 0);
          const r = resName('file:' + v.replace(own[0], 'scratchpad'));
          r.sub = (s ? s.s.name + ' · ' : '') + r.sub;
          r.full = v.replace(own[0], 'scratchpad') + (s ? '  (' + s.s.name + ')' : '');
          return r;
        }
        const j = v.lastIndexOf('/');
        const base = j >= 0 ? v.slice(j + 1) : v;
        const dir = j > 0 ? v.slice(0, j) : '';
        const parts = dir.split('/');
        const short = parts.length > 4 ? parts[0] + '/…/' + parts.slice(-3).join('/') : dir;
        return { name: base || v, sub: short, icon: /\.[\w]+$/.test(base) ? 'file' : 'dir', type: /\.[\w]+$/.test(base) ? 'File' : 'Folder', full: v };
      }
      case 'host': return { name: v, sub: /^127\.|^localhost/.test(v) ? 'this machine' : 'server', icon: 'host', type: 'Server', full: v };
      case 'web': return v === 'search' ? { name: 'Web search', sub: 'search engine', icon: 'web', type: 'Web', full: 'Web search' } : { name: v, sub: 'website', icon: 'web', type: 'Website', full: v };
      case 'svc': return { name: SVC[v] || v.replace(/_/g, ' '), sub: 'connected service', icon: 'svc', type: 'Service', full: SVC[v] || v };
      case 'tool': return { name: { rspec: 'RSpec', browser: 'Browser', git: 'git' }[v] || v, sub: { rspec: 'test runs', browser: 'headless browser', git: 'version control' }[v] || 'tool', icon: 'tool', type: 'Tool', full: v };
      case 'skill': return { name: '/' + v, sub: 'skill', icon: 'tool', type: 'Skill', full: v };
      default: return { name: v, sub: 'command', icon: 'cmd', type: 'Command', full: v };
    }
  }
  const GLYPH = {
    file: '<svg viewBox="0 0 16 16"><path d="M4 1.8h5.2L12.6 5v9.2H4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 2v3.2h3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    dir: '<svg viewBox="0 0 16 16"><path d="M1.8 4.2h4.4l1.4 1.6h6.6v7.4H1.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    host: '<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="9" width="12" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.8" cy="4.75" r=".9" fill="currentColor"/><circle cx="4.8" cy="11.25" r=".9" fill="currentColor"/></svg>',
    web: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
    svc: '<svg viewBox="0 0 16 16"><path d="M6 2v3M10 2v3M4.2 5h7.6v2.6a3.8 3.8 0 0 1-7.6 0zM8 11.4V14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tool: '<svg viewBox="0 0 16 16"><path d="M10.6 2.2a3.2 3.2 0 0 0-3.9 4.3L2.4 10.8a1.3 1.3 0 0 0 1.8 1.8l4.3-4.3a3.2 3.2 0 0 0 4.3-3.9l-2 2-1.8-.3-.3-1.8z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    cmd: '<svg viewBox="0 0 16 16"><path d="M3 4.6l3.4 3.4L3 11.4M8.6 11.4h4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // ---------- view state ----------

  let span = RANGES[store(KEYS.span)] || RANGES['1h'];
  let live = true;
  let tEnd = 0;
  const hide = new Set(parseList(store(KEYS.hide)).filter((k) => KC[k]));
  const open = new Set(parseList(store(KEYS.open)));
  let tab = TABS[store(KEYS.tab)] ? store(KEYS.tab) : 'all';
  let folded = store(KEYS.fold) === '1';
  let dockH = Number(store(KEYS.dock)) || 0;
  let userDock = dockH > 0;
  if (!userDock) dockH = Number(store(KEYS.dockAuto)) || 0;
  let sized = false;
  // the history comes after the snapshot in a message of its own, with rows the snapshot alone does not give
  let histIn = false;
  let savedAuto = '';
  let railHidden = store(KEYS.rail) === '1';
  let railOn = false;
  let hoverKey = null;
  let hoverNode = null;
  let hoverStep = null;
  let hoverRow = null;
  let mouse = null;
  let rows = [];
  let rowScroll = 0;
  let agg = new Map();
  let shown = [];

  function win() {
    const t1 = live ? now() : tEnd;
    return { t0: t1 - span, t1 };
  }
  function wanted(st) { return !hide.has(st.g); }
  function windowSteps(w) {
    const out = [];
    const tn = now();
    // a long step that started before the window can cross into it
    for (let i = firstIndex(w.t0 - 30 * 60e3); i < steps.length; i++) {
      const st = steps[i];
      if (st.t > w.t1) break;
      if (endOf(st, tn) < w.t0 || !wanted(st)) continue;
      out.push(st);
    }
    return out;
  }

  // The timeline's filter for the current hover or selection.
  function focusTest() {
    if (hoverKey) return (st) => st.r === hoverKey;
    const sel = OV.selected();
    if (!sel) return null;
    if (sel.indexOf('r:') === 0) { const k = sel.slice(2); return (st) => st.r === k; }
    if (sel.indexOf('s:') === 0) { const sid = sel.slice(2); return (st) => st.sid === sid; }
    if (sel.indexOf('w:') === 0) { const p = 'wa:' + sel.slice(2) + ':'; return (st) => st.node.indexOf(p) === 0; }
    if (sel.indexOf('a:') === 0 || sel.indexOf('wa:') === 0) return (st) => st.node === sel;
    return null;
  }

  // ---------- layout: rail + dock ----------

  function defaultDock() {
    return Math.round(Math.min(320, Math.max(150, innerHeight * 0.27)));
  }
  function autoDock() {
    return Math.max(HEAD_H + 60, Math.min(defaultDock(), HEAD_H + AXIS + rowsHeight() + 8));
  }
  function layout() {
    const roomy = innerWidth >= 1180;
    const wide = roomy && !railHidden;
    const railW = wide ? Math.min(560, Math.max(innerWidth >= 2000 ? 400 : 340, Math.round(innerWidth * 0.11))) : 0;
    if (wide !== railOn) {
      railOn = wide;
      document.body.classList.toggle('has-rail', wide);
      if (wide) railAlerts.appendChild(alertsEl);
      else document.body.insertBefore(alertsEl, alertsHome);
    }
    railBtn.hidden = !roomy;
    railBtn.setAttribute('aria-pressed', wide ? 'true' : 'false');
    railBtn.title = (wide ? 'Hide' : 'Show') + ' the side column (S)';
    if (!userDock && !gripDrag) {
      if (rows.length) {
        dockH = autoDock();
        if (String(dockH) !== savedAuto) {
          savedAuto = String(dockH);
          store(KEYS.dockAuto, savedAuto);
        }
      } else dockH = Math.min(dockH, defaultDock());
    }
    if (!dockH) dockH = defaultDock();
    dockH = Math.max(HEAD_H + 60, Math.min(dockH, Math.round(innerHeight * 0.6)));
    const h = folded ? HEAD_H : dockH;
    root.style.setProperty('--rail', railW + 'px');
    root.style.setProperty('--dock', h + 'px');
    dock.classList.toggle('folded', folded);
    foldBtn.setAttribute('aria-expanded', folded ? 'false' : 'true');
    foldBtn.title = folded ? 'Show the timeline (T)' : 'Fold the timeline (T)';
    sizeCanvas();
  }
  function sizeCanvas() {
    const r = tl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(0, Math.round(r.width));
    const h = Math.max(0, Math.round(r.height));
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px';
      cv.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cv.cssW = w;
    cv.cssH = h;
  }
  function relayout() {
    layout();
    OV.relayout();
    dirty(true);
  }
  function setFold(on) {
    folded = on;
    store(KEYS.fold, on ? '1' : '0');
    relayout();
  }
  function setRail(on) {
    railHidden = !on;
    store(KEYS.rail, railHidden ? '1' : '0');
    relayout();
  }
  railBtn.addEventListener('click', () => setRail(!railOn));
  foldBtn.addEventListener('click', () => setFold(!folded));
  grip.addEventListener('dblclick', () => setFold(!folded));
  let gripDrag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    gripDrag = { y: e.clientY, h: folded ? HEAD_H : dockH, id: e.pointerId, dock: dockH };
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!gripDrag || e.pointerId !== gripDrag.id) return;
    const h = Math.round(gripDrag.h - (e.clientY - gripDrag.y));
    if (h < HEAD_H + 40) { if (!folded) { folded = true; layout(); } return; }
    folded = false;
    dockH = h;
    // a click jitters a pixel or two, which is not the user picking a height
    if (Math.abs(e.clientY - gripDrag.y) > 3) gripDrag.moved = true;
    layout();
    dirty(false);
  });
  function endGrip() {
    if (!gripDrag) return;
    // a drag that ends folded is a fold, not a height the user picked
    if (folded) dockH = gripDrag.dock;
    else if (gripDrag.moved) {
      userDock = true;
      store(KEYS.dock, String(dockH));
    }
    gripDrag = null;
    document.body.classList.remove('resizing');
    store(KEYS.fold, folded ? '1' : '0');
    relayout();
  }
  grip.addEventListener('pointerup', endGrip);
  grip.addEventListener('pointercancel', endGrip);

  // ---------- timeline controls ----------

  function renderControls() {
    for (const b of rangeEl.querySelectorAll('button')) b.setAttribute('aria-pressed', RANGES[b.dataset.span] === span ? 'true' : 'false');
    liveBtn.setAttribute('aria-pressed', live ? 'true' : 'false');
    liveBtn.title = live ? 'Following now' : 'Back to now (L)';
  }
  rangeEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-span]');
    if (!b) return;
    span = RANGES[b.dataset.span];
    store(KEYS.span, b.dataset.span);
    live = true;
    renderControls();
    refresh();
  });
  liveBtn.addEventListener('click', () => { live = true; renderControls(); refresh(); });
  kindsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    const k = b.dataset.kind;
    if (e.altKey || e.shiftKey) {
      // only this kind, or all again when it was already the only one
      const solo = KINDS.every((x) => (x.id === k) !== hide.has(x.id));
      hide.clear();
      if (!solo) for (const x of KINDS) if (x.id !== k) hide.add(x.id);
    } else if (hide.has(k)) hide.delete(k);
    else hide.add(k);
    if (hide.size === KINDS.length) hide.clear();
    store(KEYS.hide, JSON.stringify([...hide]));
    rebuildFeed();
    refresh();
  });
  function renderKinds(list) {
    const n = {};
    const w = win();
    for (let i = firstIndex(w.t0); i < steps.length && steps[i].t <= w.t1; i++) n[steps[i].g] = (n[steps[i].g] || 0) + 1;
    let h = '';
    for (const k of KINDS) {
      h += '<button type="button" data-kind="' + k.id + '" aria-pressed="' + (!hide.has(k.id)) + '" title="Show or hide ' + esc(k.label.toLowerCase()) + ' (Shift-click: only these)" style="--kc:' + k.c + '"><i></i><span>' + esc(k.label) + '</span><b>' + (n[k.id] || 0) + '</b></button>';
    }
    if (kindsEl.html !== h) { kindsEl.innerHTML = h; kindsEl.html = h; }
    const tn = now();
    let lastMin = 0;
    let fails = 0;
    for (let i = firstIndex(tn - 60e3); i < steps.length; i++) lastMin++;
    for (const st of list) if (st.ok === 0) fails++;
    rateEl.innerHTML = '<span class="tl-total"><b>' + list.length + '</b>calls in view</span>' + (fails ? '<span class="bad"><b>' + fails + '</b>failed</span>' : '') + '<span><b>' + lastMin + '</b>/min</span>';
  }

  // ---------- timeline rows ----------

  function flattenSessions() {
    const all = (snap && snap.sessions) || [];
    const byId = new Map(all.map((s) => [s.id, s]));
    const kids = new Map();
    const top = [];
    for (const s of all) {
      if (s.parentSid && byId.has(s.parentSid)) {
        if (!kids.has(s.parentSid)) kids.set(s.parentSid, []);
        kids.get(s.parentSid).push(s);
      } else top.push(s);
    }
    const order = (a, b) => (b.alive - a.alive) || (a.startedAt || 0) - (b.startedAt || 0) || (a.id < b.id ? -1 : 1);
    top.sort(order);
    const out = [];
    (function walk(list, depth) {
      for (const s of list) {
        out.push({ s, depth });
        if (kids.has(s.id) && depth < 4) walk(kids.get(s.id).sort(order), depth + 1);
      }
    })(top, 0);
    return out;
  }
  function buildRows(list, w) {
    const bySid = new Map();
    for (const st of list) {
      if (!bySid.has(st.sid)) bySid.set(st.sid, []);
      bySid.get(st.sid).push(st);
    }
    const out = [];
    const seen = new Set();
    const tn = now();
    const one = (s, sid, depth) => {
      seen.add(sid);
      const mine = bySid.get(sid) || [];
      const shells = s ? (s.shells || []).filter((t) => t.startedAt && t.startedAt <= w.t1 && (t.state === 'running' ? tn : t.doneAt || t.startedAt) >= w.t0) : [];
      if (!mine.length && !shells.length && !(s && s.alive)) return;
      const owners = new Map();
      for (const st of mine) {
        if (!owners.has(st.node)) owners.set(st.node, []);
        owners.get(st.node).push(st);
      }
      const canOpen = owners.size > 1 || (owners.size === 1 && !owners.has('s:' + sid));
      out.push({ type: 'session', id: 's:' + sid, sid, s, steps: mine, shells, depth, h: ROW, canOpen, isOpen: canOpen && open.has(sid), fails: mine.filter((x) => x.ok === 0).length });
      if (canOpen && open.has(sid)) {
        const ids = [...owners.keys()].sort((a, b) => (a === 's:' + sid ? -1 : b === 's:' + sid ? 1 : owners.get(a)[0].t - owners.get(b)[0].t));
        for (const id of ids) {
          const arr = owners.get(id);
          out.push({ type: 'owner', id, sid, steps: arr, depth: depth + 1, h: SUB, main: id === 's:' + sid, name: id === 's:' + sid ? 'Main thread' : ownerName(arr[0]), fails: arr.filter((x) => x.ok === 0).length });
        }
      }
    };
    for (const x of sessions) one(x.s, x.s.id, x.depth);
    for (const sid of bySid.keys()) if (!seen.has(sid)) one(null, sid, 0);
    return out;
  }

  // ---------- drawing ----------

  function niceStep(span, px) {
    const S = [10e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3];
    for (const s of S) if ((s / span) * px >= 74) return s;
    return 3600e3;
  }
  function gutter() { return cv.cssW < 760 ? 132 : cv.cssW < 1100 ? 210 : 240; }
  function rowsHeight() { return rows.reduce((m, r) => m + r.h, 0); }
  function maxScroll() { return Math.max(0, rowsHeight() - (cv.cssH - AXIS)); }
  function ellipsize(text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }

  let hits = [];
  function draw() {
    const W = cv.cssW;
    const H = cv.cssH;
    if (!W || !H) return 0;
    ctx.clearRect(0, 0, W, H);
    const w = win();
    const tn = now();
    const G = gutter();
    const px0 = G + 8;
    const px1 = W - 14;
    const X = (t) => px0 + ((t - w.t0) / span) * (px1 - px0);
    const T = (x) => w.t0 + ((x - px0) / (px1 - px0)) * span;
    const pnow = performance.now();
    const focus = focusTest();
    let anim = 0;
    hits = [];
    rowScroll = Math.min(rowScroll, maxScroll());

    const stepT = niceStep(span, px1 - px0);
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(8, 14, 26, .92)';
    ctx.fillRect(0, 0, W, AXIS);
    for (let t = Math.ceil(w.t0 / stepT) * stepT; t <= w.t1; t += stepT) {
      const x = Math.round(X(t)) + 0.5;
      ctx.strokeStyle = 'rgba(148, 163, 184, .07)';
      ctx.beginPath();
      ctx.moveTo(x, AXIS);
      ctx.lineTo(x, H);
      ctx.stroke();
      const label = clock(t, stepT < 60e3);
      ctx.fillStyle = '#8e9bb1';
      const lw = ctx.measureText(label).width;
      if (x - lw / 2 > px0 - 4 && x + lw / 2 < px1 - 30) ctx.fillText(label, x - lw / 2, AXIS / 2);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, AXIS, W, H - AXIS);
    ctx.clip();
    let y = AXIS - rowScroll;
    for (const row of rows) {
      const top = y;
      y += row.h;
      row.y = top;
      if (top > H || top + row.h < AXIS) continue;
      const hov = hoverRow === row;
      if (row.type === 'session' && top > AXIS) {
        ctx.fillStyle = 'rgba(148, 163, 184, .08)';
        ctx.fillRect(0, top, W, 1);
      }
      if (hov) {
        ctx.fillStyle = 'rgba(255, 255, 255, .035)';
        ctx.fillRect(0, top, W, row.h);
      }
      const indent = 12 + row.depth * 12;
      ctx.textBaseline = 'middle';
      const cy = top + row.h / 2;
      if (row.type === 'session') {
        const st = row.s ? row.s.state : 'ended';
        ctx.fillStyle = STATE_C[st] || '#64748b';
        ctx.beginPath();
        ctx.arc(indent + 3, cy, 3.5, 0, Math.PI * 2);
        ctx.fill();
        if (row.canOpen) {
          ctx.fillStyle = '#8e9bb1';
          ctx.beginPath();
          if (row.isOpen) { ctx.moveTo(G - 14, cy - 2); ctx.lineTo(G - 6, cy - 2); ctx.lineTo(G - 10, cy + 3); }
          else { ctx.moveTo(G - 12, cy - 4); ctx.lineTo(G - 7, cy); ctx.lineTo(G - 12, cy + 4); }
          ctx.fill();
        }
        ctx.font = '600 12px ' + getComputedStyle(document.body).fontFamily;
        const count = G < 200 ? '' : String(row.steps.length);
        ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
        const cw = ctx.measureText(count).width;
        ctx.fillStyle = '#8e9bb1';
        if (count) ctx.fillText(count, G - 20 - cw, cy);
        let failW = 0;
        if (row.fails) {
          // a narrow gutter keeps room for the name
          const f = G < 200 ? '✕' + row.fails : row.fails + ' failed';
          failW = ctx.measureText(f).width + 8;
          ctx.fillStyle = '#fca5a5';
          ctx.fillText(f, G - 20 - cw - failW, cy);
        }
        ctx.font = '600 12px ' + getComputedStyle(document.body).fontFamily;
        ctx.fillStyle = hov ? '#e7edf6' : '#c9d3e1';
        ctx.fillText(ellipsize(row.s ? row.s.name : 'Ended session', G - indent - 34 - cw - failW), indent + 12, cy);
      } else {
        ctx.font = '11.5px ' + getComputedStyle(document.body).fontFamily;
        ctx.fillStyle = hov ? '#e7edf6' : '#8d9ab0';
        const count = String(row.steps.length);
        const cw = ctx.measureText(count).width;
        ctx.fillText(ellipsize(row.name, G - indent - 42 - cw), indent + 12, cy);
        ctx.fillStyle = '#5b6880';
        ctx.fillText(count, G - 20 - cw, cy);
      }

      if (row.shells) {
        for (const sh of row.shells) {
          const a = Math.max(px0, X(sh.startedAt));
          const run = sh.state === 'running';
          const b = Math.min(px1, X(run ? tn : sh.doneAt || sh.startedAt));
          const ly = top + row.h - 3;
          ctx.fillStyle = run ? 'rgba(170, 182, 200, .55)' : 'rgba(111, 125, 147, .3)';
          ctx.fillRect(a, ly, Math.max(2, b - a), 2);
          if (sh.state === 'failed' || sh.state === 'died') {
            ctx.fillStyle = BAD;
            ctx.beginPath();
            ctx.arc(b, ly + 1, 2.4, 0, Math.PI * 2);
            ctx.fill();
          }
          if (run) anim = Math.max(anim, 1);
          hits.push({ row, a: a - 2, b: b + 2, y0: ly - 3, y1: ly + 5, shell: sh });
        }
      }

      const bandT = top + (row.type === 'session' ? 5 : 4);
      const bandH = row.h - (row.type === 'session' ? 12 : 8);
      const tailH = Math.max(3, Math.round(bandH * 0.36));
      const tailT = bandT + bandH - tailH;
      const marks = [];
      for (const st of row.steps) {
        const sa = X(st.t);
        const sb = X(endOf(st, tn));
        if (sb < px0 || sa > px1) continue;
        marks.push({ st, sa, a: Math.max(px0, sa), b: Math.min(px1, sb), dim: !!(focus && !focus(st)) });
      }
      for (const m of marks) {
        if (m.b - m.a < 3) continue;
        const st = m.st;
        let alpha = m.dim ? 0.08 : st.ok === -1 ? 0.4 + 0.25 * Math.sin(pnow / 260) : 0.34;
        if (st.ok === -1) anim = Math.max(anim, 1);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = st.ok === 0 ? BAD : KC[st.g];
        ctx.fillRect(m.a, tailT, m.b - m.a, tailH);
        if (st.ok === 2 && !m.dim) {
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = CUT;
          ctx.fillRect(m.b - 1.5, tailT - 2, 1.5, tailH + 2);
        }
      }
      for (const m of marks) {
        const st = m.st;
        const c = st.ok === 0 ? BAD : KC[st.g];
        if (m.sa >= px0 - 1) {
          let alpha = m.dim ? 0.14 : 1;
          if (st.ok === 2) alpha *= 0.55;
          const age = st.born ? (pnow - st.born) / 1600 : 2;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = c;
          if (age < 1 && !m.dim) {
            anim = 2;
            ctx.globalAlpha = 0.35 * (1 - age);
            ctx.fillRect(m.a - 4, bandT - 2, 10, bandH + 4);
            ctx.globalAlpha = alpha;
          }
          ctx.fillRect(m.a, bandT, 2, bandH);
          if (st.ok === 0 && !m.dim) {
            ctx.beginPath();
            ctx.arc(m.a + 1, bandT - 2, 2.2, 0, Math.PI * 2);
            ctx.fill();
          }
          if (age < 1 && !m.dim) {
            ctx.globalAlpha = 1 - age;
            ctx.strokeStyle = c;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(m.a - 3 - 4 * age, bandT - 2 - 3 * age, 8 + 8 * age, bandH + 4 + 6 * age);
            ctx.lineWidth = 1;
          }
        }
        ctx.globalAlpha = 1;
        if (hoverStep === st) {
          ctx.strokeStyle = '#e7edf6';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(m.a - 1.5, bandT - 1.5, Math.max(2, m.b - m.a) + 3, bandH + 3);
          ctx.lineWidth = 1;
        }
        hits.push({ row, a: m.a - 2, b: Math.max(m.a + 2, m.b) + 2, y0: top, y1: top + row.h, st });
      }
    }
    ctx.restore();

    ctx.fillStyle = 'rgba(148, 163, 184, .1)';
    ctx.fillRect(G, AXIS, 1, H - AXIS);
    ctx.fillStyle = 'rgba(148, 163, 184, .12)';
    ctx.fillRect(0, AXIS - 1, W, 1);

    const xn = X(tn);
    if (xn >= px0 - 1 && xn <= px1 + 1) {
      const g = ctx.createLinearGradient(xn - 36, 0, xn, 0);
      g.addColorStop(0, 'rgba(52, 211, 153, 0)');
      g.addColorStop(1, 'rgba(52, 211, 153, .12)');
      ctx.fillStyle = g;
      ctx.fillRect(xn - 36, AXIS, 36, H - AXIS);
      ctx.fillStyle = 'rgba(52, 211, 153, .85)';
      ctx.fillRect(Math.round(xn) - 0.5, AXIS - 4, 1.5, H - AXIS + 4);
      ctx.fillStyle = '#34d399';
      ctx.font = '600 10.5px ' + getComputedStyle(document.body).fontFamily;
      ctx.fillText('now', Math.min(px1 - 22, xn + 5), AXIS / 2);
    }
    if (mouse && mouse.x > px0 && mouse.x < px1 && mouse.y > AXIS) {
      const x = Math.round(mouse.x) + 0.5;
      ctx.strokeStyle = 'rgba(231, 237, 246, .28)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, AXIS);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = clock(T(mouse.x), true);
      ctx.font = '600 11px ' + getComputedStyle(document.body).fontFamily;
      const lw = ctx.measureText(label).width + 12;
      const lx = Math.max(px0, Math.min(px1 - lw, x - lw / 2));
      ctx.fillStyle = '#1b2a44';
      ctx.fillRect(lx, 3, lw, AXIS - 6);
      ctx.fillStyle = '#e7edf6';
      ctx.fillText(label, lx + 6, AXIS / 2);
    }
    const ms = maxScroll();
    if (ms > 0) {
      const track = H - AXIS - 6;
      const th = Math.max(24, track * (H - AXIS) / rowsHeight());
      ctx.fillStyle = 'rgba(148, 163, 184, .3)';
      ctx.fillRect(G - 4, AXIS + 3 + (track - th) * (rowScroll / ms), 3, th);
    }
    tl.dataset.px0 = px0;
    tl.dataset.px1 = px1;
    return anim;
  }

  // ---------- timeline input ----------

  function canvasPoint(e) {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function rowAt(y) {
    for (const r of rows) if (y >= r.y && y < r.y + r.h) return r;
    return null;
  }
  function hitAt(p) {
    let best = null;
    let bestD = 1e9;
    for (const h of hits) {
      if (p.y < h.y0 || p.y > h.y1) continue;
      const d = p.x < h.a ? h.a - p.x : p.x > h.b ? p.x - h.b : 0;
      if (d <= 4 && (d < bestD || (d === bestD && h.st && best && best.st && h.st.t > best.st.t))) { best = h; bestD = d; }
    }
    return best;
  }
  function showTip(h, p) {
    if (!h) { tip.hidden = true; return; }
    let html;
    if (h.shell) {
      const sh = h.shell;
      const word = sh.state === 'running' ? 'Running for ' + dur(now() - sh.startedAt) : sh.state === 'failed' ? (sh.why || 'Failed') + ' (exit ' + (sh.exit != null ? sh.exit : '?') + ')' : sh.state === 'died' ? 'Killed' : 'Finished' + (sh.doneAt ? ' in ' + dur(sh.doneAt - sh.startedAt) : '');
      html = '<div class="tt-h"><span class="sw" style="background:#aab6c8"></span>Background command<span class="tt-s ' + (sh.state === 'running' ? 'open' : sh.state === 'done' ? 'ok' : 'bad') + '">' + esc(word) + '</span></div>' +
        '<div class="tt-l">' + esc(sh.desc) + '</div><div class="tt-w">' + esc(h.row.s ? h.row.s.name : '') + ' · started ' + esc(clock(sh.startedAt, true)) + '</div>';
    } else {
      const st = h.st;
      const k = KINDS.find((x) => x.id === st.g);
      const r = st.r ? resName(st.r) : null;
      const status = st.ok === -1 ? '<span class="tt-s open">Running ' + dur(now() - st.t) + '</span>' : st.ok === 0 ? '<span class="tt-s bad">✕ Failed after ' + dur(st.e - st.t) + '</span>' : st.ok === 2 ? '<span class="tt-s cut">Cut off after ' + dur(st.e - st.t) + '</span>' : '<span class="tt-s ok">✓ ' + dur(st.e - st.t) + '</span>';
      html = '<div class="tt-h"><span class="sw" style="background:' + k.c + '"></span>' + esc(k.label) + ' · ' + esc(st.n) + status + '</div>' +
        '<div class="tt-l">' + esc(flat(st.l)) + '</div>' +
        (r ? '<div class="tt-r">' + GLYPH[r.icon] + '<span>' + esc(r.full) + '</span></div>' : '') +
        '<div class="tt-w">' + whoHtml(st) + '</div>' +
        '<div class="tt-t">' + esc(clock(st.t, true)) + '</div>' +
        (st.err ? '<div class="tt-e">' + esc(flat(st.err).slice(0, 240)) + '</div>' : '') +
        '<div class="tt-hint">Click to open ' + esc(st.o == null ? 'the session' : 'the agent') + '</div>';
    }
    if (tip.html !== html) { tip.innerHTML = html; tip.html = html; }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const tr = tl.getBoundingClientRect();
    let x = p.x + 14;
    if (x + tw > tr.width - 8) x = p.x - tw - 14;
    let y = p.y - th - 10;
    if (y < 4) y = Math.min(tr.height - th - 4, p.y + 16);
    tip.style.transform = 'translate(' + Math.max(4, x) + 'px,' + Math.max(-dock.getBoundingClientRect().top + 8, y) + 'px)';
  }
  function setHoverNode(id, fromBoard) {
    if (hoverNode === id) return;
    hoverNode = id;
    if (!fromBoard) OV.hover(id);
    touchList.html = null;
    renderTouch(win());
    drawWires();
  }
  // a session counts what its agents touched too
  function touchedBy(a, id) {
    if (a.nodes.has(id)) return a.nodes.get(id);
    if (id.indexOf('s:') !== 0) return 0;
    const mark = ':' + id.slice(2) + ':';
    let n = 0;
    for (const [node, c] of a.nodes) if (node.indexOf(mark) > 0) n += c;
    return n;
  }
  let tlDrag = null;
  let tlMoved = false;
  cv.addEventListener('pointermove', (e) => {
    const p = canvasPoint(e);
    if (tlDrag && e.pointerId === tlDrag.id) {
      const dx = e.clientX - tlDrag.x;
      if (!tlDrag.on && Math.abs(dx) < 4 && Math.abs(e.clientY - tlDrag.y) < 4) return;
      if (!tlDrag.on) { tlDrag.on = true; cv.setPointerCapture(e.pointerId); tl.classList.add('dragging'); }
      tlMoved = true;
      if (tlDrag.rows) {
        rowScroll = Math.max(0, Math.min(maxScroll(), tlDrag.scroll - (e.clientY - tlDrag.y)));
      } else {
        const msPerPx = span / Math.max(1, Number(tl.dataset.px1) - Number(tl.dataset.px0));
        tEnd = Math.min(now(), tlDrag.end - dx * msPerPx);
        tEnd = Math.max(now() - HIST_MS + span, tEnd);
        live = tEnd >= now() - 1000;
        renderControls();
      }
      tip.hidden = true;
      dirty(true);
      return;
    }
    mouse = p;
    const row = rowAt(p.y);
    const h = p.y > AXIS ? hitAt(p) : null;
    const st = h && h.st ? h.st : null;
    const changed = row !== hoverRow || st !== hoverStep;
    hoverRow = row;
    hoverStep = st;
    showTip(h, p);
    cv.style.cursor = h || (row && p.x < gutter()) ? 'pointer' : 'crosshair';
    if (changed) {
      const target = st ? st.node : row && p.x < gutter() ? row.id : null;
      setHoverNode(target, false);
      hoverKeyFromStep(st);
    }
    dirty(false);
  });
  cv.addEventListener('pointerleave', () => {
    mouse = null;
    hoverRow = null;
    hoverStep = null;
    tip.hidden = true;
    setHoverNode(null, false);
    hoverKeyFromStep(null);
    dirty(false);
  });
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = canvasPoint(e);
    tlDrag = { x: e.clientX, y: e.clientY, id: e.pointerId, end: live ? now() : tEnd, scroll: rowScroll, rows: p.x < gutter(), on: false };
    tlMoved = false;
  });
  function endTlDrag() {
    tlDrag = null;
    tl.classList.remove('dragging');
  }
  cv.addEventListener('pointerup', (e) => {
    const was = tlDrag && tlDrag.on;
    endTlDrag();
    if (was || tlMoved) return;
    const p = canvasPoint(e);
    const row = rowAt(p.y);
    if (p.y <= AXIS) return;
    if (row && p.x < gutter()) {
      if (row.type === 'session' && row.canOpen) {
        if (open.has(row.sid)) open.delete(row.sid); else open.add(row.sid);
        store(KEYS.open, JSON.stringify([...open]));
        dirty(true);
      } else OV.show(row.id);
      return;
    }
    const h = hitAt(p);
    if (h && h.st) OV.show(h.st.node);
    else if (h && h.shell && h.row.s) OV.show('t:' + h.row.s.id + ':' + h.shell.id);
  });
  cv.addEventListener('pointercancel', endTlDrag);
  cv.addEventListener('dblclick', (e) => {
    const p = canvasPoint(e);
    if (p.x < gutter()) return;
    live = true;
    renderControls();
    dirty(true);
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = canvasPoint(e);
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? cv.cssH : 1;
    const px0 = Number(tl.dataset.px0);
    const px1 = Number(tl.dataset.px1);
    const w = win();
    if ((e.ctrlKey || e.metaKey) && e.deltaY) {
      const f = Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0022));
      const ns = Math.max(MIN_SPAN, Math.min(HIST_MS, span * f));
      if (live) span = ns;
      else {
        const at = w.t0 + ((Math.max(px0, Math.min(px1, p.x)) - px0) / Math.max(1, px1 - px0)) * span;
        const frac = (at - w.t0) / span;
        let t1 = at + (1 - frac) * ns;
        t1 = Math.min(now(), t1);
        span = ns;
        tEnd = t1;
        live = t1 >= now() - 1000;
      }
    } else if (Math.abs(dx) > Math.abs(dy)) {
      const t1 = Math.max(now() - HIST_MS + span, Math.min(now(), w.t1 + dx * unit * span / Math.max(1, px1 - px0)));
      tEnd = t1;
      live = t1 >= now() - 1000;
    } else {
      rowScroll = Math.max(0, Math.min(maxScroll(), rowScroll + dy * unit));
      dirty(false);
      return;
    }
    renderControls();
    tip.hidden = true;
    dirty(true);
  }, { passive: false });

  // ---------- rail: what the work touches ----------

  function aggregate(list) {
    const m = new Map();
    for (const st of list) {
      if (!st.r) continue;
      let a = m.get(st.r);
      if (!a) {
        a = { key: st.r, n: 0, g: {}, sids: new Map(), editors: new Set(), nodes: new Map(), last: 0, fails: 0, live: 0, steps: [] };
        m.set(st.r, a);
      }
      a.n++;
      a.g[st.g] = (a.g[st.g] || 0) + 1;
      a.sids.set(st.sid, (a.sids.get(st.sid) || 0) + 1);
      if (st.k === 'edit') a.editors.add(st.sid);
      a.nodes.set(st.node, (a.nodes.get(st.node) || 0) + 1);
      a.last = Math.max(a.last, st.t);
      if (st.ok === 0) a.fails++;
      if (st.ok === -1) a.live++;
      a.steps.push(st);
    }
    return m;
  }
  function stripSvg(list, w, width, height) {
    let h = '<svg class="strip" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">';
    const sp = w.t1 - w.t0;
    for (const st of list) {
      const x = Math.max(0, Math.min(width - 2, Math.round(((st.t - w.t0) / sp) * width)));
      h += '<rect x="' + x + '" y="' + (st.ok === 0 ? 0 : 2) + '" width="1.6" height="' + (st.ok === 0 ? height : height - 4) + '" fill="' + (st.ok === 0 ? BAD : KC[st.g]) + '"/>';
    }
    return h + '</svg>';
  }
  function dominant(a) {
    let best = 'other';
    let n = -1;
    for (const k of KINDS) if ((a.g[k.id] || 0) > n) { n = a.g[k.id] || 0; best = k.id; }
    return best;
  }
  function chipsHtml(a) {
    const ids = [...a.sids.keys()].sort((x, y) => a.sids.get(y) - a.sids.get(x));
    let h = ids.slice(0, 2).map((sid) => '<span class="sc" title="' + esc(sessName(sid) + ': ' + a.sids.get(sid)) + '">' + esc(sessName(sid)) + '</span>').join('');
    if (ids.length > 2) h += '<span class="sc extra" title="' + esc(ids.slice(2).map(sessName).join(', ')) + '">+' + (ids.length - 2) + '</span>';
    return h;
  }
  let touchFrozen = false;
  function renderTouch(w) {
    const all = [...agg.values()];
    const counts = { all: all.length, files: 0, hosts: 0, web: 0, tools: 0 };
    for (const a of all) counts[keyType(a.key)]++;
    let th = '<button type="button" data-tab="all" aria-pressed="' + (tab === 'all') + '">All<b>' + counts.all + '</b></button>';
    for (const t in TABS) th += '<button type="button" data-tab="' + t + '" aria-pressed="' + (tab === t) + '">' + TABS[t] + '<b>' + counts[t] + '</b></button>';
    if (touchTabs.html !== th) { touchTabs.innerHTML = th; touchTabs.html = th; }
    const by = hoverNode && !touchFrozen ? hoverNode : null;
    const byName = by ? OV.name(by) || 'this' : '';
    touchSub.textContent = (by ? 'by ' + byName + ' · ' : '') + (live ? 'last ' + spanWord(span) : clock(w.t0) + ' – ' + clock(w.t1)) + (touchFrozen ? ' · paused while you point' : '');
    touchList.classList.toggle('by', !!by);
    if (touchFrozen) return;
    const list = all.filter((a) => (tab === 'all' || keyType(a.key) === tab) && (!by || touchedBy(a, by)));
    // more than one editor on a resource is a collision, so those lead
    if (by) list.sort((x, y) => touchedBy(y, by) - touchedBy(x, by) || y.last - x.last);
    else list.sort((x, y) => (y.editors.size > 1) - (x.editors.size > 1) || (y.live > 0) - (x.live > 0) || y.last - x.last);
    let h = '';
    for (const a of list.slice(0, MAX_TOUCH)) {
      const r = resName(a.key);
      const dk = dominant(a);
      let flags = '';
      if (a.editors.size > 1) flags += '<span class="flag hot" title="More than one session changed this in the window">' + a.editors.size + ' sessions editing</span>';
      if (a.fails) flags += '<span class="flag bad">' + a.fails + ' failed</span>';
      const sel = OV.selected() === 'r:' + a.key;
      h += '<li class="tr' + (a.live ? ' live' : '') + (sel ? ' sel' : '') + '" data-key="' + esc(a.key) + '" tabindex="0" style="--kc:' + KC[dk] + '">' +
        '<span class="tg">' + GLYPH[r.icon] + '</span>' +
        '<div class="tm"><div class="tn"><b>' + esc(r.name) + '</b><span>' + esc(r.sub) + '</span></div>' +
        '<div class="tw">' + chipsHtml(a) + flags + '</div></div>' +
        '<div class="ts">' + stripSvg(a.steps, w, 72, 14) + '<div class="tc"><b>' + a.n + '</b><span data-since="' + Number(a.last) + '" data-ago></span></div></div></li>';
    }
    if (!list.length) h = '<li class="r-empty">' + (by ? esc(byName) + ' touched no files, servers or sites in this window.' : steps.length ? 'Nothing touched in this window.' : 'Waiting for the first tool calls…') + '</li>';
    if (touchList.html !== h) {
      touchList.innerHTML = h;
      touchList.html = h;
      touchList.scrollTop = by ? 0 : touchList.scrollTop;
      for (const el of touchList.querySelectorAll('[data-since]')) el.textContent = OV.since(Number(el.dataset.since), true);
      if (hoverNode) drawWires();
    }
  }
  function spanWord(ms) {
    if (ms >= 3600e3) return (Math.round(ms / 360e3) / 10) + ' h';
    return Math.round(ms / 60e3) + ' min';
  }
  touchTabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    store(KEYS.tab, tab);
    touchFrozen = false;
    touchList.html = null;
    refresh();
  });
  touchList.addEventListener('pointerenter', () => { touchFrozen = true; });
  touchList.addEventListener('pointerleave', () => {
    touchFrozen = false;
    setHoverKey(null);
    dirty(true);
  });
  touchList.addEventListener('pointerover', (e) => {
    const li = e.target.closest('.tr');
    setHoverKey(li ? li.dataset.key : null);
  });
  touchList.addEventListener('click', (e) => {
    const li = e.target.closest('.tr');
    if (li) OV.open('r:' + li.dataset.key);
  });
  touchList.addEventListener('keydown', (e) => {
    const li = e.target.closest('.tr');
    if (li && e.key === 'Enter') OV.open('r:' + li.dataset.key);
  });
  function setHoverKey(key) {
    if (hoverKey === key) return;
    hoverKey = key;
    const a = key && agg.get(key);
    OV.mark(a ? [...a.nodes.keys()] : null);
    drawWires();
    dirty(false);
  }
  function hoverKeyFromStep(st) {
    for (const el of touchList.querySelectorAll('.tr.lit')) el.classList.remove('lit');
    if (!st || !st.r) return;
    const li = touchList.querySelector('[data-key="' + CSS.escape(st.r) + '"]');
    if (li) li.classList.add('lit');
  }

  // ---------- rail: live feed ----------

  const feedRows = new Map();
  const feedQueue = [];
  let feedFrozen = false;
  function statusHtml(st) {
    if (st.ok === -1) return '<span class="fs open" title="Running"><i></i></span>';
    if (st.ok === 0) return '<span class="fs bad" title="Failed">✕</span>';
    if (st.ok === 2) return '<span class="fs cut" title="Cut off">–</span>';
    return '<span class="fs ok" title="Finished in ' + dur(st.e - st.t) + '">✓</span>';
  }
  function feedLi(st, animate) {
    const li = document.createElement('li');
    li.className = 'fr' + (animate ? ' in' : '') + (st.ok === 0 ? ' failed' : '');
    li.dataset.seq = st.s;
    li.style.setProperty('--kc', st.ok === 0 ? BAD : KC[st.g]);
    li.tabIndex = 0;
    const r = st.r ? resName(st.r) : null;
    li.innerHTML = '<span class="ft">' + esc(clock(st.t, true)) + '</span><span class="fk"></span>' +
      '<div class="fm"><div class="fl">' + esc(flat(st.l)) + '</div><div class="fw">' + whoHtml(st) + (r ? '<span class="fres">' + esc(r.name) + '</span>' : '') + '</div></div>' + statusHtml(st);
    return li;
  }
  function feedIn(fresh) {
    const list = fresh.filter(wanted);
    if (!list.length) return;
    if (feedFrozen) {
      feedQueue.push(...list);
      feedNew.hidden = false;
      feedNew.textContent = feedQueue.length + ' new';
      return;
    }
    insertFeed(list, true);
  }
  function insertFeed(list, animate) {
    list.sort((a, b) => a.t - b.t || a.s - b.s);
    for (const st of list) {
      if (feedRows.has(st.s)) continue;
      const li = feedLi(st, animate && !reduced);
      feedEl.insertBefore(li, feedEl.firstChild);
      feedRows.set(st.s, li);
    }
    while (feedEl.children.length > MAX_FEED) {
      const last = feedEl.lastChild;
      feedRows.delete(Number(last.dataset.seq));
      last.remove();
    }
  }
  function rebuildFeed() {
    feedEl.innerHTML = '';
    feedRows.clear();
    feedQueue.length = 0;
    feedNew.hidden = true;
    const out = [];
    for (let i = steps.length - 1; i >= 0 && out.length < MAX_FEED; i--) if (wanted(steps[i])) out.push(steps[i]);
    insertFeed(out, false);
  }
  function flushFeed() {
    feedFrozen = false;
    feedNew.hidden = true;
    if (feedQueue.length) insertFeed(feedQueue.splice(0), true);
  }
  feedEl.addEventListener('pointerenter', () => { feedFrozen = true; });
  feedEl.addEventListener('pointerleave', () => {
    flushFeed();
    setHoverNode(null, false);
  });
  feedNew.addEventListener('click', () => { feedEl.scrollTop = 0; flushFeed(); });
  feedEl.addEventListener('pointerover', (e) => {
    const li = e.target.closest('.fr');
    const st = li && bySeq.get(Number(li.dataset.seq));
    setHoverNode(st ? st.node : null, false);
    hoverKeyFromStep(st || null);
  });
  feedEl.addEventListener('click', (e) => {
    const li = e.target.closest('.fr');
    const st = li && bySeq.get(Number(li.dataset.seq));
    if (st) OV.show(st.node);
  });
  feedEl.addEventListener('keydown', (e) => {
    const li = e.target.closest('.fr');
    const st = li && bySeq.get(Number(li.dataset.seq));
    if (st && e.key === 'Enter') OV.show(st.node);
  });
  function renderFeedHead() {
    const tn = now();
    let n = 0;
    for (let i = firstIndex(tn - 60e3); i < steps.length; i++) if (wanted(steps[i])) n++;
    const running = steps.filter((st) => st.ok === -1 && wanted(st)).length;
    feedSub.innerHTML = '<b>' + n + '</b>/min' + (running ? ' · <b>' + running + '</b> running' : '');
  }

  // ---------- wires and packets ----------

  function railTarget(st) {
    if (!railOn) return null;
    const listRect = touchList.getBoundingClientRect();
    if (st && st.r) {
      const li = touchList.querySelector('[data-key="' + CSS.escape(st.r) + '"]');
      if (li) {
        const r = li.getBoundingClientRect();
        if (r.bottom > listRect.top + 4 && r.top < listRect.bottom - 4) return r;
      }
    }
    const li = st && feedRows.get(st.s);
    if (li) {
      const r = li.getBoundingClientRect();
      const fr = feedEl.getBoundingClientRect();
      if (r.bottom > fr.top && r.top < fr.bottom) return r;
    }
    return null;
  }
  function wirePath(a, b) {
    const x0 = a.right;
    const y0 = a.top + a.height / 2;
    const x1 = b.left;
    const y1 = b.top + b.height / 2;
    const dx = Math.max(40, (x1 - x0) * 0.45);
    return 'M' + x0 + ',' + y0 + 'C' + (x0 + dx) + ',' + y0 + ' ' + (x1 - dx) + ',' + y1 + ' ' + x1 + ',' + y1;
  }
  function boardClip(r) {
    // a card scrolled off the board is drawn from the board's edge
    const v = OV.viewportRect();
    if (!r) return null;
    const top = Math.max(v.top, Math.min(v.bottom - 2, r.top));
    const bottom = Math.max(top + 2, Math.min(v.bottom, r.bottom));
    const right = Math.max(v.left + 2, Math.min(v.right, r.right));
    return { left: r.left, right, top, bottom, height: bottom - top, width: right - r.left };
  }
  function drawWires() {
    wHover.innerHTML = '';
    for (const el of touchList.querySelectorAll('.tr.wired')) el.classList.remove('wired');
    if (!railOn || OV.selected()) return;
    const pairs = [];
    if (hoverKey) {
      const a = agg.get(hoverKey);
      const li = touchList.querySelector('[data-key="' + CSS.escape(hoverKey) + '"]');
      if (a && li) {
        const b = li.getBoundingClientRect();
        const seen = new Set();
        for (const [node] of [...a.nodes.entries()].sort((x, y) => y[1] - x[1]).slice(0, 14)) {
          const r = OV.rect(node);
          const key = r ? r.left + ',' + r.top : '';
          if (!r || seen.has(key)) continue;
          seen.add(key);
          pairs.push({ a: boardClip(r), b, c: KC[dominant(a)] });
        }
      }
    } else if (hoverNode) {
      const r = OV.rect(hoverNode);
      if (r) {
        const listRect = touchList.getBoundingClientRect();
        for (const li of touchList.querySelectorAll('.tr')) {
          const b = li.getBoundingClientRect();
          if (b.top > listRect.bottom - 6) break;
          const a = agg.get(li.dataset.key);
          if (b.bottom < listRect.top + 6 || !a || !touchedBy(a, hoverNode)) continue;
          li.classList.add('wired');
          pairs.push({ a: boardClip(r), b, c: KC[dominant(a)] });
          if (pairs.length >= 10) break;
        }
      }
    }
    for (const p of pairs) {
      if (!p.a) continue;
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', wirePath(p.a, p.b));
      path.setAttribute('class', 'wire');
      path.style.setProperty('--kc', p.c);
      wHover.appendChild(path);
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('cx', p.b.left);
      dot.setAttribute('cy', p.b.top + p.b.height / 2);
      dot.setAttribute('r', 3);
      dot.setAttribute('class', 'wire-end');
      dot.style.setProperty('--kc', p.c);
      wHover.appendChild(dot);
    }
  }
  function packets(fresh) {
    // an open panel covers the right column the packets fly to
    if (reduced || document.hidden || !railOn || OV.selected()) return;
    const list = fresh.filter(wanted).slice(-14);
    list.forEach((st, i) => setTimeout(() => packet(st), i * 110));
  }
  function packet(st) {
    const a = boardClip(OV.rect(st.node));
    const b = railTarget(st);
    if (!a || !b) return;
    const c = st.ok === 0 ? BAD : KC[st.g];
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', wirePath(a, b));
    path.setAttribute('class', 'trail');
    path.style.setProperty('--kc', c);
    wPk.appendChild(path);
    const len = path.getTotalLength();
    path.style.strokeDasharray = '60 ' + (len + 60);
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('r', 3.6);
    dot.setAttribute('class', 'pk');
    dot.style.setProperty('--kc', c);
    wPk.appendChild(dot);
    const t0 = performance.now();
    const D = 900;
    (function step(t) {
      const k = Math.min(1, (t - t0) / D);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const p = path.getPointAtLength(e * len);
      dot.setAttribute('cx', p.x);
      dot.setAttribute('cy', p.y);
      path.style.strokeDashoffset = String(60 - e * len);
      const fade = k > 0.85 ? (1 - k) / 0.15 : 1;
      dot.style.opacity = String(fade);
      path.style.opacity = String(0.85 * fade);
      if (k < 1) requestAnimationFrame(step);
      else {
        dot.remove();
        path.remove();
        landed(st);
      }
    })(t0);
  }
  function landed(st) {
    const li = st.r && touchList.querySelector('[data-key="' + CSS.escape(st.r) + '"]');
    const el = li || feedRows.get(st.s);
    if (!el) return;
    el.classList.remove('hit');
    void el.offsetWidth;
    el.classList.add('hit');
    setTimeout(() => el.classList.remove('hit'), 700);
  }

  // ---------- panel sections ----------

  function stepsFor(n) {
    if (!n) return [];
    if (n.kind === 'session' || n.kind === 'child') return steps.filter((st) => st.sid === n.data.id);
    if (n.kind === 'agent' || n.kind === 'wa') return steps.filter((st) => st.node === n.id);
    if (n.kind === 'wf') { const p = 'wa:' + n.sid + ':' + n.data.runId + ':'; return steps.filter((st) => st.node.indexOf(p) === 0); }
    return [];
  }
  function sec(title, body, extra) { return body ? '<section class="p-sec' + (extra ? ' ' + extra : '') + '"><h3>' + esc(title) + '</h3>' + body + '</section>' : ''; }
  function kindBar(list) {
    const n = {};
    for (const st of list) n[st.g] = (n[st.g] || 0) + 1;
    const total = list.length || 1;
    let bar = '<div class="kbar">';
    let legend = '<ul class="klegend">';
    for (const k of KINDS) {
      if (!n[k.id]) continue;
      bar += '<i style="flex:' + n[k.id] + ';background:' + k.c + '" title="' + esc(k.label) + ' ' + n[k.id] + '"></i>';
      legend += '<li><span class="sw" style="background:' + k.c + '"></span>' + esc(k.label) + '<b>' + n[k.id] + '</b><span>' + Math.round((n[k.id] / total) * 100) + '%</span></li>';
    }
    return bar + '</div>' + legend + '</ul>';
  }
  function statsGrid(list) {
    const fails = list.filter((st) => st.ok === 0).length;
    const running = list.filter((st) => st.ok === -1).length;
    const perMin = new Map();
    for (const st of list) { const m = Math.floor(st.t / 60e3); perMin.set(m, (perMin.get(m) || 0) + 1); }
    let peak = 0;
    let peakAt = 0;
    for (const [m, c] of perMin) if (c > peak) { peak = c; peakAt = m * 60e3; }
    const done = list.filter((st) => st.e && st.ok !== -1);
    const total = done.reduce((s, st) => s + (st.e - st.t), 0);
    const slow = done.slice().sort((a, b) => (b.e - b.t) - (a.e - a.t))[0];
    return '<dl class="p-grid">' +
      '<dt>Tool calls</dt><dd>' + list.length + (running ? ' · ' + running + ' running now' : '') + '</dd>' +
      '<dt>Failed</dt><dd>' + (fails ? '<span class="bad-t">' + fails + ' (' + Math.round((fails / list.length) * 100) + '%)</span>' : 'none') + '</dd>' +
      '<dt>Busiest minute</dt><dd>' + peak + ' calls at ' + esc(clock(peakAt)) + '</dd>' +
      '<dt>Time in tools</dt><dd>' + esc(dur(total)) + '</dd>' +
      (slow ? '<dt>Longest call</dt><dd>' + esc(dur(slow.e - slow.t)) + ' · ' + esc(flat(slow.l)) + '</dd>' : '') +
      '</dl>';
  }
  function resList(list, max) {
    const m = aggregate(list);
    const top = [...m.values()].sort((a, b) => b.n - a.n).slice(0, max);
    if (!top.length) return '';
    return '<ul class="p-res">' + top.map((a) => {
      const r = resName(a.key);
      const kinds = KINDS.filter((k) => a.g[k.id]).map((k) => '<span class="kd" style="--kc:' + k.c + '" title="' + esc(k.label) + '">' + a.g[k.id] + '</span>').join('');
      return '<li data-res="' + esc(a.key) + '" title="' + esc(r.full) + '"><span class="tg">' + GLYPH[r.icon] + '</span><span class="nm"><b>' + esc(r.name) + '</b><span>' + esc(r.sub) + '</span></span><span class="kds">' + kinds + (a.fails ? '<span class="kd bad">' + a.fails + ' ✕</span>' : '') + '</span></li>';
    }).join('') + '</ul>';
  }
  function failList(list, max) {
    const f = list.filter((st) => st.ok === 0).slice(-max).reverse();
    if (!f.length) return '';
    return '<ul class="p-fails">' + f.map((st) => '<li><div class="fh"><span class="t" data-since="' + Number(st.t) + '" data-ago></span>' + esc(flat(st.l)) + '</div>' + (st.err ? '<div class="fe">' + esc(flat(st.err).slice(0, 300)) + '</div>' : '') + '</li>').join('') + '</ul>';
  }
  function histWindow(list) {
    const tn = now();
    const t0 = Math.max(tn - HIST_MS, Math.min(tn - 10 * 60e3, list.length ? list[0].t : tn));
    return { t0, t1: tn };
  }
  function activityBlock(list, title) {
    const w = histWindow(list);
    return sec(title || 'Activity', '<div class="p-strip">' + stripSvg(list, w, 420, 30) + '<div class="p-axis"><span>' + esc(clock(w.t0)) + '</span><span>now</span></div></div>' + kindBar(list) + statsGrid(list), 'p-act');
  }
  function panelHtml(n) {
    if (!n || n.kind === 'shell' || n.kind === 'more') return '';
    const list = stepsFor(n);
    if (!list.length) return sec('Activity', '<p class="p-text">No tool calls seen in the last 3 hours.</p>');
    return activityBlock(list, 'Activity · last ' + spanWord(now() - histWindow(list).t0)) +
      sec('Touched most', resList(list, 10)) +
      sec('Failed lately', failList(list, 6));
  }
  // A finished agent drops off the map before its steps leave the history, so its rows are not links.
  function focusAttr(node) {
    return OV.name(node) ? ' data-focus="' + esc(node) + '"' : ' data-gone title="Finished and no longer on the map"';
  }
  function resourcePanel(key) {
    const r = resName(key);
    const list = steps.filter((st) => st.r === key);
    let h = '<div class="p-top"><span class="p-kind">' + esc(r.type) + '</span><button type="button" class="p-x" data-close aria-label="Close">×</button></div>';
    h += '<h2 class="p-title">' + esc(r.name) + '</h2>';
    h += '<div class="p-path">' + esc(r.full) + '</div>';
    if (!list.length) return h + '<p class="p-text">Nothing touched this in the last 3 hours.</p>';
    const a = aggregate(list).get(key);
    if (a.editors.size > 1) h += '<div class="p-reason c-stalled">' + a.editors.size + ' sessions changed this: ' + esc([...a.editors].map(sessName).join(', ')) + '. Their edits may collide.</div>';
    h += activityBlock(list, 'Touches · last ' + spanWord(now() - histWindow(list).t0));
    const who = [...a.nodes.entries()].sort((x, y) => y[1] - x[1]).map(([node, c]) => {
      const st = a.steps.find((x) => x.node === node);
      const kinds = {};
      for (const x of a.steps) if (x.node === node) kinds[x.g] = (kinds[x.g] || 0) + 1;
      const kd = KINDS.filter((k) => kinds[k.id]).map((k) => '<span class="kd" style="--kc:' + k.c + '" title="' + esc(k.label) + '">' + kinds[k.id] + '</span>').join('');
      return '<li' + focusAttr(node) + '><span class="nm"><b>' + esc(ownerName(st)) + '</b><span>' + esc(st.o == null ? 'main thread' : sessName(st.sid)) + '</span></span><span class="kds">' + kd + '</span></li>';
    }).join('');
    h += sec('Who touched it', '<ul class="p-res p-who">' + who + '</ul>');
    const rowsH = list.slice(-80).reverse().map((st) => '<li class="' + (st.ok === 0 ? 'failed' : '') + '"' + focusAttr(st.node) + ' style="--kc:' + (st.ok === 0 ? BAD : KC[st.g]) + '"><span class="t">' + esc(clock(st.t, true)) + '</span><span class="fk"></span><span class="lb">' + esc(flat(st.l)) + '<small>' + esc(ownerName(st)) + '</small></span>' + statusHtml(st) + '</li>').join('');
    h += sec('Every touch', '<ul class="p-touches">' + rowsH + '</ul>');
    return h;
  }

  // ---------- frame loop ----------

  let raf = 0;
  let timer = 0;
  let dataDirty = true;
  let lastAgg = 0;
  let lastData = 0;
  function dirty(data) {
    if (data) dataDirty = true;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  // a control changed what is shown: redraw the counts and lists at once, not on the next second
  function refresh() {
    lastAgg = 0;
    dirty(true);
  }
  function frame() {
    raf = 0;
    const w = win();
    if (performance.now() - lastData > 1000) dataDirty = true;
    if (dataDirty) {
      dataDirty = false;
      lastData = performance.now();
      shown = windowSteps(w);
      rows = buildRows(shown, w);
      // only this once on its own: a timeline that followed its rows would move the board every time one came or went
      if (!sized && histIn) {
        sized = true;
        if (rows.length && !userDock && !folded && autoDock() !== dockH) {
          layout();
          OV.relayout(true);
        }
      }
      const pn = performance.now();
      if (pn - lastAgg > 900 || !agg.size) {
        lastAgg = pn;
        agg = aggregate(shown);
        renderTouch(w);
        renderKinds(shown);
        renderFeedHead();
      }
      tlEmpty.hidden = rows.length > 0;
    }
    const anim = document.hidden || folded ? 0 : draw();
    clearTimeout(timer);
    if (anim === 2 && !reduced) dirty(false);
    else if (anim === 1 && !reduced) timer = setTimeout(() => dirty(false), 100);
    else timer = setTimeout(() => dirty(true), document.hidden ? 5000 : live ? 1000 : 4000);
  }

  // ---------- hooks from the board ----------

  window.OVLive = {
    ingest,
    onSnap(s) {
      snap = s;
      sessions = flattenSessions();
      sessById = new Map(sessions.map((x) => [x.s.id, x.s]));
      dirty(true);
    },
    onView() {
      if (hoverKey || hoverNode) {
        drawWires();
        // keep the wires on the cards while the board glides
        const until = performance.now() + 700;
        (function follow() { drawWires(); if (performance.now() < until) requestAnimationFrame(follow); })();
      }
    },
    hoverNode(id) { setHoverNode(id, true); },
    onSelect() { touchList.html = null; refresh(); },
    panelHtml,
    resourcePanel,
  };

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === 't' || e.key === 'T') setFold(!folded);
    else if (e.key === 'l' || e.key === 'L') { live = true; renderControls(); dirty(true); }
    else if ((e.key === 's' || e.key === 'S') && !e.repeat && !railBtn.hidden) setRail(!railOn);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) dirty(true); });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { layout(); dirty(true); }, 60);
  });
  new ResizeObserver(() => { sizeCanvas(); dirty(false); }).observe(tl);

  layout();
  renderControls();
  OV.relayout();
  rebuildFeed();
  dirty(true);
})();
