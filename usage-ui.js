(function () {
  'use strict';

  const ID = 'usage';
  const REFRESH_MS = 15000;
  const STALE_MS = 5 * 60000;
  const RANGE_KEY = 'claude-overview-usage-range';
  const METRIC_KEY = 'claude-overview-usage-metric';
  const RANGES = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['month', 'This month'], ['all', 'All']];
  // index into a [messages, input, output, cache write, cache read] row
  const METRICS = [[2, 'Output'], [1, 'Input'], [3, 'Cache write'], [4, 'Cache read']];
  const FAMILIES = [['Opus', /opus/i, '#3987e5'], ['Fable', /fable/i, '#d95926'], ['Sonnet', /sonnet/i, '#199e70'], ['Haiku', /haiku/i, '#c98500'], ['Other', /./, '#7c8aa0']];

  const panel = document.getElementById('panel');
  const btn = document.getElementById('usage-btn');
  let range = load(RANGE_KEY, '7d');
  let metric = Number(load(METRIC_KEY, '2'));
  let data = null;
  let html = '';
  let timer = 0;
  let busy = false;

  function load(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmt(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
    return String(Math.round(n));
  }
  function family(model) { return FAMILIES.findIndex((f) => f[1].test(model)); }
  function modelName(m) {
    const x = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-|$)/i.exec(m);
    if (!x) return m;
    return x[1][0].toUpperCase() + x[1].slice(1) + ' ' + x[2] + (x[3] ? '.' + x[3] : '');
  }
  function until(t, now) {
    const s = Math.max(0, Math.round((t - now) / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm';
  }
  function when(t) {
    const d = new Date(t);
    const same = d.toDateString() === new Date().toDateString();
    return same ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function seg(attr, list, cur) {
    return '<div class="u-seg" role="group">' + list.map(([v, l]) => '<button type="button" ' + attr + '="' + v + '" aria-pressed="' + (String(v) === String(cur)) + '">' + esc(l) + '</button>').join('') + '</div>';
  }

  // ---------- accounts ----------

  function winRow(label, w, now) {
    if (!w) return '';
    const pct = Math.max(0, Math.min(100, w.pct));
    const c = pct >= 90 ? 'var(--bad)' : pct >= 70 ? 'var(--turn)' : 'var(--work)';
    const reset = w.at ? '<span class="wr" title="Resets ' + esc(when(w.at)) + '">' + esc(until(w.at, now)) + '</span>' : '<span class="wr"></span>';
    return '<div class="u-win"><span class="wl">' + esc(label) + '</span><span class="wb"><i style="width:' + pct.toFixed(1) + '%;background:' + c + '"></i></span><span class="wp">' + Math.round(w.pct) + '%</span>' + reset + '</div>';
  }
  function binding(a) { return Math.max(a.h5 ? a.h5.pct : 0, a.d7 ? a.d7.pct : 0); }
  function accountsHtml(acc, now) {
    if (!acc) return '<p class="u-note">Plan limits show here when cswap is installed.</p>';
    const rank = (a) => (a.active ? 0 : a.dead || a.disabled || a.apiKey ? 2 : 1);
    const list = acc.list.slice().sort((a, b) => rank(a) - rank(b) || binding(a) - binding(b) || a.num - b.num);
    const newest = list.reduce((m, a) => Math.max(m, a.active ? a.fetched : 0), 0) || list.reduce((m, a) => Math.max(m, a.fetched), 0);
    let h = '<div class="u-accs">';
    for (const a of list) {
      const cls = 'u-acc' + (a.active ? ' on' : '') + (a.dead || a.disabled ? ' off' : '');
      h += '<div class="' + cls + '"><div class="u-who"><b>#' + Number(a.num) + '</b><span class="em" title="' + esc(a.org) + '">' + esc(a.alias || a.email) + '</span>' + (a.active ? '<span class="u-badge">active</span>' : '') + '</div>';
      if (a.dead) h += '<div class="u-warn">Re-login needed: log in with Claude Code, then run <code>cswap add</code></div>';
      else if (a.disabled) h += '<div class="u-dim">Turned off in cswap</div>';
      else if (a.apiKey) h += '<div class="u-dim">API key account: no plan limits</div>';
      else if (!a.h5 && !a.d7 && !a.scoped.length) h += '<div class="u-dim">No reading yet</div>';
      else {
        h += '<div class="u-wins">' + winRow('5h', a.h5, now) + winRow('7d', a.d7, now) + a.scoped.map((s) => winRow(s.name, s, now)).join('') + '</div>';
        if (a.error) h += '<div class="u-dim">Last check failed (' + esc(a.error) + '); showing the reading before it</div>';
      }
      h += '</div>';
    }
    h += '</div>';
    const foot = [];
    if (newest) foot.push((now - newest > STALE_MS ? '<span class="u-stale">' : '<span>') + 'Read by cswap <span data-since="' + Number(newest) + '" data-ago></span></span>');
    if (acc.lastSwitch) foot.push('<span>Last switch ' + esc(when(acc.lastSwitch.at)) + (acc.lastSwitch.from != null ? ': #' + esc(acc.lastSwitch.from) + ' → #' + esc(acc.lastSwitch.to) : '') + '</span>');
    return h + (foot.length ? '<p class="u-note">' + foot.join(' · ') + '</p>' : '');
  }

  // ---------- tokens ----------

  function chart(series, width) {
    const H = 132;
    const L = 40;
    const B = 18;
    const n = series.length;
    if (!n) return '';
    const stacks = series.map((p) => {
      const f = FAMILIES.map(() => 0);
      for (const m in p.m) f[family(m)] += p.m[m][metric];
      return f;
    });
    const max = Math.max(1, ...stacks.map((f) => f.reduce((a, b) => a + b, 0)));
    const step = Math.pow(10, Math.floor(Math.log10(max)));
    const r = max / step;
    const top = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * step;
    const W = Math.max(160, width);
    const slot = (W - L) / n;
    const gap = slot > 6 ? 2 : slot > 3 ? 1 : 0;
    const bw = Math.max(1, slot - gap);
    const y = (v) => (H - B) - (v / top) * (H - B - 6);
    let g = '';
    for (let i = 0; i <= 2; i++) {
      const v = (top / 2) * i;
      g += '<line x1="' + L + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" class="gl"/><text x="' + (L - 6) + '" y="' + (y(v) + 3.5) + '" class="ax" text-anchor="end">' + fmt(v) + '</text>';
    }
    let bars = '';
    stacks.forEach((f, i) => {
      const x = L + i * slot + gap / 2;
      let acc = 0;
      f.forEach((v, k) => {
        if (!v) return;
        const y0 = y(acc);
        const y1 = y(acc + v);
        // a gap of panel colour between stacked segments
        const h = Math.max(0.75, y0 - y1 - (acc ? 1 : 0));
        acc += v;
        bars += '<rect x="' + x.toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + FAMILIES[k][2] + '"/>';
      });
      bars += '<rect class="hit" data-i="' + i + '" x="' + (L + i * slot).toFixed(1) + '" y="0" width="' + slot.toFixed(1) + '" height="' + (H - B) + '"/>';
    });
    const hourly = series[0].k.length > 10;
    const label = (k) => (hourly ? String(Number(k.slice(11, 13))) : String(Number(k.slice(8, 10))));
    const marks = new Set([0, n - 1]);
    const want = Math.min(n, hourly ? 6 : 7);
    for (let i = 1; i < want - 1; i++) marks.add(Math.round((i * (n - 1)) / (want - 1)));
    let xl = '';
    for (const i of marks) xl += '<text x="' + (L + i * slot + slot / 2).toFixed(1) + '" y="' + (H - 4) + '" class="ax" text-anchor="middle">' + esc(label(series[i].k)) + '</text>';
    return '<svg class="u-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(METRICS.find((m) => m[0] === metric)[1]) + ' tokens per ' + (hourly ? 'hour' : 'day') + '">' + g + bars + xl + '</svg>';
  }
  function tile(label, value, hint) { return '<div class="u-tile" title="' + esc(hint) + '"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>'; }
  function bar(v, max, c) { return '<span class="u-bar"><i style="width:' + (max ? (v / max) * 100 : 0).toFixed(1) + '%' + (c ? ';background:' + c : '') + '"></i></span>'; }
  function tokensHtml(d, width) {
    let h = seg('data-urange', RANGES, range);
    const p = d.progress;
    if (p && p.pending) h += '<p class="u-note u-stale">Still counting older transcripts: ' + (p.read / 1e9).toFixed(1) + ' of ' + (p.total / 1e9).toFixed(1) + ' GB read, so totals are low for now</p>';
    const t = d.totals;
    if (!t) return h + '<p class="u-note">Counting transcripts…</p>';
    h += '<div class="u-tiles">' +
      tile('Output', fmt(t[2]), 'Tokens the model wrote') +
      tile('Input', fmt(t[1]), 'New input tokens, not read from cache') +
      tile('Cache write', fmt(t[3]), 'Input tokens written to the prompt cache') +
      tile('Cache read', fmt(t[4]), 'Input tokens read back from the prompt cache') +
      '</div>';
    h += '<p class="u-note" title="Runs started with claude -p --no-session-persistence write no transcript, so they are not counted">' + t[0].toLocaleString() + ' replies in this machine\'s transcripts' + (t[2] ? ' · agents wrote ' + Math.round((d.agents[2] / t[2]) * 100) + '% of the output' : '') + '</p>';
    const used = FAMILIES.map((f, k) => k).filter((k) => d.series.some((p) => Object.keys(p.m).some((m) => family(m) === k && p.m[m][metric])));
    h += '<div class="u-chart">' + chart(d.series, width) + '<div class="u-tip" hidden></div></div>';
    h += '<div class="u-legend">' + used.map((k) => '<span><i style="background:' + FAMILIES[k][2] + '"></i>' + FAMILIES[k][0] + '</span>').join('') + '</div>';
    h += seg('data-umetric', METRICS, metric);
    return h;
  }
  function modelsHtml(d) {
    if (!d.models || !d.models.length) return '';
    let h = '<div class="u-table"><span class="hd">Model</span><span class="hd">Replies</span><span class="hd">Output</span><span class="hd">Input</span><span class="hd">Cache w</span><span class="hd">Cache r</span>';
    for (const [m, a] of d.models) {
      h += '<span class="nm"><i style="background:' + FAMILIES[family(m)][2] + '"></i>' + esc(modelName(m)) + '</span><span>' + fmt(a[0]) + '</span><span>' + fmt(a[2]) + '</span><span>' + fmt(a[1]) + '</span><span>' + fmt(a[3]) + '</span><span>' + fmt(a[4]) + '</span>';
    }
    return '<section class="p-sec"><h3>By model</h3>' + h + '</div></section>';
  }
  function sessionsHtml(d) {
    if (!d.sessions || !d.sessions.length) return '';
    const max = d.sessions[0].a[2];
    const rows = d.sessions.map((s) => {
      const link = s.live && window.OV && OV.name('s:' + s.sid);
      const title = s.title || s.name || s.sid.slice(0, 8);
      const sub = [s.live ? (s.name && s.name !== title ? s.name + ' · ' : '') + 'live' : '', s.cwd, s.last && !s.live ? when(s.last) : ''].filter(Boolean).join(' · ');
      return '<li' + (link ? ' data-focus="s:' + esc(s.sid) + '" title="Show on the map"' : '') + '><span class="nm"><b>' + esc(title) + '</b><span>' + esc(sub) + '</span></span>' + bar(s.a[2], max) + '<span class="v">' + fmt(s.a[2]) + '</span></li>';
    }).join('');
    return '<section class="p-sec"><h3>Top sessions · output</h3><ul class="u-rows">' + rows + '</ul></section>';
  }
  function foldersHtml(d) {
    if (!d.projects || !d.projects.length) return '';
    const max = d.projects[0][1][2];
    const parts = d.projects.map(([p]) => p.split('/').filter(Boolean));
    // the shortest tail of each path that no other row shares, so two folders both called wt read apart
    const labels = parts.map((x, i) => {
      for (let n = 1; n < x.length; n++) {
        const tail = x.slice(-n).join('/');
        if (!parts.some((y, j) => j !== i && y.slice(-n).join('/') === tail)) return tail;
      }
      return x.join('/');
    });
    const rows = d.projects.map(([p, a], i) => '<li><span class="nm"><b>' + esc(labels[i] || 'unknown') + '</b><span>' + esc(p) + '</span></span>' + bar(a[2], max) + '<span class="v">' + fmt(a[2]) + '</span></li>').join('');
    return '<section class="p-sec"><h3>By folder · output</h3><ul class="u-rows">' + rows + '</ul></section>';
  }

  function build() {
    const now = Date.now();
    const width = panel.clientWidth - 40;
    let h = '<div class="p-top"><span class="p-kind">Usage</span><button type="button" class="p-x" data-close aria-label="Close">×</button></div>';
    h += '<h2 class="p-title">Tokens and limits</h2>';
    if (!data) { html = h + '<p class="u-note">Loading…</p>'; return; }
    h += '<section class="p-sec"><h3>Accounts</h3>' + accountsHtml(data.accounts, now) + '</section>';
    h += '<section class="p-sec"><h3>Tokens</h3>' + tokensHtml(data, width) + '</section>';
    h += modelsHtml(data) + sessionsHtml(data) + foldersHtml(data);
    html = h;
  }
  function fetchNow() {
    if (busy) return;
    busy = true;
    const want = range;
    fetch('/usage?range=' + encodeURIComponent(want), { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (want === range) data = d; })
      .catch(() => { /* the next refresh tries again */ })
      .then(() => {
        busy = false;
        if (want !== range) { fetchNow(); return; }
        if (OV.selected() !== ID) return;
        build();
        OV.repaint();
      });
  }
  function schedule() {
    clearTimeout(timer);
    if (OV.selected() !== ID) return;
    timer = setTimeout(() => { fetchNow(); schedule(); }, REFRESH_MS);
  }
  function open() {
    build();
    OV.open(ID);
    fetchNow();
    schedule();
  }
  function toggle() {
    if (OV.selected() === ID) OV.close(); else open();
  }

  btn.addEventListener('click', toggle);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === 'u' || e.key === 'U') toggle();
  });
  panel.addEventListener('click', (e) => {
    if (OV.selected() !== ID) return;
    const r = e.target.closest('[data-urange]');
    if (r) {
      range = r.getAttribute('data-urange');
      store(RANGE_KEY, range);
      build();
      OV.repaint();
      fetchNow();
      return;
    }
    const m = e.target.closest('[data-umetric]');
    if (m) {
      metric = Number(m.getAttribute('data-umetric'));
      store(METRIC_KEY, String(metric));
      build();
      OV.repaint();
    }
  });
  panel.addEventListener('mousemove', (e) => {
    if (OV.selected() !== ID || !data || !data.series) return;
    const tip = panel.querySelector('.u-tip');
    if (!tip) return;
    const hit = e.target.closest && e.target.closest('rect.hit');
    if (!hit) { tip.hidden = true; return; }
    const p = data.series[Number(hit.getAttribute('data-i'))];
    if (!p) return;
    const fam = FAMILIES.map(() => 0);
    for (const k in p.m) fam[family(k)] += p.m[k][metric];
    const total = fam.reduce((a, b) => a + b, 0);
    const day = p.k.length > 10 ? new Date(p.k.slice(0, 10) + 'T' + p.k.slice(11, 13) + ':00:00').toLocaleTimeString([], { hour: 'numeric' }) : new Date(p.k + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    tip.innerHTML = '<b>' + esc(day) + '</b><span class="tt">' + fmt(total) + ' ' + esc(METRICS.find((x) => x[0] === metric)[1].toLowerCase()) + '</span>' +
      FAMILIES.map((f, k) => (fam[k] ? '<span><i style="background:' + f[2] + '"></i>' + f[0] + ' ' + fmt(fam[k]) + '</span>' : '')).join('');
    tip.hidden = false;
    const box = tip.parentNode.getBoundingClientRect();
    const hr = hit.getBoundingClientRect();
    const x = Math.min(box.width - tip.offsetWidth, Math.max(0, hr.left - box.left + hr.width / 2 - tip.offsetWidth / 2));
    tip.style.left = x + 'px';
  });
  panel.addEventListener('mouseleave', () => { const tip = panel.querySelector('.u-tip'); if (tip) tip.hidden = true; });
  window.addEventListener('resize', () => { if (OV.selected() === ID) { build(); OV.repaint(); } });

  window.OVUsage = {
    html() { return html; },
    onSelect() {
      const on = OV.selected() === ID;
      btn.setAttribute('aria-pressed', String(on));
      if (on) schedule(); else clearTimeout(timer);
    },
  };
})();
