/* AI Daily — Markets tab. Reads the daily snapshot (markets/latest.json, markets/<date>.json) written by the
   markets workflow, and the Sync button overlays live quotes from CORS-open public feeds (TradingView scanner,
   Binance, CoinGecko). No keys, no frameworks. Never invents numbers: anything that fails keeps its last value
   with its own timestamp. */
(function () {
  'use strict';
  const DIR = 'markets';
  const TV_URL = 'https://scanner.tradingview.com/global/scan';
  const TV_COLS = ['close', 'change', 'change_abs', 'high', 'low', 'open', 'update_mode', 'current_session', 'update_time'];
  const SESSION = { market: 'open', out_of_session: 'closed', pre_market: 'pre', post_market: 'post' };
  const $ = s => document.querySelector(s);
  const root = document.documentElement;
  const els = {
    body: $('#mktBody'), status: $('#mktStatus'), sync: $('#syncBtn'), date: $('#mktDate'), err: $('#mktError'),
    sel: $('#mktDateSelect'), prev: $('#mktPrev'), next: $('#mktNext'),
  };
  const st = { dates: [], date: null, snap: null, loaded: false, syncing: false, lastSync: 0, isLatest: true };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- formatting (Indian digit grouping; times in IST) ----------
  function fmtNum(v, dp) {
    if (v == null || !isFinite(v)) return '—';
    return Number(v).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function istParts(d) {
    const f = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
    return f.format(d);
  }
  function fmtTime(epochSec, withDay) {
    if (!epochSec) return '';
    const d = new Date(epochSec * 1000);
    const sameDay = istParts(d) === istParts(new Date());
    const opts = { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true };
    if (withDay !== false && !sameDay) { opts.day = 'numeric'; opts.month = 'short'; }
    return d.toLocaleString('en-IN', opts).replace(/\bam\b/i, 'AM').replace(/\bpm\b/i, 'PM');
  }
  function fmtDay(iso, long) {
    const d = new Date(iso + 'T12:00:00+05:30');
    return d.toLocaleDateString('en-IN', long ? { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long' }
      : { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
  }
  const STATE_LABEL = { open: 'Open', closed: 'Closed', pre: 'Pre-open', post: 'After hours', '24x7': '24×7' };

  function changeHTML(r, compact) {
    if (r.change == null || r.change_pct == null) return '<span class="chg flat">—</span>';
    const dir = r.change > 0 ? 'up' : r.change < 0 ? 'down' : 'flat';
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■';
    const pct = Math.abs(r.change_pct).toFixed(2) + '%';
    const abs = fmtNum(Math.abs(r.change), r.dp);
    return compact
      ? `<span class="chg ${dir}"><span aria-hidden="true">${arrow}</span> ${pct}</span>`
      : `<span class="chg ${dir}"><span aria-hidden="true">${arrow}</span> ${abs} <span class="pct">(${dir === 'down' ? '−' : dir === 'up' ? '+' : ''}${pct})</span></span>`;
  }
  function sparkSVG(r, w, h) {
    const vals = (r.spark || []).filter(v => v != null && isFinite(v));
    if (vals.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const base = r.spark_src === 'intraday 5m' ? r.prev_close : null;
    if (base && base > lo - (hi - lo) * 0.6 && base < hi + (hi - lo) * 0.6) { lo = Math.min(lo, base); hi = Math.max(hi, base); }
    const span = hi - lo || 1, pad = 2;
    const x = i => (i / (vals.length - 1)) * (w - 2 * pad) + pad;
    const y = v => h - pad - ((v - lo) / span) * (h - 2 * pad);
    const pts = vals.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    const dir = (r.change || 0) >= 0 ? 'up' : 'down';
    const bl = base ? `<line class="base" x1="0" x2="${w}" y1="${y(base).toFixed(1)}" y2="${y(base).toFixed(1)}"/>` : '';
    return `<svg class="spark ${dir}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${bl}<polyline points="${pts}"/></svg>`;
  }
  function tagHTML(r) {
    if (r.stale) return '<span class="qtag stale">Unavailable · last known</span>';
    if (r.converted || r.delay === 'converted') return '<span class="qtag conv">Converted</span>';
    if (r.delay === 'live') return '<span class="qtag live">Live</span>';
    if (/^\d+m delay$/.test(r.delay || '')) return `<span class="qtag">${esc(r.delay.replace(' delay', ''))} delay</span>`;
    return '<span class="qtag">Delayed</span>';
  }
  function metaLine(r) {
    const s = r.state ? `<span class="sdot ${esc(r.state === 'pre' || r.state === 'post' ? 'pre' : r.state === '24x7' ? 'open' : r.state)}"></span>${esc(STATE_LABEL[r.state] || '')}` : '';
    const t = r.as_of ? `<time>${esc(fmtTime(r.as_of))}</time>` : '';
    return [s, t].filter(Boolean).join(' · ') + ' ' + tagHTML(r);
  }
  function titleAttr(r) {
    const bits = [r.source ? 'Source: ' + r.source : '', r.prev_close != null ? 'Prev close: ' + fmtNum(r.prev_close, r.dp) : '',
      r.basis === '24h' ? 'Change vs 24h ago' : '', r.note || ''];
    return esc(bits.filter(Boolean).join(' · '));
  }
  const unit = r => (r.unit === '₹' || r.unit === '$' ? r.unit : '');

  function heroCard(r) {
    const range = r.high != null && r.low != null ? `<span class="rng">L ${fmtNum(r.low, r.dp)} · H ${fmtNum(r.high, r.dp)}</span>` : '';
    return `<article class="mcard" title="${titleAttr(r)}">
      <div class="mc-top"><h3>${esc(r.name)}</h3></div>
      <p class="mc-sub">${esc(r.sub || '')}</p>
      <p class="mc-price">${r.price == null ? '—' : fmtNum(r.price, r.dp)}</p>
      ${changeHTML(r)}
      ${sparkSVG(r, 150, 34)}
      ${range}
      <p class="mc-meta">${metaLine(r)}</p>
    </article>`;
  }
  function row(r, label) {
    return `<div class="mrow" title="${titleAttr(r)}">
      <div class="mr-name"><span class="n">${esc(label || r.name)}</span><span class="m">${metaLine(r)}</span></div>
      ${sparkSVG(r, 64, 26)}
      <div class="mr-val"><span class="p">${r.price == null ? '—' : unit(r) + fmtNum(r.price, r.dp)}</span>${changeHTML(r, true)}</div>
    </div>`;
  }

  function render() {
    const s = st.snap;
    if (!s) return;
    const I = s.instruments || {};
    const html = (s.groups || []).map(g => {
      let inner = '';
      if (g.style === 'hero') {
        const [heroIds, restIds] = [g.items.slice(0, 4), g.items.slice(4)];
        inner = `<div class="mgrid">${heroIds.filter(id => I[id]).map(id => heroCard(I[id])).join('')}</div>`
          + (restIds.length ? `<div class="mlist">${restIds.filter(id => I[id]).map(id => row(I[id], I[id].name)).join('')}</div>` : '');
      } else if (g.style === 'combo') {
        inner = `<div class="mcombo">${g.cards.map(c => `<div class="ccard"><h3>${esc(c.title)}</h3>${c.items.filter(id => I[id]).map(id => row(I[id], I[id].sub)).join('')}</div>`).join('')}</div>`;
      } else {
        inner = `<div class="mlist">${g.items.filter(id => I[id]).map(id => row(I[id], I[id].name)).join('')}</div>`;
      }
      return `<section class="mgroup mg-${esc(g.id)}" aria-label="${esc(g.title)}"><h2>${esc(g.title)}</h2>${inner}</section>`;
    }).join('');
    els.body.innerHTML = html;
    els.date.textContent = 'Markets · ' + fmtDay(s.date) + (st.isLatest ? '' : ' · Archive');
  }

  function setStatus(html, kind) {
    els.status.innerHTML = html;
    els.status.className = 'mkt-status' + (kind ? ' ' + kind : '');
  }
  function snapStatus() {
    const s = st.snap; if (!s) return;
    const g = Date.parse(s.generated_at) / 1000;
    if (st.isLatest) setStatus(`Snapshot saved <b>${esc(fmtTime(g))} IST</b>. Tap Sync for the latest quotes.`);
    else setStatus(`Daily snapshot for <b>${esc(fmtDay(s.date))}</b>, last saved ${esc(fmtTime(g))} IST. Sync returns to today.`);
  }

  // ---------- data ----------
  async function getJSON(path) {
    const res = await fetch(path + (path.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status + ' loading ' + path);
    return res.json();
  }
  function withTimeout(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

  async function loadIndex() {
    try {
      const idx = await getJSON(DIR + '/index.json');
      st.dates = (idx.dates || []).slice().sort().reverse();
    } catch (e) { /* latest.json alone still works */ }
    els.sel.innerHTML = st.dates.map(d => `<option value="${d}">${esc(fmtDay(d))}</option>`).join('');
  }
  function updateNav() {
    const i = st.dates.indexOf(st.date);
    els.prev.disabled = i < 0 || i >= st.dates.length - 1;
    els.next.disabled = i <= 0;
    if (st.date) els.sel.value = st.date;
  }
  async function loadSnapshot(date) {
    els.err.hidden = true;
    const latest = !date || date === st.dates[0];
    const snap = await getJSON(latest ? DIR + '/latest.json' : `${DIR}/${date}.json`);
    st.snap = snap; st.date = snap.date; st.isLatest = latest || snap.date === st.dates[0];
    if (!st.dates.includes(snap.date)) { st.dates.unshift(snap.date); st.dates.sort().reverse(); els.sel.innerHTML = st.dates.map(d => `<option value="${d}">${esc(fmtDay(d))}</option>`).join(''); }
    updateNav(); render();
    return snap;
  }

  async function liveTV(symbols) {
    // text/plain keeps this a "simple" CORS request (no preflight); the scanner answers with the page's origin.
    const res = await fetch(TV_URL, { method: 'POST', body: JSON.stringify({ symbols: { tickers: symbols }, columns: TV_COLS }),
      headers: { 'Content-Type': 'text/plain' }, signal: withTimeout(9000), credentials: 'omit' });
    if (!res.ok) throw new Error('TradingView ' + res.status);
    const d = await res.json(), out = {};
    (d.data || []).forEach(rw => {
      const v = Object.fromEntries(TV_COLS.map((c, i) => [c, (rw.d || [])[i]]));
      if (!(v.close > 0)) return;
      const mode = v.update_mode || '';
      out[rw.s] = { price: v.close, prev_close: v.change_abs != null ? v.close - v.change_abs : null, high: v.high, low: v.low,
        as_of: v.update_time || Math.floor(Date.now() / 1000), state: SESSION[v.current_session] || null,
        delay: mode === 'streaming' ? 'live' : (/delayed_streaming_(\d+)/.test(mode) ? Math.round(+RegExp.$1 / 60) + 'm delay' : 'delayed'),
        source: 'TradingView ' + rw.s + ' (synced)' };
    });
    return out;
  }
  async function liveBinance(sym) {
    for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
      try {
        const res = await fetch(`${host}/api/v3/ticker/24hr?symbol=${sym}`, { signal: withTimeout(7000), credentials: 'omit' });
        if (!res.ok) continue;
        const d = await res.json(); const p = +d.lastPrice;
        if (p > 0) return { price: p, prev_close: p - (+d.priceChange), high: +d.highPrice, low: +d.lowPrice, as_of: Math.floor(d.closeTime / 1000),
          state: '24x7', delay: 'live', basis: '24h', source: 'Binance ' + sym + ' (synced)' };
      } catch (e) { /* try next host */ }
    }
    throw new Error('Binance unreachable');
  }
  async function liveCoinGeckoINR() {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=inr&include_24hr_change=true&include_last_updated_at=true',
      { signal: withTimeout(7000), credentials: 'omit' });
    if (!res.ok) throw new Error('CoinGecko ' + res.status);
    const b = (await res.json()).bitcoin || {};
    if (!(b.inr > 0)) throw new Error('CoinGecko: no price');
    return { price: b.inr, prev_close: b.inr_24h_change != null ? b.inr / (1 + b.inr_24h_change / 100) : null, as_of: b.last_updated_at,
      state: '24x7', delay: 'live', basis: '24h', source: 'CoinGecko bitcoin/inr (synced)' };
  }

  function sane(r, q) {
    if (!(q && q.price > 0)) return false;
    if (q.prev_close && Math.abs(q.price / q.prev_close - 1) > 0.25) return false;
    if (r.price && Math.abs(q.price / r.price - 1) > 0.3) return false; // wildly off the snapshot: ignore
    return true;
  }
  function apply(r, q) {
    const dp = r.dp;
    const merged = Object.assign({}, r, q);
    if (q.prev_close) { merged.change = q.price - q.prev_close; merged.change_pct = merged.change / q.prev_close * 100; }
    else { merged.change = null; merged.change_pct = null; }
    merged.high = q.high > 0 ? q.high : r.high; merged.low = q.low > 0 ? q.low : r.low;
    if (!q.state) merged.state = r.state;
    // Unchanged since the snapshot (e.g. market closed): keep the snapshot's quote time, which is the real last trade.
    if (r.as_of && r.price != null && Math.abs(q.price - r.price) < 1e-9) merged.as_of = r.as_of;
    merged.stale = false; merged.note = ''; merged.converted = false;
    if ((r.spark || []).length && (!r.as_of || q.as_of > r.as_of) && merged.price !== r.spark[r.spark.length - 1]) merged.spark = r.spark.concat([+merged.price.toFixed(dp + 2)]).slice(-80);
    return merged;
  }

  async function sync() {
    if (st.syncing) return;
    st.syncing = true;
    els.sync.classList.add('busy'); els.sync.disabled = true; els.sync.querySelector('.sync-label').textContent = 'Syncing';
    setStatus('Fetching the latest quotes…');
    els.err.hidden = true;
    let snapErr = null;
    try {
      await loadIndex();
      await loadSnapshot(null);
    } catch (e) { snapErr = e; }
    if (!st.snap) {
      els.err.hidden = false; els.err.textContent = 'Could not load the markets snapshot (' + (snapErr && snapErr.message) + ').';
    }
    const snap = st.snap ? JSON.parse(JSON.stringify(st.snap)) : null;
    let liveOK = 0, total = 0;
    const failures = [];
    if (snap) {
      const I = snap.instruments;
      const tvSyms = Object.values(I).map(r => r.live && r.live.tv).filter(Boolean);
      const [tv, bn, cg] = await Promise.allSettled([liveTV(tvSyms), liveBinance('BTCUSDT'), liveCoinGeckoINR()]);
      if (tv.status === 'rejected') failures.push('TradingView');
      if (bn.status === 'rejected') failures.push('Binance');
      Object.values(I).forEach(r => {
        total++;
        let q = null;
        if (r.live && r.live.binance && bn.status === 'fulfilled') q = bn.value;
        else if (r.live && r.live.coingecko && cg.status === 'fulfilled') q = cg.value;
        if (!q && r.live && r.live.tv && tv.status === 'fulfilled') q = tv.value[r.live.tv];
        if (sane(r, q)) { I[r.id] = apply(r, q); liveOK++; }
      });
      // INR conversions for anything that had no direct live quote (e.g. BTC/INR when CoinGecko rate-limits).
      Object.values(I).forEach(r => {
        const cv = r.convert; if (!cv) return;
        const direct = r.source && /\(synced\)$/.test(r.source);
        if (direct) return;
        const b = I[cv.from], fx = I.usdinr;
        if (!(b && fx && b.price && fx.price && /\(synced\)$/.test(b.source || ''))) return;
        const q = { price: b.price * fx.price * cv.factor, prev_close: b.prev_close && fx.prev_close ? b.prev_close * fx.prev_close * cv.factor : null,
          as_of: b.as_of, state: b.state, delay: 'converted', basis: b.basis, source: 'Converted: ' + cv.note + ' (synced)' };
        if (sane(r, q)) { I[r.id] = Object.assign(apply(r, q), { converted: true }); liveOK++; }
      });
      st.snap = snap; render();
    }
    const now = Math.floor(Date.now() / 1000);
    st.lastSync = Date.now();
    if (!snap) setStatus('Sync failed. Check your connection and try again.', 'bad');
    else if (liveOK === 0) {
      const g = Date.parse(snap.generated_at) / 1000;
      setStatus(`Live feeds unreachable, so this is the saved snapshot from <b>${esc(fmtTime(g))} IST</b>.`, 'warn');
    } else {
      setStatus(`Updated <b>${esc(fmtTime(now, false))} IST</b> · ${liveOK}/${total} quotes refreshed` +
        (failures.length ? ` (${esc(failures.join(', '))} unavailable)` : '') + '.', 'ok');
    }
    els.sync.classList.remove('busy'); els.sync.disabled = false; els.sync.querySelector('.sync-label').textContent = 'Sync';
    st.syncing = false;
  }

  async function openMarkets() {
    if (!st.loaded) {
      st.loaded = true;
      await sync(); // first open: snapshot + live overlay
    } else if (st.isLatest && Date.now() - st.lastSync > 5 * 60 * 1000) {
      sync();
    }
  }

  // ---------- tabs ----------
  function setTab(tab, save) {
    root.setAttribute('data-tab', tab);
    document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (save) { try { localStorage.setItem('aidaily-tab', tab); } catch (e) {} }
    if (tab === 'markets') openMarkets();
  }
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    if (root.getAttribute('data-tab') !== b.dataset.tab) { setTab(b.dataset.tab, true); window.scrollTo(0, 0); }
  }));

  els.sync.addEventListener('click', () => sync());
  async function goDate(d) {
    if (!d) return;
    try {
      setStatus('Loading snapshot…');
      await loadSnapshot(d === st.dates[0] ? null : d);
      snapStatus();
    } catch (e) { setStatus('Could not load that snapshot (' + esc(e.message) + ').', 'bad'); }
  }
  els.sel.addEventListener('change', () => goDate(els.sel.value));
  els.prev.addEventListener('click', () => { const i = st.dates.indexOf(st.date); if (i < st.dates.length - 1) goDate(st.dates[i + 1]); });
  els.next.addEventListener('click', () => { const i = st.dates.indexOf(st.date); if (i > 0) goDate(st.dates[i - 1]); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && root.getAttribute('data-tab') === 'markets' && st.loaded && st.isLatest && Date.now() - st.lastSync > 5 * 60 * 1000) sync();
  });

  setTab(root.getAttribute('data-tab') === 'markets' ? 'markets' : 'news', false);
})();
