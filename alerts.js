(function () {
  'use strict';

  const PREFS_KEY = 'claude-overview-alerts';
  const TURN_SETTLE_MS = 3000;
  const MAX_SEPARATE = 3;
  // a row can drop out for one poll and come back with the same key
  const FORGET_MS = 3600000;

  const $ = (id) => document.getElementById(id);
  const btn = $('alerts-btn');
  const menu = $('alert-menu');
  const sw = menu.querySelector('[data-switch]');
  const msg = menu.querySelector('.am-msg');
  const iconEl = document.querySelector('link[rel="icon"]');
  const title = document.title;
  const supported = 'Notification' in window;

  let prefs = load();
  let latest = null;
  let seen = null;
  let boot = null;
  let lastSnap = 0;
  const states = new Map();
  const settling = new Map();

  function load() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(PREFS_KEY)); } catch (e) { /* storage unavailable */ }
    return Object.assign({ on: false, needs: true, problems: true, turns: false }, p && typeof p === 'object' ? p : {});
  }
  function save() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* storage unavailable */ }
  }
  function permission() { return supported ? Notification.permission : 'unsupported'; }
  function live() { return prefs.on && permission() === 'granted'; }
  // the page in front already shows everything an alert would say
  function armed() { return live() && !document.hasFocus(); }

  function dot(color) {
    return 'data:image/svg+xml,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='5' fill='" + color + "'/></svg>");
  }
  const token = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const okIcon = iconEl ? iconEl.getAttribute('href') : '';
  const needIcon = dot(token('--need', '#f472b6'));
  const lostIcon = dot(token('--text-2', '#b9c5d6'));

  function setTitle(needs) {
    const t = needs ? '(' + needs + ') ' + title : title;
    if (document.title !== t) document.title = t;
    const href = needs === '?' ? lostIcon : needs ? needIcon : okIcon;
    if (iconEl && iconEl.getAttribute('href') !== href) iconEl.setAttribute('href', href);
  }

  function notify(tag, head, body, node) {
    let n;
    try { n = new Notification(head, { body, tag }); } catch (e) { return; }
    n.onclick = () => {
      window.focus();
      if (node && window.OV) window.OV.show(node);
      n.close();
    };
  }

  function keyOf(a) {
    // an agent's permission prompt also puts its session into needs-you, with the same start time
    if (a.level === 'needs') return 'needs|' + a.sid + '|' + a.since;
    // an agent's end time can move
    return a.node.startsWith('s:') ? a.node + '|' + a.since : a.node;
  }
  function wanted(a) { return a.level === 'needs' ? prefs.needs : prefs.problems; }
  function headOf(a) { return a.title + (a.session && a.session !== a.title ? ' · ' + a.session : ''); }

  function announce(list) {
    if (!list.length || !armed()) return;
    if (list.length > MAX_SEPARATE) {
      const needs = list.filter((a) => a.level === 'needs').length;
      const rest = list.length - needs;
      const head = needs ? needs + (needs === 1 ? ' needs you' : ' need you') + (rest ? ', ' + rest + ' more ' + (rest === 1 ? 'needs' : 'need') + ' attention' : '') : list.length + ' new problems';
      notify('burst:' + keyOf(list[0]), head, list.slice(0, 3).map(headOf).join('\n'), list[0].node);
      return;
    }
    for (const a of list) notify(keyOf(a), (a.level === 'needs' ? 'Needs you: ' : '') + headOf(a), a.text, a.node);
  }

  function watchTurns(list) {
    const ids = new Set();
    for (const s of list) {
      ids.add(s.id);
      const prev = states.get(s.id);
      // a prompt can come during a turn or after it, so it says nothing about whether one is running
      if (s.state !== 'needs-you') states.set(s.id, s.state);
      if (s.state !== 'your-turn') { unsettle(s.id); continue; }
      if (prev !== 'working' && prev !== 'retrying') continue;
      settling.set(s.id, setTimeout(() => {
        settling.delete(s.id);
        const now = latest && (latest.sessions || []).find((x) => x.id === s.id);
        // on a your-turn session the server sets a reason only when you interrupted it
        if (!now || now.state !== 'your-turn' || now.parentSid || now.headless || now.reason) return;
        // the server keeps the last thing said, which can be from an earlier turn
        const said = now.said && now.said.text && now.said.at >= (now.turnStartedAt || 0) ? now.said.text : 'It is waiting for your next message';
        if (prefs.turns && armed()) notify('turn:' + s.id + ':' + now.since, 'Your turn: ' + now.name, said, 's:' + s.id);
      }, TURN_SETTLE_MS));
    }
    for (const id of states.keys()) if (!ids.has(id)) { states.delete(id); unsettle(id); }
  }
  function unsettle(id) {
    clearTimeout(settling.get(id));
    settling.delete(id);
  }

  function onSnap(snap) {
    if (!snap) return;
    latest = snap;
    setTitle((snap.totals || {}).needsYou);
    if (btn.classList.contains('on') !== live()) paint();
    const baseline = !seen;
    if (baseline) seen = new Map();
    // a restarted server dates the deaths it finds again, so only its needs rows can be told from old ones
    const restarted = snap.boot !== boot;
    boot = snap.boot;
    const t = Date.now();
    const fresh = [];
    for (const a of snap.attention || []) {
      // not kept in seen: a retrying agent's quiet row has the key its failure will have
      if (a.quiet) continue;
      const k = keyOf(a);
      if (!baseline && !seen.has(k) && wanted(a) && (!restarted || a.level === 'needs')) fresh.push(a);
      seen.set(k, t);
    }
    // aged from the snapshot before: a quiet board can send nothing for longer than this, and then miss a row once
    for (const [k, at] of seen) if (lastSnap - at > FORGET_MS) seen.delete(k);
    lastSnap = t;
    announce(fresh);
    watchTurns(snap.sessions || []);
  }
  // once the stream is gone, neither the last count nor an all-clear is true
  function onLost() { setTitle('?'); }

  function paint() {
    const p = permission();
    const on = live();
    btn.classList.toggle('on', on);
    btn.title = 'Desktop alerts: ' + (on ? 'on' : 'off');
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.disabled = p === 'unsupported';
    for (const box of menu.querySelectorAll('[data-pref]')) box.checked = !!prefs[box.dataset.pref];
    let text = '';
    if (p === 'unsupported') text = 'This browser cannot show desktop alerts.';
    else if (p === 'denied') text = 'The browser blocks notifications for this page. Allow them in its site settings, then turn this on.';
    msg.textContent = text;
    msg.hidden = !text;
  }
  function ask() {
    return new Promise((resolve) => {
      let done = false;
      const fin = (p) => { if (!done) { done = true; resolve(p || Notification.permission); } };
      // older Safari takes a callback and returns nothing
      try {
        const r = Notification.requestPermission(fin);
        if (r && r.then) r.then(fin, () => fin());
      } catch (e) { fin(); }
    });
  }
  async function toggle() {
    if (live()) {
      prefs.on = false;
    } else {
      if (!supported) return;
      const p = Notification.permission === 'default' ? await ask() : Notification.permission;
      prefs.on = p === 'granted';
    }
    save();
    paint();
  }
  function place() {
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = Math.round(Math.max(8, Math.min(r.right - w, innerWidth - w - 8))) + 'px';
    menu.style.bottom = Math.max(8, innerHeight - r.top + 8) + 'px';
  }
  function openMenu() {
    paint();
    menu.hidden = false;
    place();
    btn.setAttribute('aria-expanded', 'true');
    sw.focus();
  }
  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  }

  btn.addEventListener('click', () => { if (menu.hidden) openMenu(); else closeMenu(false); });
  sw.addEventListener('click', toggle);
  menu.addEventListener('change', (e) => {
    const box = e.target.closest('[data-pref]');
    if (!box) return;
    prefs[box.dataset.pref] = box.checked;
    save();
  });
  // capture, so Escape closes the menu and not the detail panel behind it, and no board shortcut moves the bell
  document.addEventListener('keydown', (e) => {
    if (menu.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    e.stopPropagation();
    if (e.key === 'Escape') closeMenu(true);
  }, true);
  // keys are held back while it is open, so it must not stay open behind the focus
  document.addEventListener('focusin', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu(false);
  });
  window.addEventListener('resize', () => closeMenu(false));
  window.addEventListener('storage', (e) => { if (e.key === PREFS_KEY) { prefs = load(); paint(); } });

  paint();
  window.OVAlerts = { onSnap, onLost };
})();
