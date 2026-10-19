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
  let reelsApi = null; // set once the Reels module below is ready

  // ---------- tabs (bottom bar: News | Reels | Markets) + #hash routing ----------
  // Hash: #<date> on News/Markets, #reels/<date> on Reels. Entering Reels pushes a history entry, so Back
  // (browser or the Android app's back button) returns to News.
  const root = document.documentElement;
  const curTab = () => root.getAttribute('data-tab') || 'news';
  const scrollMem = {};
  let pendingTab = null;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; // tabs restore their own scroll position
  function hashInfo() {
    const h = location.hash.replace(/^#/, '');
    return { reels: /^reels\b/.test(h), date: (h.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || null };
  }
  const hashFor = date => '#' + (curTab() === 'reels' ? 'reels' + (date ? '/' + date : '') : (date || ''));
  function setHash(date) { const h = hashFor(date); if (location.hash !== h) history.replaceState(history.state, '', h); }
  function setTab(tab, save) {
    const prev = curTab();
    if (prev === tab) return;
    scrollMem[prev] = window.scrollY;
    root.setAttribute('data-tab', tab);
    document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (save && tab !== 'reels') { try { localStorage.setItem('aidaily-tab', tab); } catch (e) {} }
    if (tab === 'reels') { if (reelsApi) reelsApi.open(); } else window.scrollTo(0, scrollMem[tab] || 0);
    document.dispatchEvent(new CustomEvent('aidaily:tab', { detail: { tab, prev } }));
  }
  function goTab(tab) {
    const prev = curTab();
    if (tab === prev) { if (tab === 'reels' && reelsApi) reelsApi.go(0, true); else window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (tab === 'reels') { history.pushState({ aidailyReels: 1 }, '', '#reels' + (state.date ? '/' + state.date : '')); setTab('reels', false); return; }
    if (prev === 'reels' && history.state && history.state.aidailyReels) { pendingTab = tab; history.back(); return; } // pop our entry
    setTab(tab, true);
    setHash(state.date);
  }
  document.querySelectorAll('.tab').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.tab === curTab()));
    b.addEventListener('click', () => goTab(b.dataset.tab));
  });

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

  // ---------- share (native Android sheet via the app bridge -> Web Share API -> copy to clipboard) ----------
  const SITE_URL = 'https://ainews.swansi.site/';
  const VIA = 'via AI Daily ' + SITE_URL;
  const SHARE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 15.2c-1 0-1.9.4-2.5 1.1l-6.1-3.5c.1-.3.1-.5.1-.8s0-.5-.1-.8L15 7.7c.6.7 1.5 1.1 2.5 1.1 1.9 0 3.4-1.5 3.4-3.4S19.4 2 17.5 2 14.1 3.5 14.1 5.4c0 .3 0 .5.1.8L8.1 9.7C7.5 9 6.6 8.6 5.6 8.6 3.7 8.6 2.2 10.1 2.2 12s1.5 3.4 3.4 3.4c1 0 1.9-.4 2.5-1.1l6.1 3.5c-.1.3-.1.5-.1.8 0 1.9 1.5 3.4 3.4 3.4s3.4-1.5 3.4-3.4-1.5-3.4-3.4-3.4Z"/></svg>';
  function clip(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (s.length <= n) return s;
    const cut = s.slice(0, n), sp = cut.lastIndexOf(' ');
    return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…';
  }
  const httpUrl = u => (/^https?:\/\/[^\s]+$/i.test(u || '') ? String(u) : '');
  /** Share payload for one story: title, short summary + "via AI Daily", article URL. */
  function storyShare(title, summary, url) {
    return { title: clip(title, 200), text: [clip(summary, 280), VIA].filter(Boolean).join('\n\n'), url: httpUrl(url) };
  }
  const shareAttrs = p => `data-share-title="${esc(p.title)}" data-share-text="${esc(p.text)}" data-share-url="${esc(p.url)}"`;
  const shareBtn = (p, label) => `<button type="button" class="share-btn" ${shareAttrs(p)} aria-label="${esc(label)}" title="Share">${SHARE_ICON}</button>`;
  const plainShare = p => [p.title, p.url].filter(Boolean).join('\n') + (p.text ? '\n\n' + p.text : '');

  let toastT = 0;
  function toast(msg) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
  }
  async function copyText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall through */ }
    try { // older Android WebViews: no async clipboard API (or permission denied)
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (e) { return false; }
  }
  /** 1) AI Daily Android app bridge (v1.4+)  2) Web Share API  3) copy title + link + summary and say so. */
  async function share(p) {
    const br = window.AIDailyAndroid;
    if (br && typeof br.share === 'function') {
      try { if (br.share(p.title, p.text, p.url) !== false) return 'native'; } catch (e) { /* fall back */ }
    }
    if (typeof navigator.share === 'function') {
      const data = { title: p.title, text: p.title + '\n\n' + p.text };
      if (p.url) data.url = p.url;
      if (!navigator.canShare || navigator.canShare(data)) {
        try { await navigator.share(data); return 'web'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
      }
    }
    if (await copyText(plainShare(p))) { toast('Link copied'); return 'copied'; }
    toast("Couldn't copy the link"); return 'failed';
  }
  // One capture-phase handler for every share button: it runs before the card / list handlers and stops the click there,
  // so sharing never toggles a summary, applies a filter or follows a link.
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-share-title]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    share({ title: b.dataset.shareTitle || '', text: b.dataset.shareText || '', url: b.dataset.shareUrl || '' });
  }, true);
  // Android app: while a touch starts inside a scrolled inner box (Just in), ask the wrapper not to pull-to-refresh.
  (function () {
    let blocked = false;
    const set = v => { const br = window.AIDailyAndroid; if (v !== blocked && br && typeof br.setRefreshBlocked === 'function') { blocked = v; try { br.setRefreshBlocked(v); } catch (e) {} } };
    document.addEventListener('touchstart', e => { const l = e.target.closest && e.target.closest('.ji-box.scrolls .ji-list'); set(!!l && l.scrollTop > 0); }, { passive: true, capture: true });
    document.addEventListener('touchend', () => set(false), { passive: true, capture: true });
    document.addEventListener('touchcancel', () => set(false), { passive: true, capture: true });
  })();

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

    const h0 = hashInfo();
    const want = h0.date && state.dates.includes(h0.date) ? h0.date : null;
    if (h0.reels) {
      // Deep link to #reels: put a News entry underneath so Back (incl. the Android back button) returns to News.
      history.replaceState(null, '', '#' + (want || ''));
      history.pushState({ aidailyReels: 1 }, '', '#reels' + (want ? '/' + want : ''));
    }
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
      setHash(ed.date);
      updateNav();
      renderEdition();
    } catch (e) {
      els.error.hidden = false;
      if (state.edition) {
        // Keep showing the edition that is already on screen, and put the picker/URL back to match it
        // (otherwise the header says e.g. "Sat, 26 Sept" while the page still shows the 29th).
        els.dateSelect.value = state.date;
        setHash(state.date);
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
    const h = hashInfo();
    // Back from Reels (or a hand-edited #reels) switches the tab to match the URL.
    if (h.reels && curTab() !== 'reels') setTab('reels', false);
    else if (!h.reels && curTab() === 'reels') setTab(pendingTab || 'news', !!pendingTab);
    pendingTab = null;
    if (h.date && h.date !== state.date && state.dates.includes(h.date)) loadEdition(h.date);
    else if (state.date) setHash(state.date); // no edition for that date: keep URL = what's shown
  });

  // ---------- render ----------
  function renderEdition() {
    const ed = state.edition;
    const items = ed.items || [];
    els.editionDate.textContent = fmtEditionDate(ed.date) + (state.dates[0] === ed.date ? ' · Latest' : '');
    els.highlights.innerHTML = (ed.highlights || []).map(h => `<li>${esc(h)}</li>`).join('');
    const sb = $('#shareEdition');
    if (sb) {
      const p = { title: `AI Daily · ${fmtShortDate(ed.date)}: today in 60 seconds`,
        text: (ed.highlights || []).slice(0, 4).map(h => '• ' + clip(h, 200)).join('\n'), url: SITE_URL + '#' + ed.date };
      sb.dataset.shareTitle = p.title; sb.dataset.shareText = p.text; sb.dataset.shareUrl = p.url;
      if (!sb.firstChild) sb.innerHTML = SHARE_ICON;
      sb.hidden = false;
    }
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
        <img loading="lazy" src="https://i.ytimg.com/vi/${yt}/hqdefault.jpg" alt="" referrerpolicy="no-referrer"><span class="play"><span></span></span></a>` : '';
    // small preview from the article (og:image) when there is no video thumbnail; dropped if it fails to load
    const pic = !yt && httpUrl(item.image_url);
    const head = `<h2><a href="${esc(safeUrl(item.source_url))}" target="_blank" rel="noopener">${esc(item.headline)}</a></h2>`;
    const headHTML = pic ? `<div class="card-head">${head}<a class="card-img" href="${esc(safeUrl(item.source_url))}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true"><img src="${esc(pic)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a></div>` : head;
    const watch = item.video_url ? `<a class="btn watch" href="${esc(safeUrl(item.video_url))}" target="_blank" rel="noopener">Watch on ${esc(platformLabel(item))}</a>` : '';
    const tags = (item.tags || []).slice(0, 5).map(t => `<button class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
    return `<article class="card ${imp === 'Major' ? 'is-major' : ''}" style="--c:${c}" id="${esc(item.id)}">
      ${thumb}
      <div class="card-body">
        <div class="badges"><button class="cat" data-cat="${esc(item.category)}">${esc(item.category)}</button><span class="imp ${imp.toLowerCase()}">${esc(imp)}</span>${shareBtn(storyShare(item.headline, item.summary, item.source_url), 'Share: ' + item.headline)}</div>
        ${headHTML}
        ${item.summary ? `<p class="summary">${esc(item.summary)}</p>` : ''}
        ${tags ? `<div class="tags">${tags}</div>` : ''}
        <div class="meta"><a class="src" href="${esc(safeUrl(item.source_url))}" target="_blank" rel="noopener">${esc(item.source_name || 'Source')} ↗</a>
          ${item.published_at ? `<span class="sep">•</span><time datetime="${esc(item.published_at)}">${esc(fmtPublished(item.published_at))}</time>` : ''}
          ${ago ? `<span class="sep">•</span><span>${ago}</span>` : ''}</div>
        ${watch ? `<div class="actions">${watch}</div>` : ''}
      </div></article>`;
  }

  const isFiltered = () => !!(state.category || state.majorOnly || state.videosOnly || state.q);
  function feedItems() {
    // Major first, then Notable, then Minor; within a tier keep the editor's order from the JSON.
    const all = (state.edition && state.edition.items) || [];
    const order = new Map(all.map((it, i) => [it, i]));
    return all.filter(matches).sort((a, b) =>
      (IMP_RANK[a.importance] ?? 3) - (IMP_RANK[b.importance] ?? 3) || order.get(a) - order.get(b));
  }
  function renderFeed() {
    const items = feedItems();
    els.feed.innerHTML = items.map(cardHTML).join('');
    const total = (state.edition.items || []).length;
    const filtered = isFiltered();
    els.count.textContent = filtered ? `Showing ${items.length} of ${total} stories` : `${total} stories · biggest first`;
    els.empty.hidden = items.length > 0;
    els.reset.hidden = !filtered;
    if (typeof updateFab === 'function') updateFab();
    if (reelsApi) reelsApi.update();
  }

  // article previews that fail to load (or are tracking-pixel sized) are removed; the headline takes the full width
  const dropCardImg = img => { const a = img.closest('.card-img'); if (a) a.remove(); };
  els.feed.addEventListener('error', e => { if (e.target.tagName === 'IMG') dropCardImg(e.target); }, true);
  els.feed.addEventListener('load', e => { const t = e.target; if (t.tagName === 'IMG' && t.naturalWidth < 40) dropCardImg(t); }, true);
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
      el: $('#justin'), box: $('#jiBox'), list: $('#jiList'), hint: $('#jiHint'), scanned: $('#jiScanned'), empty: $('#jiEmpty'),
      data: null, lastFetch: 0, prevVisit: null, SHOW: 3, PEEK: 7, MAX: 30, REFRESH_MS: 5 * 60 * 1000, fitW: 0,
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
        <div class="ji-row"><a class="ji-title" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener">${esc(it.title)}</a>${sum}${shareBtn(storyShare(it.title, it.summary, it.url), 'Share: ' + it.title)}</div>
        ${it.summary ? `<p class="ji-sum" hidden>${esc(it.summary)}</p>` : ''}
      </li>`;
    }

    // All items (newest first) live in a scroll box sized to show exactly the newest SHOW (3); the rest scroll inside it.
    // The height is measured from the first 3 rendered items, so it follows font size, wrapping, viewport and theme.
    function fit() {
      const lis = JI.list.children;
      const w = JI.list.clientWidth;
      if (!w) return; // hidden (Markets tab / not the latest edition): ResizeObserver refits once it is visible
      JI.fitW = w;
      const scrolls = lis.length > JI.SHOW;
      JI.box.classList.toggle('scrolls', scrolls);
      if (!scrolls) { JI.list.style.maxHeight = ''; JI.list.removeAttribute('tabindex'); updateFade(); return; }
      const last = lis[JI.SHOW - 1];
      // + PEEK px: just the 4th item's top padding (no text), so the bottom fade sits below the 3rd item's text.
      const h = Math.ceil(last.offsetTop + last.offsetHeight) + JI.PEEK; // offsetParent is the (position:relative) list
      if (JI.list.style.maxHeight !== h + 'px') JI.list.style.maxHeight = h + 'px';
      JI.list.tabIndex = 0; // keyboard scrolling
      updateFade();
    }
    function updateFade() {
      const l = JI.list;
      const left = l.scrollHeight - l.clientHeight - l.scrollTop;
      const more = JI.box.classList.contains('scrolls') && left > 2;
      JI.box.classList.toggle('more', more);
      const hidden = Math.max(0, JI.list.children.length - JI.SHOW);
      JI.hint.hidden = !hidden;
      if (hidden) JI.hint.textContent = more ? `Scroll for ${hidden} more` : `${JI.list.children.length} stories`;
    }

    function render() {
      const show = !!JI.data && isLatest();
      JI.el.hidden = !show;
      if (!show) return;
      const items = visibleItems();
      const top = JI.list.scrollTop;
      JI.list.innerHTML = items.map(itemHTML).join('');
      JI.empty.hidden = items.length > 0;
      JI.box.hidden = !items.length;
      const late = scanIsLate(JI.data.scanned_at);
      JI.scanned.textContent = scannedLabel(JI.data.scanned_at) + (late ? ' · updates delayed' : '');
      JI.el.classList.toggle('is-late', late);
      fit();
      JI.list.scrollTop = top; // a periodic refresh must not yank the box back to the top while you read
      updateFade();
      if (reelsApi) reelsApi.update();
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

    JI.list.addEventListener('click', e => {
      const b = e.target.closest('.ji-exp'); if (!b) return;
      const li = b.closest('.ji-item'), p = li.querySelector('.ji-sum'); if (!p) return;
      p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); b.classList.toggle('open', !p.hidden);
      // The box keeps its height; scroll inside it (never the page) so the opened summary is in view.
      const l = JI.list, over = li.offsetTop + li.offsetHeight - (l.scrollTop + l.clientHeight);
      if (!p.hidden && over > 0) l.scrollTop += Math.min(over, li.offsetTop - l.scrollTop);
      updateFade();
    });
    JI.list.addEventListener('scroll', updateFade, { passive: true });
    // Refit when the width changes (rotation, resize, becoming visible) or the theme/fonts change.
    if (window.ResizeObserver) new ResizeObserver(() => { if (JI.list.clientWidth !== JI.fitW) fit(); }).observe(JI.list);
    window.addEventListener('resize', fit, { passive: true });
    new MutationObserver(fit).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-tab'] });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
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
      items: () => (JI.data && isLatest() ? visibleItems() : []),
      ago,
    };
  })();

  // ---------- Reels: the same stories as full-screen vertical cards ----------
  // The document itself scrolls (scroll-snap on <html>), not an inner box: keyboard/screen readers work as usual and the
  // Android app's pull-to-refresh only engages on the first card (it checks the page's scroll position).
  reelsApi = (function () {
    const R = { list: $('#reelList'), empty: $('#reelEmpty'), emptyText: $('#reelEmptyText'), reset: $('#reelReset'), dirty: true, key: '', idx: 0 };
    if (!R.list) return { open() {}, update() {}, go() {} };
    const ICON = {
      open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3ZM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>',
      play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.1v13.8c0 .8.9 1.3 1.6.9l10.6-6.9c.6-.4.6-1.3 0-1.7L9.6 4.2C8.9 3.8 8 4.3 8 5.1Z"/></svg>',
    };
    const cards = () => R.list.children;
    function items() {
      const ed = feedItems().map(it => ({ ji: false, it }));
      return isFiltered() ? ed : ed.concat(justIn.items().map(it => ({ ji: true, it })));
    }
    function reelHTML(x, i, n, edLabel) {
      const it = x.it;
      const title = x.ji ? it.title : it.headline, url = x.ji ? it.url : it.source_url, src = x.ji ? it.source : it.source_name;
      const when = x.ji ? justIn.ago(it.published_at) : (timeAgo(it.published_at) || fmtPublished(it.published_at));
      const cat = it.category || 'Other', c = CAT_COLOR[cat] || CAT_COLOR.Other;
      const imp = !x.ji && it.importance && it.importance !== 'Minor' ? it.importance : '';
      const yt = !x.ji && youtubeId(it.video_url);
      // video thumbnail first (it is what Play opens), else the article's preview image (editions + Just in)
      const img = (yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : '') || httpUrl(it.image_url);
      const video = !x.ji ? httpUrl(it.video_url) : '';
      const href = esc(safeUrl(url));
      return `<article class="reel${img ? ' has-img' : ''}" style="--c:${c}" data-i="${i}" aria-roledescription="reel" aria-label="${esc(`Story ${i + 1} of ${n}`)}">
        ${img ? `<div class="reel-bg" aria-hidden="true"><img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></div>` : ''}
        <div class="reel-frame">
          <div class="reel-top"><span class="reel-brand">${x.ji ? 'Just in' : esc(edLabel)}</span><span class="reel-count" aria-hidden="true">${i + 1} / ${n}</span></div>
          ${img ? `<a class="reel-media" href="${esc(video || safeUrl(url))}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true"><img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">${video ? '<span class="play"><span></span></span>' : ''}</a>` : ''}
          <div class="reel-main">
            <div class="reel-text">
              <div class="reel-badges"><span class="reel-cat">${esc(cat)}</span>${imp ? `<span class="imp ${imp.toLowerCase()}">${esc(imp)}</span>` : ''}${x.ji ? '<span class="reel-ji">Just in</span>' : ''}</div>
              <h2 class="reel-title"><a href="${href}" target="_blank" rel="noopener">${esc(title)}</a></h2>
              ${it.summary ? `<p class="reel-sum">${esc(it.summary)}</p>` : ''}
              <p class="reel-meta">${esc(src || 'Source')}${when ? ' · ' + esc(when) : ''}</p>
            </div>
            <div class="reel-actions">
              <button type="button" class="reel-act" ${shareAttrs(storyShare(title, it.summary, url))} aria-label="${esc('Share: ' + title)}">${SHARE_ICON}<span>Share</span></button>
              <a class="reel-act" href="${href}" target="_blank" rel="noopener" aria-label="${esc('Open article: ' + title)}">${ICON.open}<span>Open</span></a>
              ${video ? `<a class="reel-act play" href="${esc(video)}" target="_blank" rel="noopener" aria-label="${esc('Play video: ' + title)}">${ICON.play}<span>Play</span></a>` : ''}
            </div>
          </div>
        </div>
      </article>`;
    }
    function render() {
      const list = items(), n = list.length;
      const edLabel = 'AI Daily' + (state.date ? ' · ' + fmtShortDate(state.date) : '') + (isFiltered() ? ' · filtered' : '');
      R.list.innerHTML = list.map((x, i) => reelHTML(x, i, n, edLabel)).join('');
      R.empty.hidden = n > 0;
      if (!n) {
        R.emptyText.textContent = !state.edition ? 'Loading stories…' : isFiltered() ? 'No stories match your filters.' : 'No stories in this edition.';
        R.reset.hidden = !isFiltered();
      }
      R.dirty = false;
    }
    function current() {
      const cs = cards(); if (!cs.length) return 0;
      const h = cs[0].offsetHeight || window.innerHeight;
      return Math.max(0, Math.min(cs.length - 1, Math.round((window.scrollY - cs[0].offsetTop) / h)));
    }
    function go(i, smooth) {
      const cs = cards(); if (!cs.length) { window.scrollTo(0, 0); return; }
      R.idx = Math.max(0, Math.min(cs.length - 1, i));
      window.scrollTo({ top: cs[R.idx].offsetTop, behavior: smooth ? 'smooth' : 'auto' });
    }
    function update() {
      const key = state.date + '|' + isFiltered();
      if (key !== R.key) { R.key = key; R.idx = 0; }
      R.dirty = true;
      if (curTab() === 'reels') { const i = R.idx; render(); go(i, false); }
    }
    function open() {
      if (R.dirty) render();
      const i = R.idx;
      go(i, false); requestAnimationFrame(() => go(i, false)); // again after layout (first open / fonts)
    }
    let raf = 0;
    window.addEventListener('scroll', () => {
      if (curTab() !== 'reels' || raf) return;
      raf = requestAnimationFrame(() => { raf = 0; R.idx = current(); });
    }, { passive: true });
    document.addEventListener('keydown', e => {
      if (curTab() !== 'reels' || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target.closest && e.target.closest('input,select,textarea')) return;
      const k = e.key, i = current();
      if (k === ' ' && e.target.closest && e.target.closest('button,a')) return; // Space activates the focused action
      if (k === 'ArrowDown' || k === 'PageDown' || k === 'j' || (k === ' ' && !e.shiftKey)) go(i + 1, true);
      else if (k === 'ArrowUp' || k === 'PageUp' || k === 'k' || (k === ' ' && e.shiftKey)) go(i - 1, true);
      else if (k === 'Home') go(0, false); // long jumps: no smooth animation through dozens of cards
      else if (k === 'End') go(cards().length - 1, false);
      else if (k === 'Escape') goTab('news');
      else return;
      e.preventDefault();
    });
    // Mouse wheel / trackpad on desktop: one card per gesture (a single wheel notch would otherwise snap back).
    let wheelLock = 0;
    window.addEventListener('wheel', e => {
      if (curTab() !== 'reels' || e.ctrlKey || Math.abs(e.deltaY) < 4 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const now = Date.now(); if (now < wheelLock) return;
      wheelLock = now + 600;
      go(current() + (e.deltaY > 0 ? 1 : -1), true);
    }, { passive: false });
    // Images that fail (offline, hotlink-blocked, removed) or are tracking-pixel sized: fall back to the gradient card.
    const dropImg = img => {
      const reel = img.closest('.reel'); if (!reel) return;
      reel.classList.remove('has-img');
      reel.querySelectorAll('.reel-bg,.reel-media').forEach(n => n.remove());
    };
    R.list.addEventListener('error', e => { if (e.target.tagName === 'IMG') dropImg(e.target); }, true);
    R.list.addEventListener('load', e => { const t = e.target; if (t.tagName === 'IMG' && t.naturalWidth < 40) dropImg(t); }, true);
    R.reset.addEventListener('click', () => { resetFilters(); });
    window.addEventListener('resize', () => { if (curTab() === 'reels') go(R.idx, false); });
    return { open, update, go };
  })();
  if (curTab() === 'reels') reelsApi.open();

  // PWA service worker (only when served over http/https)
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {}));
  }

  init();
})();
