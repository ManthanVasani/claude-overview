(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const W = { session: 330, child: 340, agent: 340, wf: 340, wa: 300, shell: 320, more: 320 };
  const H = { session: 134, child: 78, agent: 78, wf: 92, wa: 58, shell: 30, more: 28 };
  const GAP_X = 52;
  const GAP_Y = 10;
  const GAP_SHELL = 6;
  const GAP_GROUP = 18;
  const PAD = 16;
  const LANE_GAP = 22;
  const BUS = 24;
  const MARGIN = 28;
  const MAX_SHELLS = 5;
  const MAX_DONE = 3;
  const MIN_FIT = 0.5;
  const FIT_MAX = 1.5;
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 2.2;
  const PULSE_MS = 700;
  const ACTIVE_KEY = 'claude-overview-only-active';
  const VIEW_KEY = 'claude-overview-view';
  const ALERTS_KEY = 'claude-overview-alerts-open';

  const $ = (id) => document.getElementById(id);
  const viewport = $('viewport');
  const world = $('world');
  const panel = $('panel');
  const alertsEl = $('alerts');
  const hudText = $('hud-text');
  const mark = $('mark');
  const bannerEl = $('banner');
  const hudEl = $('hud');
  const ctrlEl = document.querySelector('.ctrl');
  const emptyEl = $('empty');
  const toastsEl = $('toasts');
  const activeBtn = $('only-active');
  const fitBtn = $('fit');
  const pctBtn = $('zoom-pct');

  let snap = null;
  let offset = 0;
  let first = true;
  let connected = false;
  let lostAt = 0;
  const index = new Map();
  const rawIndex = new Map();
  const laneEls = new Map();
  const nodeEls = new Map();
  const prevSteps = new Map();
  const prevStates = new Map();
  const expanded = new Set();
  let selected = null;
  let hoverId = null;
  let onlyActive = store(ACTIVE_KEY) === '1';
  let view = { x: MARGIN, y: MARGIN, k: 1 };
  // 'top': full size from the top-left; 'fit': everything on screen; null: where the user scrolled or zoomed to.
  let follow = store(VIEW_KEY) === 'top' ? 'top' : 'fit';
  let packW = 0;
  let packK = 0;
  let packH = Infinity;
  let worldW = 0;
  let worldH = 0;
  // On a phone the open list would cover half the board, so it starts closed there.
  let alertsOpen = store(ALERTS_KEY) === null ? innerWidth > 640 : store(ALERTS_KEY) !== '0';
  let needsSeen = -1;
  let alertsAll = false;
  let glideTimer = 0;

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  // ---------- formatting ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function flat(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function dur(ms) {
    ms = Math.max(0, ms || 0);
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  function tok(n) {
    if (!n) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
    return String(n);
  }
  function model(m) {
    if (!m) return '';
    const x = /claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
    return x ? x[1][0].toUpperCase() + x[1].slice(1) + ' ' + x[2] + '.' + x[3] : m.replace(/^claude-/, '');
  }
  function clock(t) {
    return t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  }
  function nowMs() { return Date.now() + offset; }
  function since(t, ago) { return dur(nowMs() - t) + (ago ? ' ago' : ''); }
  function timer(t, ago) { return t ? '<span class="tm" data-since="' + Number(t) + '"' + (ago ? ' data-ago' : '') + '></span>' : ''; }
  function tickIn(root) {
    for (const el of root.querySelectorAll('[data-since]')) el.textContent = since(Number(el.dataset.since), el.hasAttribute('data-ago'));
  }
  function joinMeta(parts) { return parts.filter(Boolean).map(esc).join('<i>·</i>'); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // ---------- states ----------

  const LABEL = {
    working: 'Working', 'your-turn': 'Your turn', 'needs-you': 'Needs you', error: 'Stopped', retrying: 'Retrying',
    died: 'Died', ended: 'Ended', running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed', lost: 'Lost',
    stopped: 'Stopped', stalled: 'No activity', wf: 'Running', completed: 'Done', more: '',
  };
  const ACTIVE_LINK = new Set(['working', 'running', 'wf', 'needs-you', 'retrying', 'waiting', 'stalled']);
  const BAD = new Set(['failed', 'died', 'lost', 'error']);
  const QUIET = new Set(['done', 'stopped', 'ended', 'completed', 'more']);

  function visState(n) {
    const s = rawState(n);
    return /^[\w-]+$/.test(s) ? s : 'more';
  }
  function rawState(n) {
    const x = n.data;
    switch (n.kind) {
      case 'session':
      case 'child':
        return x.state === 'working' && x.trouble && x.trouble.kind === 'stalled' ? 'stalled' : x.state;
      case 'agent':
      case 'wa':
        if (x.state === 'running' && x.trouble) return x.trouble.kind === 'permission' ? 'needs-you' : x.trouble.kind === 'retrying' ? 'retrying' : 'stalled';
        return x.state;
      case 'wf': return x.state === 'running' ? 'wf' : x.state;
      case 'shell': return x.state;
      default: return 'more';
    }
  }

  const ICON = {
    spin: '<svg class="si spin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" opacity=".22"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    alarm: '<svg class="si" viewBox="0 0 16 16" aria-hidden="true"><circle class="ring" cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="4" fill="currentColor"/></svg>',
    dot: '<svg class="si" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".3"/><circle cx="8" cy="8" r="3.6" fill="currentColor"/></svg>',
    wait: '<svg class="si slow" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="2.6 3.6" stroke-linecap="round"/></svg>',
    check: '<svg class="si" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".18"/><path d="M4.9 8.3l2.1 2.1 4.1-4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross: '<svg class="si" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".22"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    stop: '<svg class="si" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".18"/><rect x="5.5" y="5.5" width="5" height="5" rx="1" fill="currentColor"/></svg>',
    warn: '<svg class="si" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l6.2 11H1.8z" fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.4v3.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".9" fill="currentColor"/></svg>',
    ring: '<svg class="si" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    term: '<svg class="si" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.6l3.4 3.4L3 11.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.6 11.4h4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    termOn: '<svg class="si" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.6l3.4 3.4L3 11.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path class="blink" d="M8.6 11.4h4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    eye: '<svg class="si" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  };
  const STATE_ICON = {
    working: 'spin', running: 'spin', wf: 'spin', retrying: 'spin', 'needs-you': 'alarm', 'your-turn': 'dot',
    waiting: 'wait', done: 'check', completed: 'check', failed: 'cross', died: 'cross', lost: 'cross', error: 'cross',
    stopped: 'stop', stalled: 'warn', ended: 'ring',
  };
  function icon(st) { return ICON[STATE_ICON[st] || 'ring']; }
  function shellIcon(t) {
    if (t.kind === 'monitor') return ICON.eye;
    return t.state === 'running' ? ICON.termOn : ICON.term;
  }

  // ---------- tree ----------

  function mk(id, kind, data, sid, extra) {
    const n = Object.assign({ id, kind, data, sid, children: [], parent: null, kids: [] }, extra || {});
    rawIndex.set(id, n);
    return n;
  }
  function add(parent, child) {
    child.parent = parent;
    parent.children.push(child);
  }

  function attach(root, s, all, depth) {
    const sid = s.id;
    const agents = new Map();
    for (const a of s.agents) agents.set(a.id, mk('a:' + sid + ':' + a.id, 'agent', a, sid));
    for (const a of s.agents) add((a.parentId && agents.get(a.parentId)) || root, agents.get(a.id));
    const wfAgents = new Map();
    for (const w of s.workflows) {
      const wn = mk('w:' + sid + ':' + w.runId, 'wf', w, sid);
      add(root, wn);
      for (const a of w.agents) {
        const an = mk('wa:' + sid + ':' + w.runId + ':' + a.id, 'wa', a, sid, { wf: w });
        wfAgents.set('wf:' + w.runId + ':' + a.id, an);
        add(wn, an);
      }
    }
    const shells = new Map();
    for (const t of s.shells) {
      const tn = mk('t:' + sid + ':' + t.id, 'shell', t, sid);
      shells.set(t.id, tn);
      const owner = t.owner ? (t.owner.indexOf('wf:') === 0 ? wfAgents.get(t.owner) : agents.get(t.owner)) : null;
      add(owner || root, tn);
    }
    if (depth > 4) return;
    for (const c of all) {
      if (c.parentSid !== sid) continue;
      const cn = mk('s:' + c.id, 'child', c, c.id);
      add((c.parentTask && shells.get(c.parentTask)) || (c.parentOwner && agents.get(c.parentOwner)) || root, cn);
      attach(cn, c, all, depth + 1);
    }
  }

  function selfActive(n) {
    const x = n.data;
    switch (n.kind) {
      case 'session':
      case 'child': return x.alive || x.state === 'died';
      case 'agent': return x.state !== 'done' && x.state !== 'stopped';
      case 'wa': return x.state === 'running' || x.state === 'failed';
      case 'wf': return x.state !== 'done';
      case 'shell': return x.state === 'running' || x.state === 'failed' || x.state === 'died';
      default: return true;
    }
  }
  function active(n) {
    if (n.act == null) n.act = selfActive(n) || n.children.some(active);
    return n.act;
  }
  function started(n) { return n.data.startedAt || 0; }
  function ended(n) { return n.data.doneAt || n.data.lastWrite || 0; }
  const KIND_ORDER = { agent: 0, child: 0, wf: 1, wa: 0 };

  function moreNode(parent, key, hidden, label, running) {
    const open = expanded.has(key);
    return mk(key, 'more', { key, open, label: open ? 'Show fewer' : '+' + hidden + ' ' + label + (running ? ' · ' + running + ' running' : '') }, parent.sid);
  }

  function prepare(n) {
    let kids = n.children;
    if (onlyActive) kids = kids.filter(active);
    const groups = kids.filter((k) => k.kind !== 'shell');
    const shells = kids.filter((k) => k.kind === 'shell');
    const live = groups.filter(active).sort((a, b) => (KIND_ORDER[a.kind] || 0) - (KIND_ORDER[b.kind] || 0) || started(a) - started(b));
    const fin = groups.filter((k) => !active(k)).sort((a, b) => ended(b) - ended(a));
    let out = live;
    const finKey = n.id + '|fin';
    if (fin.length > MAX_DONE + 1) {
      if (expanded.has(finKey)) out = out.concat(fin, [moreNode(n, finKey, 0, '', 0)]);
      else out = out.concat(fin.slice(0, MAX_DONE), [moreNode(n, finKey, fin.length - MAX_DONE, 'finished', 0)]);
    } else out = out.concat(fin);
    const rank = { running: 0, failed: 1, died: 1 };
    shells.sort((a, b) => {
      const ra = rank[a.data.state] == null ? 2 : rank[a.data.state];
      const rb = rank[b.data.state] == null ? 2 : rank[b.data.state];
      return ra - rb || (ra === 0 ? started(a) - started(b) : ended(b) - ended(a));
    });
    const shKey = n.id + '|sh';
    if (shells.length > MAX_SHELLS + 1) {
      if (expanded.has(shKey)) out = out.concat(shells, [moreNode(n, shKey, 0, '', 0)]);
      else {
        const hidden = shells.slice(MAX_SHELLS);
        out = out.concat(shells.slice(0, MAX_SHELLS), [moreNode(n, shKey, hidden.length, 'more shells', hidden.filter((k) => k.data.state === 'running').length)]);
      }
    } else out = out.concat(shells);
    n.kids = out;
    for (const k of out) {
      k.parent = n;
      if (k.kind !== 'more') prepare(k);
    }
  }

  function gap(a, b) {
    if (a.kids.length || b.kids.length) return GAP_GROUP;
    const sa = a.kind === 'shell' || a.kind === 'more';
    const sb = b.kind === 'shell' || b.kind === 'more';
    if (sa && sb) return GAP_SHELL;
    return sa !== sb ? GAP_GROUP - 4 : GAP_Y;
  }
  function wraps(n) {
    if (n.kind === 'shell' || n.kind === 'more' || n.kind === 'wf') return false;
    const st = visState(n);
    return BAD.has(st) || st === 'retrying' || st === 'needs-you';
  }
  function measure(n) {
    n.w = W[n.kind];
    n.h = H[n.kind] + (wraps(n) ? 17 : 0);
    let t = 0;
    let kw = 0;
    n.kids.forEach((c, i) => {
      measure(c);
      if (i) t += gap(n.kids[i - 1], c);
      t += c.sub;
      kw = Math.max(kw, c.tw);
    });
    n.kidsH = t;
    n.sub = Math.max(n.h, t);
    n.tw = n.w + (kw ? GAP_X + kw : 0);
  }
  function place(n, x, top, out) {
    n.x = x;
    n.y = Math.round(top + (n.sub - n.h) / 2);
    out.push(n);
    let cy = top + (n.sub - n.kidsH) / 2;
    const cx = x + n.w + GAP_X;
    n.kids.forEach((c, i) => {
      if (i) cy += gap(n.kids[i - 1], c);
      place(c, cx, Math.round(cy), out);
      cy += c.sub;
    });
  }

  function layoutLane(s, all) {
    const root = mk('s:' + s.id, 'session', s, s.id);
    attach(root, s, all, 0);
    prepare(root);
    measure(root);
    const L = { id: s.id, s, root, nodes: [], w: 0, h: 0, x: 0, y: 0 };
    arrange(L, Infinity, Infinity);
    for (const n of L.nodes) index.set(n.id, { n, lane: L });
    return L;
  }
  // Splits the session's cards, in order, into as few columns of at most `cap` high as possible.
  function split(kids, cap) {
    const cols = [];
    let cur = null;
    let h = 0;
    kids.forEach((c, i) => {
      const add = cur ? gap(kids[i - 1], c) + c.sub : 0;
      if (!cur || h + add > cap) {
        cur = [c];
        cols.push(cur);
        h = c.sub;
      } else {
        cur.push(c);
        h += add;
      }
    });
    return cols;
  }
  // The lowest column height that fits the cards in m columns, so the columns come out even.
  function balanced(kids, m, total) {
    let lo = kids.reduce((x, c) => Math.max(x, c.sub), 0);
    let hi = Math.max(lo, total);
    while (hi - lo > 4) {
      const mid = Math.floor((lo + hi) / 2);
      if (split(kids, mid).length <= m) hi = mid; else lo = mid + 1;
    }
    return split(kids, hi);
  }
  // A session taller than maxH puts its cards into columns side by side, as many as maxW leaves room for.
  function arrange(L, maxW, maxH) {
    const root = L.root;
    const kids = root.kids;
    const nodes = [];
    for (const c of kids) c.via = null;
    let cols = null;
    const room = maxH - 2 * PAD - BUS;
    if (kids.length > 1 && root.kidsH > maxH - 2 * PAD) {
      const widthOf = (cs) => cs.reduce((w, col) => w + GAP_X + col.reduce((x, c) => Math.max(x, c.tw), 0), 2 * PAD + root.w);
      for (let m = split(kids, Math.max(room, 1)).length; m > 1; m--) {
        const cs = balanced(kids, m, root.kidsH);
        if (widthOf(cs) <= maxW) { cols = cs; break; }
      }
    }
    if (!cols) {
      place(root, PAD, PAD, nodes);
      let w = 0;
      for (const n of nodes) w = Math.max(w, n.x + n.w);
      L.nodes = nodes;
      L.w = w + PAD;
      L.h = root.sub + PAD * 2;
      return;
    }
    const top = PAD + BUS;
    root.x = PAD;
    root.y = top;
    nodes.push(root);
    let cx = PAD + root.w + GAP_X;
    let bottom = top + root.h;
    cols.forEach((col, j) => {
      let cy = top;
      let cw = 0;
      col.forEach((c, i) => {
        if (i) cy += gap(col[i - 1], c);
        place(c, cx, cy, nodes);
        cy += c.sub;
        cw = Math.max(cw, c.tw);
        if (j) c.via = { gx: cx - GAP_X / 2, bus: PAD + BUS / 2 };
      });
      bottom = Math.max(bottom, cy);
      cx += cw + GAP_X;
    });
    L.nodes = nodes;
    L.w = cx - GAP_X + PAD;
    L.h = bottom + PAD;
  }

  // ---------- packing the session panels onto the screen ----------

  function raise(sky, x0, x1, y) {
    const out = [];
    for (const s of sky) {
      const a = s.x;
      const b = s.x + s.w;
      if (b <= x0 || a >= x1) { out.push(s); continue; }
      if (a < x0) out.push({ x: a, w: x0 - a, y: s.y });
      if (b > x1) out.push({ x: x1, w: b - x1, y: s.y });
    }
    out.push({ x: x0, w: x1 - x0, y });
    out.sort((p, q) => p.x - q.x);
    const merged = [];
    for (const s of out) {
      const last = merged[merged.length - 1];
      if (last && last.y === s.y && Math.abs(last.x + last.w - s.x) < 0.5) last.w += s.w;
      else merged.push(Object.assign({}, s));
    }
    return merged;
  }
  // Each step places the panel that can sit highest, earlier (more urgent) panels first on a tie.
  // `block` is the corner the attention list covers: panels to its right start below it.
  function pack(lanes, width, block) {
    let sky = block && block.x0 > 40 && block.x0 < width && block.y1 > 0
      ? [{ x: 0, w: block.x0, y: 0 }, { x: block.x0, w: width - block.x0, y: block.y1 }]
      : [{ x: 0, w: width, y: 0 }];
    const pos = new Array(lanes.length);
    const left = lanes.map((L, i) => i);
    let maxX = 0;
    let maxY = 0;
    while (left.length) {
      let pick = null;
      for (const i of left) {
        const L = lanes[i];
        let best = null;
        for (let a = 0; a < sky.length; a++) {
          const x = sky[a].x;
          if (x + L.w > width + 0.5) break;
          let y = 0;
          for (let j = a; j < sky.length && sky[j].x < x + L.w; j++) y = Math.max(y, sky[j].y);
          if (!best || y < best.y - 0.5) best = { x, y };
        }
        if (!best) best = { x: 0, y: Math.max(...sky.map((t) => t.y)) };
        if (!pick || best.y < pick.y - 0.5) pick = { i, x: best.x, y: best.y };
      }
      const L = lanes[pick.i];
      pos[pick.i] = { x: pick.x, y: pick.y };
      left.splice(left.indexOf(pick.i), 1);
      sky = raise(sky, pick.x, Math.min(width, pick.x + L.w + LANE_GAP), pick.y + L.h + LANE_GAP);
      maxX = Math.max(maxX, pick.x + L.w);
      maxY = Math.max(maxY, pick.y + L.h);
    }
    return { pos, w: maxX, h: maxY };
  }
  // Screen space the floating banner and the bottom controls cover; the board starts and stops clear of it.
  function reserved() {
    const vh = viewport.clientHeight;
    const r = { top: 0, bottom: 0 };
    const bannerTop = bannerEl.hidden ? vh : bannerEl.getBoundingClientRect().top;
    if (bannerTop < vh / 2) r.top = bannerEl.offsetHeight + 12;
    // the counts and zoom buttons along the bottom edge (and the banner, when a phone puts it there)
    const low = Math.min(hudEl.getBoundingClientRect().top, ctrlEl.getBoundingClientRect().top, bannerTop >= vh / 2 ? bannerTop : vh);
    r.bottom = Math.max(0, vh - low + 8 - MARGIN);
    return r;
  }
  // The attention list's corner at scale k, placed with the panel closed so opening one never re-packs.
  function alertsBlock(res, k) {
    if (alertsEl.hidden || viewport.clientWidth <= 900 || alertsEl.parentNode !== document.body) return null;
    const left = viewport.clientWidth - 16 - alertsEl.offsetWidth;
    const bottom = 14 + alertsEl.offsetHeight;
    return { x0: (left - 16 - MARGIN) / k, y1: (bottom + 16 - res.top - MARGIN) / k };
  }
  function placeLanes(lanes) {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const res = reserved();
    const fullW = Math.max(320, vw - 2 * MARGIN);
    const availH = Math.max(240, vh - 2 * MARGIN - res.top - res.bottom);
    // lanes get the screen's shape at scale k, so a tall session spreads into the width a wide screen has spare
    const at = (k, maxW, maxH) => {
      for (const L of lanes) arrange(L, maxW, maxH);
      const width = Math.max(lanes.reduce((m, L) => Math.max(m, L.w), 0), maxW);
      const r = pack(lanes, width, alertsBlock(res, k));
      return { r, k, maxW, maxH, fits: r.w * k <= fullW + 0.5 && r.h * k <= availH + 0.5 };
    };
    let best = null;
    if (follow === 'fit') {
      // the biggest scale at which everything fits; the corner left for the list is exact only at that scale
      const atK = (k) => at(k, fullW / k, availH / k);
      for (const k of [FIT_MAX, 1.35, 1.2, 1.1, 1, 0.92, 0.85, 0.78, 0.72, 0.66, 0.6, 0.55]) {
        const t = atK(k);
        if (t.fits) { best = t; break; }
      }
      if (!best) best = atK(MIN_FIT);
      // a small change does not step the scale up and reshuffle the board
      if (packK && packK < best.k && best.k <= packK * 1.16) {
        const t = atK(packK);
        if (t.fits) best = t;
        else best = atK(best.k);
      }
    } else if (follow === 'top' || !packW) {
      best = at(1, fullW, availH);
    } else {
      // a zoom or scroll of the user's keeps the arrangement it was made on
      best = at(packK || 1, packW, packH);
    }
    packW = best.maxW;
    packK = best.k;
    packH = best.maxH;
    best.r.pos.forEach((p, i) => { lanes[i].x = Math.round(p.x); lanes[i].y = Math.round(p.y); });
    worldW = best.r.w;
    worldH = best.r.h;
  }

  // ---------- view: pan, zoom, fit ----------

  function applyView(animate) {
    world.classList.toggle('glide', !!animate);
    world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
    clearTimeout(glideTimer);
    if (animate) glideTimer = setTimeout(() => world.classList.remove('glide'), 650);
    renderBars(animate);
    pctBtn.textContent = Math.round(view.k * 100) + '%';
    if (window.OVLive) window.OVLive.onView();
  }

  // ---------- scrollbars ----------

  const bars = { x: makeBar('x'), y: makeBar('y') };
  function makeBar(dir) {
    const track = document.createElement('div');
    track.className = 'sb sb-' + dir;
    track.hidden = true;
    const thumb = document.createElement('div');
    thumb.className = 'sb-thumb';
    track.appendChild(thumb);
    document.body.appendChild(track);
    let grab = null;
    thumb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      grab = { at: dir === 'x' ? e.clientX : e.clientY, pos: dir === 'x' ? view.x : view.y, id: e.pointerId };
      thumb.setPointerCapture(e.pointerId);
      track.classList.add('on');
    });
    thumb.addEventListener('pointermove', (e) => {
      if (!grab || e.pointerId !== grab.id) return;
      const g = geometry(dir);
      const moveBy = ((dir === 'x' ? e.clientX : e.clientY) - grab.at) / Math.max(1, g.track - g.thumb) * g.range;
      if (dir === 'x') view.x = grab.pos - moveBy; else view.y = grab.pos - moveBy;
      clampView();
      applyView(false);
      moved();
    });
    const release = () => { grab = null; track.classList.remove('on'); };
    thumb.addEventListener('pointerup', release);
    thumb.addEventListener('pointercancel', release);
    track.addEventListener('pointerdown', (e) => {
      if (e.target !== track) return;
      const r = thumb.getBoundingClientRect();
      const before = dir === 'x' ? e.clientX < r.left : e.clientY < r.top;
      const u = usable();
      const page = (dir === 'x' ? u.w : u.h) * 0.85 * (before ? 1 : -1);
      if (dir === 'x') view.x += page; else view.y += page;
      clampView();
      applyView(true);
      moved();
    });
    return { track, thumb };
  }
  function geometry(dir) {
    const u = usable();
    const size = dir === 'x' ? u.w : u.h;
    const content = (dir === 'x' ? worldW : worldH) * view.k + 2 * MARGIN;
    const pos = dir === 'x' ? view.x - u.left : view.y - u.top;
    const trackLen = Math.max(40, size - (dir === 'x' ? 32 : 70));
    const thumb = Math.max(36, trackLen * Math.min(1, size / content));
    const range = Math.max(1, content - size);
    const done = Math.min(1, Math.max(0, (MARGIN - pos) / range));
    return { show: content > size + 1, track: trackLen, thumb, range, offset: done * (trackLen - thumb) };
  }
  function renderBars(animate) {
    for (const dir of ['x', 'y']) {
      const g = geometry(dir);
      const b = bars[dir];
      b.track.hidden = !g.show || !worldW;
      if (b.track.hidden) continue;
      const edge = viewport.clientWidth - panelWidth();
      b.thumb.classList.toggle('glide', !!animate);
      if (dir === 'x') {
        const len = Math.max(40, edge - 32);
        b.track.style.left = '16px';
        b.track.style.width = len + 'px';
        b.thumb.style.width = Math.max(36, len * g.thumb / g.track) + 'px';
        b.thumb.style.transform = 'translateX(' + (g.offset / Math.max(1, g.track - g.thumb) * (len - Math.max(36, len * g.thumb / g.track))) + 'px)';
      } else {
        const al = !alertsEl.hidden && viewport.clientWidth > 640 && alertsEl.parentNode === document.body ? alertsEl.getBoundingClientRect() : null;
        const top = Math.max(16, al && al.right > edge - 40 ? al.bottom + 12 : 16, reserved().top + 16);
        const len = Math.max(40, viewport.clientHeight - 60 - top);
        const th = Math.max(36, len * g.thumb / g.track);
        b.track.style.top = top + 'px';
        b.track.style.left = (edge - 10) + 'px';
        b.track.style.height = len + 'px';
        b.thumb.style.height = th + 'px';
        b.thumb.style.transform = 'translateY(' + (g.offset / Math.max(1, g.track - g.thumb) * (len - th)) + 'px)';
      }
    }
  }
  // Centred whether or not a panel is open, so opening one never moves the board.
  // A floating attention list keeps the board at the left, clear of the list's corner.
  function fit(animate) {
    if (!worldW) return;
    const res = reserved();
    const k = packK || 1;
    const floating = !alertsEl.hidden && alertsEl.parentNode === document.body;
    const fx = floating ? 0 : Math.max(0, (viewport.clientWidth - 2 * MARGIN - worldW * k) / 2);
    const fy = Math.max(0, (viewport.clientHeight - res.top - res.bottom - 2 * MARGIN - worldH * k) / 2);
    view = { x: MARGIN + fx, y: res.top + MARGIN + fy, k };
    applyView(animate);
  }
  function toTop(animate) {
    view = { x: MARGIN, y: reserved().top + MARGIN, k: 1 };
    clampView();
    applyView(animate);
  }
  function panelWidth() {
    if (!selected) return 0;
    return Math.max(0, panel.offsetWidth - (innerWidth - viewport.getBoundingClientRect().right));
  }
  // The visible part of the screen, without what the banner, the bottom controls or the open panel cover.
  function usable() {
    const res = reserved();
    const w = Math.max(160, viewport.clientWidth - panelWidth());
    return { left: 0, top: res.top, w, h: Math.max(160, viewport.clientHeight - res.top - res.bottom) };
  }
  function scrollable(dir) {
    const u = usable();
    return dir === 'x' ? worldW * view.k + 2 * MARGIN > u.w : worldH * view.k + 2 * MARGIN > u.h;
  }
  // Pan limit: a small board stays wholly in view, a big one keeps its edges in reach.
  function axis(pos, start, size, content) {
    const a = start + MARGIN;
    const b = start + size - MARGIN - content;
    return Math.min(Math.max(a, b), Math.max(Math.min(a, b), pos));
  }
  function clampView() {
    const u = usable();
    view.x = axis(view.x, u.left, u.w, worldW * view.k);
    view.y = axis(view.y, u.top, u.h, worldH * view.k);
  }
  // Zooming out stops once everything is on screen.
  function minZoom() {
    const u = usable();
    if (!worldW) return MIN_ZOOM;
    return Math.max(MIN_ZOOM, Math.min(view.k, (u.w - 2 * MARGIN) / worldW, (u.h - 2 * MARGIN) / worldH));
  }
  function zoomAt(px, py, k) {
    k = Math.max(minZoom(), Math.min(MAX_ZOOM, k));
    view.x = px - (px - view.x) * (k / view.k);
    view.y = py - (py - view.y) * (k / view.k);
    view.k = k;
    clampView();
  }
  function setFollow(mode) {
    follow = mode;
    if (mode) store(VIEW_KEY, mode);
    fitBtn.setAttribute('aria-pressed', mode === 'fit' ? 'true' : 'false');
    fitBtn.title = mode === 'fit' ? 'Back to full size (F)' : 'Show everything on one screen (F)';
  }
  function moved() {
    if (follow) setFollow(null);
  }
  function showAll() {
    setFollow('fit');
    packW = 0;
    render();
  }
  function fullSize() {
    setFollow('top');
    packW = 0;
    render();
  }
  function toggleFit() {
    if (follow === 'fit') fullSize(); else showAll();
  }

  function onWheel(e) {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    const before = view.x + ',' + view.y + ',' + view.k;
    // a trackpad pinch arrives as a wheel event with ctrlKey set, so it zooms like Ctrl + wheel
    if (e.ctrlKey || e.metaKey) {
      if (e.deltaY) zoomAt(e.clientX - r.left, e.clientY - r.top, view.k * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0022)));
    } else {
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientHeight * 0.85 : 1;
      view.x -= dx * unit;
      view.y -= dy * unit;
      clampView();
    }
    if (view.x + ',' + view.y + ',' + view.k === before) return;
    applyView(false);
    moved();
  }
  viewport.addEventListener('wheel', onWheel, { passive: false });
  bars.x.track.addEventListener('wheel', onWheel, { passive: false });
  bars.y.track.addEventListener('wheel', onWheel, { passive: false });

  let drag = null;
  let suppressClick = false;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, on: false, id: e.pointerId };
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.on) {
      if (Math.hypot(dx, dy) < 5) return;
      drag.on = true;
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add('dragging');
    }
    const before = view.x + ',' + view.y;
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    clampView();
    if (view.x + ',' + view.y === before) return;
    applyView(false);
    moved();
  });
  function endDrag() {
    if (drag && drag.on) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    drag = null;
    viewport.classList.remove('dragging');
  }
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
  viewport.addEventListener('dblclick', (e) => { if (!e.target.closest('.node')) toggleFit(); });

  fitBtn.addEventListener('click', toggleFit);
  pctBtn.addEventListener('click', fullSize);
  function zoomBy(f) {
    const u = usable();
    zoomAt(u.left + u.w / 2, u.top + u.h / 2, view.k * f);
    applyView(true);
    moved();
  }
  $('zoom-in').addEventListener('click', () => zoomBy(1.2));
  // a Mac keyboard names the key Command, not Ctrl; the board takes either
  if (/Mac|iPhone|iPad/.test(navigator.platform)) for (const id of ['zoom-in', 'zoom-out']) $(id).title = $(id).title.replace(/Ctrl/g, '⌘');
  $('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));

  function setOnlyActive(on) {
    onlyActive = on;
    activeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    store(ACTIVE_KEY, on ? '1' : '0');
  }
  activeBtn.addEventListener('click', () => {
    setOnlyActive(!onlyActive);
    packW = 0;
    render();
  });
  setOnlyActive(onlyActive);
  setFollow(follow);

  // ---------- card markup ----------

  function sessionAct(s) {
    switch (s.state) {
      case 'working':
        if (s.trouble && s.trouble.kind === 'stalled') return { tx: 'No activity', t: s.trouble.since };
        return s.act ? { tx: s.act.label, t: s.act.since } : { tx: 'Working' };
      case 'needs-you': return { tx: s.act ? s.act.label : 'Waiting for you', t: s.act && s.act.since };
      case 'retrying': return { tx: s.trouble ? s.trouble.text : 'Retrying', t: s.trouble && s.trouble.since };
      case 'error':
      case 'died':
      case 'ended': return { tx: plainError(s.reason), t: s.since, ago: true };
      default:
        if (s.reason) return { tx: s.reason, t: s.since, ago: true };
        return { k: s.said ? 'Replied' : '', tx: s.said ? s.said.text : 'Waiting for your next message', t: s.since, ago: true };
    }
  }
  function agentAct(a) {
    if (a.state === 'running') {
      if (a.trouble) return { tx: a.trouble.kind === 'stalled' ? 'No activity' : a.trouble.text, t: a.trouble.since };
      return a.now ? { tx: a.now.label, t: a.now.since } : { tx: 'Starting' };
    }
    if (a.state === 'waiting') return { tx: 'Waiting on ' + (a.shells === 1 ? 'its background command' : a.shells + ' background commands') };
    if (a.state === 'done') return { k: a.said ? 'Said' : '', tx: a.said || 'Finished', t: a.doneAt, ago: true };
    return { tx: plainError(a.reason) || LABEL[a.state], t: a.doneAt, ago: true };
  }
  function plainError(t) { return String(t || '').replace(/^API Error:\s*/i, ''); }
  function actLine(a, wrap) {
    return '<div class="act' + (wrap ? ' wrap' : '') + '">' + (a.k ? '<span class="tx"><span class="k">' + esc(a.k) + '</span> ' : '<span class="tx">') + esc(flat(a.tx)) + '</span>' + timer(a.t, a.ago) + '</div>';
  }
  function chip(st) { return '<span class="chip">' + esc(LABEL[st] || st) + '</span>'; }
  function runningCounts(s) {
    const a = s.agents.filter((x) => x.state === 'running').length + s.workflows.reduce((m, w) => m + w.running, 0);
    const t = s.shells.filter((x) => x.state === 'running').length;
    const parts = [];
    if (a) parts.push(plural(a, 'agent', 'agents'));
    if (t) parts.push(plural(t, 'shell', 'shells'));
    return parts.join(' · ');
  }
  function spanOf(a) {
    if (!a.startedAt) return '';
    if (a.state === 'running' || a.state === 'waiting' || a.state === 'wf') return timer(a.startedAt);
    return a.doneAt ? '<span class="tm">' + dur(a.doneAt - a.startedAt) + '</span>' : '';
  }

  function nodeHtml(n, st) {
    const x = n.data;
    switch (n.kind) {
      case 'session': {
        const prs = (x.prs || []).map((p) => '#' + p.n).join(' ');
        return '<div class="card session" title="' + esc(x.name + (x.topic ? ' — ' + x.topic : '')) + '">' +
          '<div class="hd">' + icon(st) + '<span class="ttl">' + esc(x.name) + '</span>' + chip(st) + '</div>' +
          actLine(sessionAct(x), wraps(n)) +
          '<div class="line"><span class="k">Asked</span>' + esc(flat(x.prompt) || '—') + '</div>' +
          '<div class="meta">' + joinMeta([x.branch, prs, model(x.model), x.ctx ? tok(x.ctx) + ' context' : '', x.alive ? '' : 'pid ' + x.pid]) + '</div>' +
          '<div class="foot"><div class="spark"></div><span class="cnt">' + esc(runningCounts(x)) + '</span></div></div>';
      }
      case 'child':
        return '<div class="card child" title="' + esc(x.name) + '">' +
          '<div class="hd">' + icon(st) + '<span class="ttl">' + esc(x.name) + '</span><span class="badge">session</span></div>' +
          actLine(sessionAct(x), wraps(n)) +
          '<div class="meta">' + joinMeta([model(x.model), x.ctx ? tok(x.ctx) + ' context' : '', x.cwd]) + '</div></div>';
      case 'agent':
        return '<div class="card agent" title="' + esc(x.desc) + '">' +
          '<div class="hd">' + icon(st) + '<span class="ttl">' + esc(x.desc) + '</span><span class="rt">' + spanOf(x) + '</span></div>' +
          actLine(agentAct(x), wraps(n)) +
          '<div class="meta">' + joinMeta([x.type === 'general-purpose' ? '' : x.type, model(x.model), x.ctx ? tok(x.ctx) + ' context' : '', x.shells ? plural(x.shells, 'shell running', 'shells running') : '']) + '</div></div>';
      case 'wf': {
        const pct = x.total ? Math.round((x.done / x.total) * 100) : 0;
        const act = x.state === 'running' ? { tx: (x.phase ? x.phase + ' · ' : '') + x.running + ' running' } : x.reason ? { tx: x.reason, t: x.doneAt, ago: true } : { tx: 'Finished', t: x.doneAt, ago: true };
        return '<div class="card wf" title="' + esc(x.name) + '">' +
          '<div class="hd">' + icon(st) + '<span class="ttl">' + esc(x.name) + '</span><span class="rt">' + Number(x.done) + '/' + Number(x.total) + '</span></div>' +
          '<div class="bar"><b style="width:' + pct + '%"></b></div>' + actLine(act) +
          '<div class="meta">' + joinMeta(['workflow', x.durationMs ? dur(x.durationMs) : '', x.tokens ? tok(x.tokens) + ' tokens' : '']) + '</div></div>';
      }
      case 'wa': {
        const act = x.state === 'running' && x.now ? { tx: x.now.label, t: x.now.since } : { tx: x.reason || LABEL[x.state] || x.state };
        return '<div class="card wa" title="' + esc(x.label) + '">' +
          '<div class="hd">' + icon(st) + '<span class="ttl">' + esc(x.label) + '</span><span class="rt">' + (x.state === 'running' ? timer(x.startedAt) : '') + '</span></div>' +
          actLine(act, wraps(n)) + '</div>';
      }
      case 'shell': {
        const word = x.state === 'failed' ? 'exit ' + (x.exit != null ? x.exit : '?') : x.state === 'died' ? 'killed' : x.state;
        const right = x.state === 'running' ? timer(x.startedAt) : '<span class="tm">' + esc(word) + '</span>';
        return '<div class="shell" title="' + esc(x.desc) + '">' + shellIcon(x) + '<span class="tx">' + esc(x.desc) + '</span>' + right + '</div>';
      }
      default:
        return '<div class="more">' + esc(x.label) + '</div>';
    }
  }

  function sparkHtml(act) {
    const max = Math.max(1, ...act);
    const quiet = act.every((v) => !v);
    return { quiet, html: act.map((v) => '<b style="height:' + Math.max(8, Math.round((v / max) * 100)) + '%"></b>').join('') };
  }

  // ---------- rendering ----------

  function setState(el, st) {
    if (el.st === st) return;
    if (el.st) el.classList.remove('c-' + el.st);
    el.classList.add('c-' + st);
    el.st = st;
  }
  function anchorOut(n) { return [n.x + n.w, n.y + n.h / 2]; }
  function anchorIn(n) { return [n.x, n.y + n.h / 2]; }
  function ctrlPts(a, b) {
    const dx = Math.max(18, (b[0] - a[0]) * 0.5);
    return [a, [a[0] + dx, a[1]], [b[0] - dx, b[1]], b];
  }
  function curve(a, b) {
    const p = ctrlPts(a, b);
    return 'M' + p[0][0] + ',' + p[0][1] + 'C' + p[1][0] + ',' + p[1][1] + ' ' + p[2][0] + ',' + p[2][1] + ' ' + p[3][0] + ',' + p[3][1];
  }
  // A card in a session's second or later column is reached over the top of the columns before it.
  function route(p, c) {
    if (!c.via) return null;
    const rx = p.x + p.w;
    const ry = p.y + 18;
    const cy = c.y + c.h / 2;
    return [[rx, ry], [rx + 16, ry], [rx + 16, c.via.bus], [c.via.gx, c.via.bus], [c.via.gx, cy], [c.x, cy]];
  }
  function elbow(pts) {
    let d = 'M' + pts[0][0] + ',' + pts[0][1];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
      const r = Math.min(8, l1 / 2, l2 / 2);
      d += 'L' + (b[0] - (b[0] - a[0]) / l1 * r) + ',' + (b[1] - (b[1] - a[1]) / l1 * r)
        + 'Q' + b[0] + ',' + b[1] + ' ' + (b[0] + (c[0] - b[0]) / l2 * r) + ',' + (b[1] + (c[1] - b[1]) / l2 * r);
    }
    const e = pts[pts.length - 1];
    return d + 'L' + e[0] + ',' + e[1];
  }
  function along(pts) {
    const len = [0];
    for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = len[len.length - 1] || 1;
    return (t) => {
      const want = t * total;
      let i = 1;
      while (i < pts.length - 1 && len[i] < want) i++;
      const f = (want - len[i - 1]) / ((len[i] - len[i - 1]) || 1);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
    };
  }
  function linkClass(c) {
    const st = visState(c);
    return 'ln c-' + st + (BAD.has(st) ? ' bad' : ACTIVE_LINK.has(st) ? ' on' : QUIET.has(st) ? ' quiet' : '');
  }

  function updateNode(el, n) {
    const st = visState(n);
    setState(el, st);
    el.classList.toggle('sel', selected === n.id);
    el.style.width = n.w + 'px';
    el.style.height = n.h + 'px';
    el.style.transform = 'translate(' + n.x + 'px,' + n.y + 'px)';
    const html = nodeHtml(n, st);
    if (el.html !== html) {
      el.innerHTML = html;
      el.html = html;
      el.spark = null;
      tickIn(el);
      const phase = -(performance.now() % 1000) + 'ms';
      for (const s of el.querySelectorAll('.spin')) s.style.animationDelay = phase;
    }
    if (n.kind === 'session') {
      const sp = sparkHtml(n.data.activity || []);
      const key = sp.quiet + sp.html;
      if (el.spark !== key) {
        const box = el.querySelector('.spark');
        if (box) { box.innerHTML = sp.html; box.classList.toggle('quiet', sp.quiet); }
        el.spark = key;
      }
    }
    el.d = n;
    el.setAttribute('aria-label', (n.kind === 'more' ? n.data.label : (n.data.name || n.data.desc || n.data.label || '') + ', ' + (LABEL[st] || st)));
  }

  function renderLane(el, L) {
    setState(el, visState(L.root));
    el.style.transform = 'translate(' + L.x + 'px,' + L.y + 'px)';
    el.style.width = L.w + 'px';
    el.style.height = L.h + 'px';
    const canvas = el.firstChild;
    const svg = canvas.firstChild;
    svg.setAttribute('width', L.w);
    svg.setAttribute('height', L.h);

    const sel = d3.select(canvas).selectAll('div.node:not(.leaving)').data(L.nodes, (d) => d.id);
    sel.exit().classed('leaving', true).each(function () {
      const gone = this;
      nodeEls.delete(gone.d && gone.d.id);
      setTimeout(() => gone.remove(), 450);
    });
    const fresh = [];
    sel.enter().append('div').attr('class', 'node new').attr('tabindex', 0).attr('role', 'button').each(function (n) {
      const p = n.parent;
      if (!first && p) this.style.transform = 'translate(' + (p.x + p.w * 0.4) + 'px,' + (p.y + p.h / 2 - H[n.kind] / 2) + 'px) scale(.9)';
      fresh.push(this);
    });
    if (fresh.length && !first) void canvas.offsetWidth;
    d3.select(canvas).selectAll('div.node:not(.leaving)').each(function (n) {
      updateNode(this, n);
      nodeEls.set(n.id, this);
    });
    for (const f of fresh) f.classList.remove('new');

    const links = L.nodes.filter((n) => n.parent).map((n) => ({ id: n.id, p: n.parent, c: n }));
    const g = d3.select(svg).select('g.lns');
    const ls = g.selectAll('path.ln:not(.gone)').data(links, (d) => d.id);
    ls.exit().classed('gone', true).interrupt().transition().duration(250).style('opacity', 0).remove();
    const le = ls.enter().append('path').each(function (d) {
      const pts = route(d.p, d.c);
      const a = anchorOut(d.p);
      this.rk = pts ? 'e' : 'c';
      this.setAttribute('d', pts ? elbow(pts) : curve(a, [a[0] + 1, a[1]]));
    });
    le.merge(ls)
      .attr('class', (d) => linkClass(d.c))
      .each(function (d) {
        const pts = route(d.p, d.c);
        const kind = pts ? 'e' : 'c';
        const to = pts ? elbow(pts) : curve(anchorOut(d.p), anchorIn(d.c));
        // a curve and an elbow do not morph into each other
        if (this.rk !== kind) d3.select(this).interrupt().attr('d', to);
        else d3.select(this).transition().duration(first ? 0 : 550).ease(d3.easeCubicOut).attr('d', to);
        this.rk = kind;
      });
  }

  function render() {
    if (!snap) return;
    const all = snap.sessions || [];
    const byId = new Map(all.map((s) => [s.id, s]));
    const top = all.filter((s) => !(s.parentSid && byId.has(s.parentSid)));
    top.sort((a, b) => (b.alive - a.alive) || (a.startedAt || 0) - (b.startedAt || 0) || (a.id < b.id ? -1 : 1));
    index.clear();
    rawIndex.clear();
    renderAlerts();
    renderBanner();
    const lanes = top.map((s) => layoutLane(s, all));
    placeLanes(lanes);
    emptyEl.hidden = lanes.length > 0;

    const sel = d3.select(world).selectAll('section.lane:not(.leaving)').data(lanes, (d) => d.id);
    sel.exit().classed('leaving', true).each(function (L) {
      const gone = this;
      laneEls.delete(L.id);
      setTimeout(() => gone.remove(), 400);
    });
    sel.enter().append('section').attr('class', 'lane').each(function (L) {
      this.innerHTML = '<div class="canvas"><svg class="links" aria-hidden="true"><g class="lns"></g><g class="pulses"></g></svg></div>';
      this.style.transform = 'translate(' + L.x + 'px,' + L.y + 'px)';
      if (!first) {
        this.classList.add('entering');
        setTimeout(() => this.classList.remove('entering'), 950);
      }
    });
    d3.select(world).selectAll('section.lane:not(.leaving)').each(function (L) {
      laneEls.set(L.id, this);
      renderLane(this, L);
    });
    world.style.width = worldW + 'px';
    world.style.height = worldH + 'px';

    if (!first) firePulses();
    else for (const [id, e] of index) if (e.n.data && e.n.data.steps != null) prevSteps.set(id, e.n.data.steps);
    noticeChanges(all);
    applyHover();
    renderHud();
    if (selected) renderPanel();
    if (window.OVLive) window.OVLive.onSnap(snap);
    if (follow === 'fit') fit(!first);
    else if (follow === 'top') toTop(!first);
    else {
      const before = view.x + ',' + view.y;
      clampView();
      if (view.x + ',' + view.y !== before) applyView(false);
      else renderBars(false);
    }
    first = false;
  }

  // ---------- motion ----------

  function bez(P, t) {
    const u = 1 - t;
    return [
      u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
      u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
    ];
  }
  function pulse(L, p, c, delay) {
    const laneEl = laneEls.get(L.id);
    if (!laneEl) return;
    const g = laneEl.querySelector('g.pulses');
    const pts = route(p, c);
    const P = ctrlPts(anchorOut(p), anchorIn(c));
    const pos = pts ? along(pts) : (t) => bez(P, t);
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('r', '3.2');
    dot.setAttribute('class', 'pulse c-' + visState(c));
    dot.style.opacity = '0';
    g.appendChild(dot);
    const t0 = performance.now() + delay;
    const id = c.id;
    function step(t) {
      const k = (t - t0) / PULSE_MS;
      if (k < 0) { requestAnimationFrame(step); return; }
      if (k >= 1 || !dot.isConnected) { dot.remove(); hit(id); return; }
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const xy = pos(e);
      dot.setAttribute('cx', xy[0]);
      dot.setAttribute('cy', xy[1]);
      dot.style.opacity = String(k < 0.12 ? k / 0.12 : k > 0.85 ? (1 - k) / 0.15 : 1);
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function hit(id) {
    const el = nodeEls.get(id);
    const si = el && el.querySelector('.si');
    if (!si) return;
    si.classList.remove('hit');
    void si.getBoundingClientRect();
    si.classList.add('hit');
    setTimeout(() => si.classList.remove('hit'), 500);
  }
  function beat(id) {
    const el = nodeEls.get(id);
    const card = el && el.firstChild;
    if (!card) return;
    card.classList.remove('beat');
    void card.offsetWidth;
    card.classList.add('beat');
    setTimeout(() => card.classList.remove('beat'), 750);
  }
  function firePulses() {
    if (document.hidden) {
      for (const [id, e] of index) if (e.n.data && e.n.data.steps != null) prevSteps.set(id, e.n.data.steps);
      return;
    }
    for (const [id, e] of index) {
      const n = e.n;
      const steps = n.data && n.data.steps;
      if (steps == null || n.kind === 'more') continue;
      const prev = prevSteps.get(id);
      prevSteps.set(id, steps);
      if (prev == null || steps <= prev) continue;
      const count = Math.min(3, steps - prev);
      for (let i = 0; i < count; i++) {
        if (n.parent) pulse(e.lane, n.parent, n, i * 200);
        else setTimeout(() => beat(id), i * 250);
      }
    }
  }

  function noticeChanges(all) {
    for (const s of all) {
      const prev = prevStates.get(s.id);
      if (!first) {
        if (prev == null && s.alive) toast('New session: <b>' + esc(s.name) + '</b>', 's:' + s.id, false);
        else if (prev && prev !== 'died' && s.state === 'died') toast('Session died: <b>' + esc(s.name) + '</b>', 's:' + s.id, true);
      }
      prevStates.set(s.id, s.state);
    }
    for (const id of prevStates.keys()) if (!all.some((s) => s.id === id)) prevStates.delete(id);
  }

  function toast(html, node, bad) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.innerHTML = html;
    el.addEventListener('click', () => { openPanel(node); focusNode(node); el.remove(); });
    toastsEl.appendChild(el);
    setTimeout(() => el.remove(), 8000);
    while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
  }

  // ---------- hover, click, focus ----------

  function chainOf(n) {
    const ids = new Set([n.id]);
    for (let p = n.parent; p; p = p.parent) ids.add(p.id);
    (function down(x) { for (const k of x.kids) { ids.add(k.id); down(k); } })(n);
    return ids;
  }
  function applyHover() {
    for (const el of world.querySelectorAll('.lane.hovering')) el.classList.remove('hovering');
    for (const el of world.querySelectorAll('.lit')) el.classList.remove('lit');
    if (!hoverId || (drag && drag.on)) return;
    const e = index.get(hoverId);
    if (!e) return;
    const laneEl = laneEls.get(e.lane.id);
    if (!laneEl || e.lane.nodes.length < 2) return;
    const ids = chainOf(e.n);
    laneEl.classList.add('hovering');
    for (const el of laneEl.querySelectorAll('.node')) if (el.d && ids.has(el.d.id)) el.classList.add('lit');
    for (const p of laneEl.querySelectorAll('path.ln')) {
      const d = p.__data__;
      if (d && ids.has(d.c.id) && ids.has(d.p.id)) p.classList.add('lit');
    }
  }
  viewport.addEventListener('pointerover', (e) => {
    const el = e.target.closest && e.target.closest('.node');
    const id = el && el.d ? el.d.id : null;
    if (id !== hoverId) {
      hoverId = id;
      applyHover();
      if (window.OVLive) window.OVLive.hoverNode(id);
    }
  });
  viewport.addEventListener('pointerleave', () => {
    hoverId = null;
    applyHover();
    if (window.OVLive) window.OVLive.hoverNode(null);
  });

  function activate(el) {
    const n = el && el.d;
    if (!n) return;
    if (n.kind === 'more') {
      if (expanded.has(n.data.key)) expanded.delete(n.data.key);
      else expanded.add(n.data.key);
      render();
      return;
    }
    if (selected === n.id) closePanel();
    else openPanel(n.id);
  }
  viewport.addEventListener('click', (e) => {
    if (suppressClick) return;
    activate(e.target.closest('.node'));
  });
  viewport.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('node')) {
      e.preventDefault();
      activate(e.target);
    }
  });

  function reveal(id) {
    const r = rawIndex.get(id);
    if (!r) return;
    if (onlyActive && !active(r)) setOnlyActive(false);
    for (let p = r.parent; p; p = p.parent) {
      expanded.add(p.id + '|sh');
      expanded.add(p.id + '|fin');
    }
    render();
  }
  function focusNode(id) {
    if (!index.has(id)) reveal(id);
    const e = index.get(id);
    if (!e) return;
    const n = e.n;
    const L = e.lane;
    const k = Math.max(view.k, 0.9);
    const u = usable();
    view = { k, x: Math.round(u.left + u.w / 2 - (L.x + n.x + n.w / 2) * k), y: Math.round(u.top + u.h / 2 - (L.y + n.y + n.h / 2) * k) };
    clampView();
    applyView(true);
    moved();
    const el = nodeEls.get(id);
    if (el) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1700);
    }
  }

  document.addEventListener('keydown', (e) => {
    // Ctrl+- and Ctrl+= zoom the board instead of the page; Ctrl+0 is left to the browser to reset its own zoom.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ['-', '_', '=', '+'].includes(e.key)) {
      e.preventDefault();
      zoomBy(e.key === '-' || e.key === '_' ? 1 / 1.2 : 1.2);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { if (selected) closePanel(); return; }
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const step = e.shiftKey ? 240 : 80;
    const page = usable().h * 0.85;
    const pan = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [step, 0], ArrowRight: [-step, 0], PageUp: [0, page], PageDown: [0, -page], Home: [0, 1e7], End: [0, -1e7] }[e.key];
    if (pan && !(e.target && e.target.closest && e.target.closest('.panel, .alerts'))) {
      e.preventDefault();
      const before = view.x + ',' + view.y;
      view.x += pan[0];
      view.y += pan[1];
      clampView();
      if (view.x + ',' + view.y !== before) { applyView(true); moved(); }
      return;
    }
    if (e.key === 'f' || e.key === 'F') toggleFit();
    else if (e.key === '0') fullSize();
    else if (e.key === '+' || e.key === '=') zoomBy(1.2);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.2);
  });

  // ---------- detail panel ----------

  const KIND = { session: 'Session', child: 'Session started by a command', agent: 'Agent', wf: 'Workflow', wa: 'Workflow agent', shell: 'Background command' };

  function sec(title, body) { return body ? '<section class="p-sec"><h3>' + esc(title) + '</h3>' + body + '</section>' : ''; }
  function grid(rows) {
    const r = rows.filter((x) => x && x[1]);
    return r.length ? '<dl class="p-grid">' + r.map((x) => '<dt>' + esc(x[0]) + '</dt><dd>' + x[1] + '</dd>').join('') + '</dl>' : '';
  }
  function steps(list) {
    if (!list || !list.length) return '';
    return '<ul class="p-list">' + list.map((r) => '<li><span class="t" data-since="' + Number(r.at) + '" data-ago></span><span>' + esc(r.label) + '</span></li>').join('') + '</ul>';
  }
  function nameOf(n) {
    const x = n.data;
    return n.kind === 'session' || n.kind === 'child' ? x.name : n.kind === 'wf' || n.kind === 'wa' ? x.name || x.label : x.desc || x.label;
  }
  function kidsList(n) {
    if (!n.children.length) return '';
    return '<ul class="p-list p-kids">' + n.children.map((k) => {
      const st = visState(k);
      return '<li class="c-' + st + '" data-focus="' + esc(k.id) + '">' + icon(st) + '<span>' + esc(nameOf(k)) + '</span><span class="s">' + esc(LABEL[st] || st) + '</span></li>';
    }).join('') + '</ul>';
  }
  function nowBlock(a) { return a && a.tx ? '<div class="p-now"><span>' + esc(flat(a.tx)) + '</span>' + timer(a.t, a.ago) + '</div>' : ''; }
  function link(n) { return n ? '<a class="p-link" data-focus="' + esc(n.id) + '">' + esc(nameOf(n)) + '</a>' : ''; }
  function when(t) { return t ? esc(clock(t)) + ' · <span data-since="' + Number(t) + '" data-ago></span>' : ''; }

  function panelHtml(n) {
    const x = n.data;
    const st = visState(n);
    let h = '<div class="p-top"><span class="p-kind">' + esc(KIND[n.kind] || '') + '</span><button type="button" class="p-x" data-close aria-label="Close">×</button></div>';
    h += '<h2 class="p-title">' + esc(nameOf(n)) + '</h2>';
    h += '<div class="p-state c-' + st + '">' + icon(st) + chip(st) + '</div>';
    const problem = x.reason && (BAD.has(st) || st === 'stopped' || st === 'ended') ? x.reason : x.trouble && x.trouble.kind !== 'stalled' ? x.trouble.text : null;
    if (problem) h += '<div class="p-reason c-' + st + '">' + esc(problem) + '</div>';
    switch (n.kind) {
      case 'session':
      case 'child': {
        if (!problem) h += sec('Now', nowBlock(sessionAct(x)));
        h += sec('Asked', x.prompt ? '<div class="p-text">' + esc(x.prompt) + '</div>' : '');
        h += sec('Last said', x.said ? '<div class="p-text">' + esc(x.said.text) + '</div>' : '');
        const prs = (x.prs || []).map((p) => /^https?:\/\//.test(p.url || '') ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc((p.repo ? p.repo.split('/').pop() : '') + '#' + p.n) + '</a>' : esc('#' + p.n)).join(', ');
        h += sec('Details', grid([
          ['Started by', n.parent ? link(n.parent) : ''],
          ['Branch', esc(x.branch || '')],
          ['Pull requests', prs],
          ['Model', esc(model(x.model))],
          ['Context', x.ctx ? esc(tok(x.ctx)) + ' tokens' : ''],
          ['Running', esc(runningCounts(x))],
          ['Started', when(x.startedAt)],
          ['Folder', esc(x.cwd || '')],
          ['Process', esc(x.pid + (x.alive ? '' : ' (ended)'))],
        ]));
        h += sec('Last steps', steps(x.recent));
        break;
      }
      case 'agent': {
        if (!problem) h += sec('Now', nowBlock(agentAct(x)));
        h += sec('Instructions', x.prompt ? '<div class="p-text">' + esc(x.prompt) + '</div>' : '');
        h += sec('Last said', x.said ? '<div class="p-text">' + esc(x.said) + '</div>' : '');
        h += sec('Details', grid([
          ['Started by', link(n.parent)],
          ['Type', esc(x.type)],
          ['Runs', x.background ? 'In the background' : 'In the foreground'],
          ['Model', esc(model(x.model))],
          ['Context', x.ctx ? esc(tok(x.ctx)) + ' tokens' : ''],
          ['Started', when(x.startedAt)],
          ['Took', x.doneAt && x.startedAt ? esc(dur(x.doneAt - x.startedAt)) : ''],
          ['Shells running', x.shells ? String(x.shells) : ''],
        ]));
        h += sec('Last steps', steps(x.recent));
        break;
      }
      case 'wf': {
        h += sec('Summary', x.summary ? '<div class="p-text">' + esc(x.summary) + '</div>' : '');
        h += sec('Details', grid([
          ['Started by', link(n.parent)],
          ['Progress', esc(x.done + ' of ' + x.total + ' agents done' + (x.running ? ', ' + x.running + ' running' : ''))],
          ['Phase', esc(x.phase || '')],
          ['Started', when(x.startedAt)],
          ['Took', x.durationMs ? esc(dur(x.durationMs)) : ''],
          ['Tokens', x.tokens ? esc(tok(x.tokens)) : ''],
        ]));
        break;
      }
      case 'wa': {
        h += sec('Now', x.state === 'running' && x.now ? nowBlock({ tx: x.now.label, t: x.now.since }) : '');
        h += sec('Details', grid([
          ['Workflow', link(n.parent)],
          ['Phase', esc(x.phase || '')],
          ['Model', esc(model(x.model))],
          ['Context', x.ctx ? esc(tok(x.ctx)) + ' tokens' : ''],
          ['Started', when(x.startedAt)],
        ]));
        h += sec('Last steps', steps(x.recent));
        break;
      }
      case 'shell': {
        h += sec('Details', grid([
          ['Started by', link(n.parent)],
          ['Kind', x.kind === 'monitor' ? 'A watch on a command' : 'A command in the background'],
          ['Started', when(x.startedAt)],
          ['Running for', x.state === 'running' ? timer(x.startedAt) : ''],
          ['Took', x.doneAt && x.startedAt ? esc(dur(x.doneAt - x.startedAt)) : ''],
          ['Exit code', x.exit != null ? String(x.exit) : ''],
          ['Result', esc(x.summary || '')],
          ['Process', x.pid ? String(x.pid) : ''],
          ['Task', esc(x.id)],
        ]));
        break;
      }
    }
    if (n.kind !== 'shell') h += sec(n.kind === 'wf' ? 'Agents' : 'Started', kidsList(n));
    if (window.OVLive) h += window.OVLive.panelHtml(n);
    return h;
  }

  function renderPanel() {
    const e = index.get(selected);
    const n = e ? e.n : rawIndex.get(selected);
    let html;
    if (selected === 'usage') html = window.OVUsage ? window.OVUsage.html() : '';
    else if (selected.indexOf('r:') === 0) html = window.OVLive ? window.OVLive.resourcePanel(selected.slice(2)) : '';
    else if (!n) html = '<div class="p-top"><span class="p-kind"></span><button type="button" class="p-x" data-close aria-label="Close">×</button></div><p class="p-text">This item is no longer on the map.</p>';
    else html = panelHtml(n);
    if (panel.html !== html) {
      const top = panel.scrollTop;
      panel.innerHTML = html;
      panel.html = html;
      panel.scrollTop = top;
    }
    tickIn(panel);
  }
  function openPanel(id) {
    selected = id;
    panel.classList.add('open');
    document.body.classList.add('panel-open');
    for (const el of world.querySelectorAll('.node.sel')) el.classList.remove('sel');
    const el = nodeEls.get(id);
    if (el) el.classList.add('sel');
    panel.html = null;
    renderPanel();
    clampView();
    applyView(true);
    if (window.OVLive) window.OVLive.onSelect();
    if (window.OVUsage) window.OVUsage.onSelect();
  }
  function closePanel() {
    selected = null;
    panel.classList.remove('open');
    document.body.classList.remove('panel-open');
    for (const el of world.querySelectorAll('.node.sel')) el.classList.remove('sel');
    clampView();
    applyView(true);
    if (window.OVLive) window.OVLive.onSelect();
    if (window.OVUsage) window.OVUsage.onSelect();
  }
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { closePanel(); return; }
    const res = e.target.closest('[data-res]');
    if (res) { openPanel('r:' + res.getAttribute('data-res')); return; }
    const f = e.target.closest('[data-focus]');
    if (f) {
      e.preventDefault();
      const id = f.getAttribute('data-focus');
      openPanel(id);
      focusNode(id);
    }
  });

  // ---------- alerts, status line, banner ----------

  function renderAlerts() {
    const items = (snap && snap.attention) || [];
    if (!items.length) {
      alertsEl.hidden = true;
      alertsEl.html = '';
      return;
    }
    alertsEl.hidden = false;
    const needs = items.filter((x) => x.level === 'needs').length;
    if (needs > Math.max(0, needsSeen) && !alertsOpen && (needsSeen >= 0 || innerWidth > 640)) { alertsOpen = true; store(ALERTS_KEY, '1'); }
    needsSeen = needs;
    const shown = alertsAll ? items : items.slice(0, 5);
    let h = '<button type="button" class="al-head" data-toggle aria-expanded="' + alertsOpen + '">Needs attention' +
      (needs ? '<span class="n need">' + needs + ' need you</span>' : '') +
      (items.length - needs ? '<span class="n">' + (items.length - needs) + ' ' + (items.length - needs === 1 ? 'problem' : 'problems') + '</span>' : '') +
      '<span class="chev">▾</span></button><ul class="al-list">';
    for (const a of shown) {
      h += '<li class="al ' + a.level + '" data-node="' + esc(a.node) + '" tabindex="0"><div class="what">' + esc(a.title) + '</div><div class="why">' + esc(flat(a.text)) + '</div><div class="where">' + esc(a.session) + (a.since ? ' · ' + timer(a.since, true) : '') + '</div></li>';
    }
    h += '</ul>';
    if (items.length > 5) h += '<button type="button" class="al-more" data-all>' + (alertsAll ? 'Show fewer' : 'Show all ' + items.length) + '</button>';
    if (alertsEl.html !== h) {
      alertsEl.innerHTML = h;
      alertsEl.html = h;
    }
    alertsEl.classList.toggle('closed', !alertsOpen);
    tickIn(alertsEl);
  }
  alertsEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-toggle]')) {
      alertsOpen = !alertsOpen;
      store(ALERTS_KEY, alertsOpen ? '1' : '0');
      renderAlerts();
      packW = 0;
      render();
      return;
    }
    if (e.target.closest('[data-all]')) { alertsAll = !alertsAll; renderAlerts(); return; }
    const li = e.target.closest('[data-node]');
    if (li) {
      const id = li.getAttribute('data-node');
      openPanel(id);
      focusNode(id);
    }
  });
  alertsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const li = e.target.closest('[data-node]');
    if (li) { const id = li.getAttribute('data-node'); openPanel(id); focusNode(id); }
  });

  function renderHud() {
    const t = (snap && snap.totals) || {};
    const part = (n, one, many, k) => '<span class="' + (k || '') + '"><b>' + n + '</b>' + (n === 1 ? one : many) + '</span>';
    const bits = [part(t.sessions || 0, 'session', 'sessions')];
    if (t.working) bits.push(part(t.working, 'working', 'working', 'k-work'));
    if (t.needsYou) bits.push(part(t.needsYou, 'needs you', 'need you', 'k-need'));
    if (t.problems) bits.push(part(t.problems, 'problem', 'problems', 'k-bad'));
    if (t.agentsRunning) bits.push(part(t.agentsRunning, 'agent', 'agents'));
    if (t.shellsRunning) bits.push(part(t.shellsRunning, 'shell', 'shells'));
    if (t.workflowsRunning) bits.push(part(t.workflowsRunning, 'workflow', 'workflows'));
    hudText.innerHTML = (connected ? '' : 'Reconnecting · ') + bits.join('<span class="dot">·</span>');
    mark.classList.toggle('off', !connected);
  }

  function renderBanner() {
    let text = '';
    let warn = false;
    if (!connected && lostAt && Date.now() - lostAt > 4000) {
      text = 'Lost the connection to the overview server. Reconnecting…';
      warn = true;
    } else if (snap && snap.networkDown) {
      text = "Network problem: Claude can't reach the API server. The sessions are retrying.";
    }
    bannerEl.hidden = !text;
    bannerEl.textContent = text;
    bannerEl.classList.toggle('warn', warn);
  }

  // ---------- live data ----------

  function connect() {
    const es = new EventSource('/events');
    es.onmessage = (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      offset = d.now - Date.now();
      snap = d;
      connected = true;
      lostAt = 0;
      render();
    };
    const toLive = (type) => (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (window.OVLive) window.OVLive.ingest(type, d); else liveQueue.push([type, d]);
    };
    es.addEventListener('hist', toLive('hist'));
    es.addEventListener('ev', toLive('ev'));
    es.addEventListener('tick', () => {
      if (!connected) { connected = true; lostAt = 0; renderHud(); renderBanner(); }
    });
    es.onerror = () => {
      if (connected) lostAt = Date.now();
      connected = false;
      renderHud();
      setTimeout(renderBanner, 4500);
    };
  }

  setInterval(() => { for (const el of document.querySelectorAll('[data-since]')) el.textContent = since(Number(el.dataset.since), el.hasAttribute('data-ago')); }, 1000);

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { packW = 0; packK = 0; render(); }, 120);
  });

  // ---------- what the timeline and the right column use ----------

  const liveQueue = [];
  function markNodes(ids) {
    for (const el of world.querySelectorAll('.node.touch')) el.classList.remove('touch');
    for (const id of ids || []) {
      let r = rawIndex.get(id);
      while (r && !nodeEls.get(r.id)) r = r.parent;
      const el = r && nodeEls.get(r.id);
      if (el) el.classList.add('touch');
    }
  }
  window.OV = {
    now: nowMs,
    since,
    snap: () => snap,
    drain: () => liveQueue.splice(0),
    selected: () => selected,
    name(id) { const n = rawIndex.get(id); return n ? nameOf(n) : null; },
    rect(id) {
      for (let r = rawIndex.get(id); r; r = r.parent) {
        const el = nodeEls.get(r.id);
        if (el && el.isConnected) return el.getBoundingClientRect();
      }
      return null;
    },
    viewportRect() {
      const r = viewport.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.left + usable().w, bottom: r.bottom };
    },
    hover(id) { hoverId = id; applyHover(); },
    mark: markNodes,
    open: openPanel,
    close: closePanel,
    repaint() { if (selected) renderPanel(); },
    show(id) { openPanel(id); focusNode(id); },
    relayout() { packW = 0; packK = 0; render(); },
  };

  connect();
})();
