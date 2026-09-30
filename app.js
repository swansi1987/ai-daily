/* AI Daily — static daily AI-news reader. No frameworks, no build step. */
(function () {
  'use strict';

  // ======= CONFIG: change the app name / data path in ONE place =======
  const CONFIG = {
    APP_NAME: 'AI Daily',
    TAGLINE: 'Every AI story that matters, tiny to huge.',
    EDITIONS_DIR: 'editions',
    TIME_ZONE: undefined, // e.g. 'Asia/Kolkata' to force IST; undefined = viewer's local zone
  };

  const CATEGORIES = [
    { name: 'Model releases', color: '#7c5cff' },
    { name: 'Research & papers', color: '#22d3ee' },
    { name: 'Tools & products', color: '#34d399' },
    { name: 'Big Tech moves', color: '#60a5fa' },
    { name: 'Open source', color: '#a3e635' },
    { name: 'Funding & startups', color: '#fbbf24' },
    { name: 'Policy & safety', color: '#f87171' },
    { name: 'Hardware & chips', color: '#fb923c' },
    { name: 'Other', color: '#a1a1aa' },
  ];
  const CAT_COLOR = Object.fromEntries(CATEGORIES.map(c => [c.name, c.color]));
  const IMP_RANK = { Major: 0, Notable: 1, Minor: 2 };

  const $ = sel => document.querySelector(sel);
  const els = {
    dateSelect: $('#dateSelect'), prev: $('#prevBtn'), next: $('#nextBtn'), theme: $('#themeBtn'),
    editionDate: $('#editionDate'), highlights: $('#highlights'), stats: $('#stats'),
    search: $('#searchInput'), major: $('#majorToggle'), video: $('#videoToggle'), reset: $('#resetBtn'),
    chips: $('#chips'), feed: $('#feed'), count: $('#resultCount'), empty: $('#empty'), emptyReset: $('#emptyReset'),
    error: $('#error'), generatedAt: $('#generatedAt'), controls: document.querySelector('.controls'),
    updatedAt: $('#updatedAt'), stale: $('#staleBanner'),
  };

  const state = { dates: [], date: null, edition: null, category: null, majorOnly: false, videosOnly: false, q: '' };

  // ---------- helpers ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '#');

  function youtubeId(url) {
    if (!url) return null;
    const m = String(url).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }
  function platformLabel(item) {
    const p = (item.video_platform || '').toLowerCase();
    if (p === 'youtube' || youtubeId(item.video_url)) return 'YouTube';
    if (p === 'x' || /(?:x|twitter)\.com\//.test(item.video_url || '')) return 'X';
    return item.video_platform || 'Video';
  }
  function parseDate(s) {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { d: new Date(s + 'T12:00:00'), dateOnly: true };
    const d = new Date(s);
    return isNaN(d) ? null : { d, dateOnly: false };
  }
  function fmtEditionDate(iso) {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function fmtShortDate(iso) {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function fmtPublished(s) {
    const p = parseDate(s);
    if (!p) return '';
    if (p.dateOnly) return p.d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const opts = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
    if (CONFIG.TIME_ZONE) opts.timeZone = CONFIG.TIME_ZONE;
    // Browsers print India time as "GMT+5:30"; show the familiar "IST" instead.
    return p.d.toLocaleString(undefined, opts).replace(/GMT\+5:30|UTC\+5:30/, 'IST');
  }
  const STALE_HOURS = 26;
  function fmtIST(d) {
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
      .replace(/\bam\b/i, 'AM').replace(/\bpm\b/i, 'PM') + ' IST';
  }
  function timeAgo(s) {
    const p = parseDate(s);
    if (!p || p.dateOnly) return '';
    const mins = Math.round((Date.now() - p.d.getTime()) / 60000);
    if (mins < 0 || mins >= 60 * 24) return '';
    if (mins < 60) return mins + 'm ago';
    return Math.round(mins / 60) + 'h ago';
  }

  async function getJSON(path) {
    // Cache-bust edition data so a fresh edition shows up the moment it's published (GitHub Pages caches ~10 min).
    const url = path + (path.includes('?') ? '&' : '?') + 't=' + Date.now();
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status + ' loading ' + path);
    return res.json();
  }

  // ---------- theme ----------
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    els.theme.querySelector('.theme-icon').textContent = t === 'dark' ? '\u2600' : '\u263E';
    els.theme.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0b0d12' : '#f5f6fa');
  }
  els.theme.addEventListener('click', () => {
    const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('aidaily-theme', t); } catch (e) {}
    applyTheme(t);
  });

  // ---------- editions ----------
  async function init() {
    document.title = CONFIG.APP_NAME;
    document.querySelectorAll('[data-app-name]').forEach(n => (n.textContent = CONFIG.APP_NAME));
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

    let latest = null;
    try {
      const idx = await getJSON(CONFIG.EDITIONS_DIR + '/index.json');
      state.dates = (idx.dates || []).slice().sort().reverse();
      latest = idx.latest || state.dates[0];
    } catch (e) { /* fall back to latest.json only */ }

    const hashDate = (location.hash.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
    const want = hashDate && state.dates.includes(hashDate) ? hashDate : null;
    renderDateSelect();
    await loadEdition(want || latest || null);
  }

  function renderDateSelect() {
    els.dateSelect.innerHTML = state.dates.map(d => `<option value="${d}">${esc(fmtShortDate(d))}</option>`).join('');
  }

  async function loadEdition(date) {
    els.error.hidden = true;
    try {
      const path = date ? `${CONFIG.EDITIONS_DIR}/${date}.json` : `${CONFIG.EDITIONS_DIR}/latest.json`;
      let ed;
      try { ed = await getJSON(path); } catch (e) { if (!date) throw e; ed = await getJSON(`${CONFIG.EDITIONS_DIR}/latest.json`); }
      state.edition = ed; state.date = ed.date;
      if (!state.dates.includes(ed.date)) { state.dates.unshift(ed.date); state.dates.sort().reverse(); renderDateSelect(); }
      els.dateSelect.value = ed.date;
      if (location.hash.replace('#', '') !== ed.date) history.replaceState(null, '', '#' + ed.date);
      updateNav();
      renderEdition();
    } catch (e) {
      els.error.hidden = false;
      if (state.edition) {
        // Keep showing the edition that is already on screen, and put the picker/URL back to match it
        // (otherwise the header says e.g. "Sat, 26 Sept" while the page still shows the 29th).
        els.dateSelect.value = state.date;
        if (location.hash.replace('#', '') !== state.date) history.replaceState(null, '', '#' + state.date);
        updateNav();
        els.error.textContent = (navigator.onLine === false
          ? "You're offline and the " + fmtShortDate(date) + " edition isn't saved on this device yet."
          : "Couldn't load the " + fmtShortDate(date) + ' edition (' + e.message + ').')
          + ' Still showing ' + fmtShortDate(state.date) + '.';
        els.error.scrollIntoView({ block: 'nearest' });
      } else {
        els.error.textContent = location.protocol === 'file:'
          ? 'Could not load the edition. Serve this folder with any static server (e.g. "python3 -m http.server") instead of opening index.html from disk. (' + e.message + ')'
          : (navigator.onLine === false ? "You're offline and no edition is saved on this device yet. Connect and pull down to refresh."
            : "Couldn't load today's edition (" + e.message + '). Pull down or try again in a minute.');
        els.highlights.innerHTML = '';
      }
    }
  }

  function updateNav() {
    const i = state.dates.indexOf(state.date);
    els.prev.disabled = i < 0 || i >= state.dates.length - 1; // older
    els.next.disabled = i <= 0; // newer
  }
  els.prev.addEventListener('click', () => { const i = state.dates.indexOf(state.date); if (i < state.dates.length - 1) loadEdition(state.dates[i + 1]); });
  els.next.addEventListener('click', () => { const i = state.dates.indexOf(state.date); if (i > 0) loadEdition(state.dates[i - 1]); });
  els.dateSelect.addEventListener('change', () => loadEdition(els.dateSelect.value));
  window.addEventListener('hashchange', () => {
    const d = location.hash.replace('#', '');
    if (d && d !== state.date && state.dates.includes(d)) loadEdition(d);
    else if (state.date && d !== state.date) history.replaceState(null, '', '#' + state.date); // no edition for that date: keep URL = what's shown
  });

  // ---------- render ----------
  function renderEdition() {
    const ed = state.edition;
    const items = ed.items || [];
    els.editionDate.textContent = fmtEditionDate(ed.date) + (state.dates[0] === ed.date ? ' · Latest' : '');
    els.highlights.innerHTML = (ed.highlights || []).map(h => `<li>${esc(h)}</li>`).join('');
    const major = items.filter(i => i.importance === 'Major').length;
    const vids = items.filter(i => i.video_url).length;
    const cats = new Set(items.map(i => i.category)).size;
    els.stats.innerHTML = `<span><b>${items.length}</b> stories</span><span><b>${major}</b> major</span><span><b>${vids}</b> with video</span><span><b>${cats}</b> categories</span>`;
    const g = ed.generated_at ? parseDate(ed.generated_at) : null;
    els.generatedAt.textContent = g ? 'Edition generated ' + g.d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    if (els.updatedAt) els.updatedAt.textContent = g && !g.dateOnly ? 'Updated ' + fmtIST(g.d) : '';
    if (els.stale) {
      const isLatest = state.dates[0] === ed.date;
      const ageH = g ? (Date.now() - g.d.getTime()) / 3600000 : 0;
      els.stale.hidden = !(isLatest && ageH > STALE_HOURS);
      if (!els.stale.hidden) els.stale.textContent = `Heads up: this edition is ${Math.floor(ageH)}h old. Today's update hasn't arrived yet; new editions normally land around 6 AM IST.`;
    }
    renderChips();
    renderFeed();
    justIn.onEdition();
  }

  function renderChips() {
    const items = state.edition.items || [];
    const counts = {};
    items.forEach(i => (counts[i.category] = (counts[i.category] || 0) + 1));
    const all = `<button class="chip" data-cat="" aria-pressed="${!state.category}">All<span class="count">${items.length}</span></button>`;
    els.chips.innerHTML = all + CATEGORIES.filter(c => counts[c.name]).map(c =>
      `<button class="chip" style="--c:${c.color}" data-cat="${esc(c.name)}" aria-pressed="${state.category === c.name}">${esc(c.name)}<span class="count">${counts[c.name]}</span></button>`
    ).join('');
  }
  els.chips.addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    state.category = b.dataset.cat || null; renderChips(); renderFeed();
  });

  function matches(item) {
    if (state.category && item.category !== state.category) return false;
    if (state.majorOnly && item.importance !== 'Major') return false;
    if (state.videosOnly && !item.video_url) return false;
    if (state.q) {
      const hay = [item.headline, item.summary, item.source_name, item.category, ...(item.tags || [])].join(' ').toLowerCase();
      return state.q.split(/\s+/).every(w => hay.includes(w));
    }
    return true;
  }

  function cardHTML(item) {
    const c = CAT_COLOR[item.category] || CAT_COLOR.Other;
    const yt = youtubeId(item.video_url);
    const imp = (item.importance || 'Minor');
    const ago = timeAgo(item.published_at);
    const thumb = yt ? `<a class="thumb" href="${esc(safeUrl(item.video_url))}" target="_blank" rel="noopener" aria-label="Watch video: ${esc(item.headline)}">
        <img loading="lazy" src="https://i.ytimg.com/vi/${yt}/hqdefault.jpg" alt=""><span class="play"><span></span></span></a>` : '';
    const watch = item.video_url ? `<a class="btn watch" href="${esc(safeUrl(item.video_url))}" target="_blank" rel="noopener">Watch on ${esc(platformLabel(item))}</a>` : '';
    const tags = (item.tags || []).slice(0, 5).map(t => `<button class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
    return `<article class="card ${imp === 'Major' ? 'is-major' : ''}" style="--c:${c}" id="${esc(item.id)}">
      ${thumb}
      <div class="card-body">
        <div class="badges"><button class="cat" data-cat="${esc(item.category)}">${esc(item.category)}</button><span class="imp ${imp.toLowerCase()}">${esc(imp)}</span></div>
        <h2><a href="${esc(safeUrl(item.source_url))}" target="_blank" rel="noopener">${esc(item.headline)}</a></h2>
        ${item.summary ? `<p class="summary">${esc(item.summary)}</p>` : ''}
        ${tags ? `<div class="tags">${tags}</div>` : ''}
        <div class="meta"><a class="src" href="${esc(safeUrl(item.source_url))}" target="_blank" rel="noopener">${esc(item.source_name || 'Source')} ↗</a>
          ${item.published_at ? `<span class="sep">•</span><time datetime="${esc(item.published_at)}">${esc(fmtPublished(item.published_at))}</time>` : ''}
          ${ago ? `<span class="sep">•</span><span>${ago}</span>` : ''}</div>
        ${watch ? `<div class="actions">${watch}</div>` : ''}
      </div></article>`;
  }

  function renderFeed() {
    // Major first, then Notable, then Minor; within a tier keep the editor's order from the JSON.
    const all = state.edition.items || [];
    const order = new Map(all.map((it, i) => [it, i]));
    const items = all.filter(matches).sort((a, b) =>
      (IMP_RANK[a.importance] ?? 3) - (IMP_RANK[b.importance] ?? 3) || order.get(a) - order.get(b));
    els.feed.innerHTML = items.map(cardHTML).join('');
    const total = (state.edition.items || []).length;
    const filtered = state.category || state.majorOnly || state.videosOnly || state.q;
    els.count.textContent = filtered ? `Showing ${items.length} of ${total} stories` : `${total} stories · biggest first`;
    els.empty.hidden = items.length > 0;
    els.reset.hidden = !filtered;
    if (typeof updateFab === 'function') updateFab();
  }

  els.feed.addEventListener('click', e => {
    const cat = e.target.closest('.cat');
    if (cat) { state.category = cat.dataset.cat; renderChips(); renderFeed(); window.scrollTo({ top: els.controls.offsetTop - 60, behavior: 'smooth' }); return; }
    const tag = e.target.closest('.tag');
    if (tag) { els.search.value = tag.dataset.tag; state.q = tag.dataset.tag.toLowerCase(); renderFeed(); }
  });

  function setToggle(btn, key) { state[key] = !state[key]; btn.setAttribute('aria-pressed', String(state[key])); renderFeed(); }
  els.major.addEventListener('click', () => setToggle(els.major, 'majorOnly'));
  els.video.addEventListener('click', () => setToggle(els.video, 'videosOnly'));
  let t;
  els.search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.q = els.search.value.trim().toLowerCase(); renderFeed(); }, 120); });
  function resetFilters() {
    Object.assign(state, { category: null, majorOnly: false, videosOnly: false, q: '' });
    els.search.value = ''; els.major.setAttribute('aria-pressed', 'false'); els.video.setAttribute('aria-pressed', 'false');
    renderChips(); renderFeed();
  }
  els.reset.addEventListener('click', resetFilters);
  els.emptyReset.addEventListener('click', resetFilters);

  // Floating "Filters" button once the filter bar scrolls out of view.
  const fab = document.createElement('button');
  fab.className = 'to-filters'; fab.type = 'button'; fab.innerHTML = '&#9776; Filters';
  fab.addEventListener('click', () => { els.controls.scrollIntoView({ behavior: 'smooth' }); setTimeout(() => els.search.focus({ preventScroll: true }), 400); });
  document.body.appendChild(fab);
  // Scroll-driven rather than IntersectionObserver: IO only fires on threshold crossings, so a jump that takes the
  // filter bar from below the viewport straight to above it (fast fling, scroll restore, long page) never showed the button.
  let fabRaf = 0;
  const syncFab = () => { fabRaf = 0; fab.classList.toggle('show', els.controls.getBoundingClientRect().bottom < 0); };
  const queueFab = () => { if (!fabRaf) fabRaf = requestAnimationFrame(syncFab); };
  window.addEventListener('scroll', queueFab, { passive: true });
  window.addEventListener('resize', queueFab);
  function updateFab() {
    const n = (state.category ? 1 : 0) + (state.majorOnly ? 1 : 0) + (state.videosOnly ? 1 : 0) + (state.q ? 1 : 0);
    fab.innerHTML = '&#9776; Filters' + (n ? ` <span class="n">${n}</span>` : '');
  }


  // ---------- Just in (justin/latest.json, refreshed by a ~30-min scan; shown on the latest edition only) ----------
  const justIn = (function () {
    const JI = {
      el: $('#justin'), list: $('#jiList'), more: $('#jiMore'), scanned: $('#jiScanned'), empty: $('#jiEmpty'),
      data: null, lastFetch: 0, expanded: false, prevVisit: null, SHOW: 6, MAX: 30, REFRESH_MS: 5 * 60 * 1000,
      KEY: 'aidaily-justin-visit',
    };
    if (!JI.el) return { onEdition() {} };
    const normUrl = u => String(u || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    const isLatest = () => !!state.edition && state.dates[0] === state.date;
    const newsTab = () => document.documentElement.getAttribute('data-tab') !== 'markets';

    function beginVisit() {
      // "NEW" = found by a scan after your previous visit. First visit ever: nothing is marked.
      let v = null;
      try { v = localStorage.getItem(JI.KEY); } catch (e) {}
      JI.prevVisit = v ? Number(v) || null : null;
    }
    function markVisited() { try { localStorage.setItem(JI.KEY, String(Date.now())); } catch (e) {} }

    function ago(iso) {
      const t = Date.parse(iso);
      if (isNaN(t)) return '';
      const m = Math.max(0, Math.round((Date.now() - t) / 60000));
      if (m < 2) return 'just now';
      if (m < 60) return m + ' min ago';
      const h = Math.floor(m / 60);
      return h < 24 ? h + ' h ago' : Math.floor(h / 24) + ' d ago';
    }
    function scannedLabel(iso) {
      const d = new Date(iso);
      if (isNaN(d)) return '';
      const hm = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
      const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      return 'Last scanned ' + (day === today ? '' : d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }) + ', ') + hm + ' IST';
    }

    // Scans run every ~30 min from 06:10 to 23:40 IST (none overnight). If the newest scan is older than the schedule
    // allows (e.g. GitHub dropped/delayed the scheduled runs), say so instead of presenting old items as "just in".
    function scanIsLate(iso) {
      const t = Date.parse(iso);
      if (isNaN(t)) return false;
      const now = Date.now();
      const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
        .formatToParts(new Date(now)).reduce((o, x) => (o[x.type] = x.value, o), {});
      const istMin = (+p.hour % 24) * 60 + +p.minute;
      // Overnight / first slot not due yet: the last scheduled scan was ~23:40 IST, i.e. (istMin + 20) minutes ago.
      const allowedMin = istMin < 7 * 60 ? istMin + 20 + 90 : 90;
      return now - t > allowedMin * 60000;
    }

    function visibleItems() {
      const cutoff = Date.now() - 24 * 3600 * 1000;
      const inEdition = new Set(((state.edition && state.edition.items) || []).map(i => normUrl(i.source_url)));
      return ((JI.data && JI.data.items) || []).filter(it =>
        it && it.url && it.title && Date.parse(it.published_at) >= cutoff && !inEdition.has(normUrl(it.url))).slice(0, JI.MAX);
    }

    const SHORT_CAT = { 'Model releases': 'Models', 'Research & papers': 'Research', 'Tools & products': 'Tools', 'Big Tech moves': 'Big Tech',
      'Open source': 'Open source', 'Funding & startups': 'Funding', 'Policy & safety': 'Policy', 'Hardware & chips': 'Chips' };
    function itemHTML(it) {
      const c = CAT_COLOR[it.category] || CAT_COLOR.Other;
      const isNew = JI.prevVisit && Date.parse(it.found_at) > JI.prevVisit;
      const sum = it.summary ? `<button class="ji-exp" type="button" aria-expanded="false" aria-label="Show summary"><span aria-hidden="true">&#9662;</span></button>` : '';
      return `<li class="ji-item${isNew ? ' is-new' : ''}">
        <div class="ji-meta">${isNew ? '<span class="ji-new" title="New since your last visit">NEW</span>' : ''}
          ${SHORT_CAT[it.category] ? `<span class="ji-cat" style="--c:${c}" title="${esc(it.category)}">${esc(SHORT_CAT[it.category])}</span>` : ''}
          <a class="ji-src" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener" tabindex="-1">${esc(it.source || 'Source')}</a>
          <span class="sep" aria-hidden="true">·</span><time datetime="${esc(it.published_at)}" title="${esc(fmtPublished(it.published_at))}">${esc(ago(it.published_at))}</time></div>
        <div class="ji-row"><a class="ji-title" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener">${esc(it.title)}</a>${sum}</div>
        ${it.summary ? `<p class="ji-sum" hidden>${esc(it.summary)}</p>` : ''}
      </li>`;
    }

    function render() {
      const show = !!JI.data && isLatest();
      JI.el.hidden = !show;
      if (!show) return;
      const items = visibleItems();
      const n = JI.expanded ? items.length : Math.min(JI.SHOW, items.length);
      JI.list.innerHTML = items.slice(0, n).map(itemHTML).join('');
      JI.empty.hidden = items.length > 0;
      const late = scanIsLate(JI.data.scanned_at);
      JI.scanned.textContent = scannedLabel(JI.data.scanned_at) + (late ? ' · updates delayed' : '');
      JI.el.classList.toggle('is-late', late);
      JI.more.hidden = items.length <= JI.SHOW;
      JI.more.setAttribute('aria-expanded', String(JI.expanded));
      JI.more.textContent = JI.expanded ? 'Show less' : `Show more (${items.length - JI.SHOW})`;
    }

    async function refresh() {
      JI.lastFetch = Date.now();
      try {
        const d = await getJSON('justin/latest.json');
        if (d && Array.isArray(d.items)) JI.data = d;
      } catch (e) { /* not published yet / offline: keep whatever we had (section stays hidden if nothing) */ }
      render();
      markVisited();
    }

    JI.more.addEventListener('click', () => {
      JI.expanded = !JI.expanded; render();
      if (!JI.expanded) JI.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    JI.list.addEventListener('click', e => {
      const b = e.target.closest('.ji-exp'); if (!b) return;
      const p = b.closest('.ji-item').querySelector('.ji-sum'); if (!p) return;
      p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); b.classList.toggle('open', !p.hidden);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - JI.lastFetch < JI.REFRESH_MS) return;
      beginVisit(); refresh(); // back after 5+ min: counts as a new visit for the NEW dots
    });
    setInterval(() => {
      if (document.visibilityState === 'visible' && newsTab()) refresh(); else render();
    }, JI.REFRESH_MS);

    const tabBtn = $('#tab-news');
    if (tabBtn) tabBtn.addEventListener('click', () => { if (Date.now() - JI.lastFetch >= JI.REFRESH_MS) refresh(); });

    beginVisit();
    let started = false;
    return {
      onEdition() {
        if (!started) { started = true; refresh(); } else render();
      },
    };
  })();

  // PWA service worker (only when served over http/https)
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {}));
  }

  init();
})();
