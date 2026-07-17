/* Deal Tracker Admin v3 — core: constants, API, state, router, UI primitives
   (toasts, modals, drawer shell, lightbox, tooltips, tables, charts), theme,
   and global search. Views live in views.js (loaded after this file) and
   reach everything through the DT namespace. Plain JS, no build step; the
   only dependency is supabase-js from the CDN (loaded before this file). */
(() => {
'use strict';

// ---------------------------------------------------------------------------
// Constants (publishable values only — never place a secret key in this file)
// ---------------------------------------------------------------------------
const SUPABASE_URL = 'https://ouqvavmnmbaowlmfwrqz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_WqsHiMmX0ED47-y2I-KkKw_NJZXq3HU';
const ADMIN_API = SUPABASE_URL + '/functions/v1/admin-api';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------------------
// State — auth/view + per-tab caches (kept across route changes so
// back/forward is instant; each view refreshes explicitly).
// ---------------------------------------------------------------------------
const state = {
  view: 'loading',          // loading | signin | denied | panel
  signinMsg: '',
  route: { name: 'overview', args: [] },
  baseRoute: null,          // last non-drawer route (drawer renders over it)
  sessionUserId: null,      // for cannot-remove-self affordances
  cache: {
    dashboard: null,        // dashboard_stats response
    dashboardErr: '',
    users: null,            // list_users rows
    usersErr: '',
    usersQuery: '',
    usersSort: { key: 'created_at', dir: 'desc' },
    config: null,           // normalized app_config
    configErr: '',
    clientConfig: null,     // raw get_client_config rows → map
    clientConfigErr: '',
    stats: null, statsErr: '',
    health: null, healthErr: '',
    log: null, logErr: '',
    tables: null, tablesErr: '',
    admins: null, adminsErr: '',
    integrity: null, integrityErr: '', integrityRunning: false,
    storage: null, storageErr: '', storageRunning: false,
    dealsIndex: null,       // { at: epoch-ms, rows } — 5 min TTL (global search)
  },
  detail: null,             // user-detail working state (per open user)
  drawer: null,             // deal-drawer working state (per open deal)
  toolsTab: 'integrity',
};

// ---------------------------------------------------------------------------
// API helper — every admin-api call goes through here
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(code, message, handled) {
    super(message);
    this.code = code;
    this.handled = !!handled; // true when the error already routed to a screen
  }
}

async function adminApi(action, params = {}) {
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    resetToSignin('Your session has expired. Please sign in again.');
    throw new ApiError('unauthorized', 'Not signed in', true);
  }
  state.sessionUserId = session.user ? session.user.id : null;
  let res;
  try {
    res = await fetch(ADMIN_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(Object.assign({ action }, params)),
    });
  } catch (e) {
    throw new ApiError('network', 'Network error — check your connection and try again.');
  }
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON body */ }
  if (!res.ok) {
    const code = (body && body.code) || String(res.status);
    const message = (body && body.error) || ('Request failed (HTTP ' + res.status + ')');
    if (res.status === 401) {
      // supabase-js auto-refreshes tokens, so a 401 here means the session is
      // genuinely invalid — sign out and return to the sign-in screen.
      await db.auth.signOut().catch(() => {});
      resetToSignin('Your session has expired. Please sign in again.');
      throw new ApiError(code, message, true);
    }
    if (res.status === 403 && code === 'not_admin') {
      state.view = 'denied';
      render();
      throw new ApiError(code, message, true);
    }
    throw new ApiError(code, message);
  }
  return body;
}

// ---------------------------------------------------------------------------
// DOM + formatting helpers
// ---------------------------------------------------------------------------
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat(2)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function setMsg(target, kind, text) {
  target.className = target.className.replace(/\bmsg-(ok|err|info)\b/g, '').trim();
  target.classList.add(kind === 'ok' ? 'msg-ok' : kind === 'err' ? 'msg-err' : 'msg-info');
  target.textContent = text;
}

const intFmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const money = (n) => (n == null ? '—'
  : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtCost = (n) => (n == null ? '—' : '$' + Number(n).toFixed(4));
const pctFmt = (n) => (n == null ? '—' : (Number(n) * 100).toFixed(1) + '%');

function fmtBytes(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

// Plain DATE columns (deal_date etc.) — reformat the ISO string directly.
// new Date('YYYY-MM-DD') parses as UTC and can render the PRIOR day in
// negative-offset timezones; never route plain dates through Date.
function fmtISODate(v) {
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? m[2] + '/' + m[3] + '/' + m[1] : String(v);
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function utcStr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// Relative time ("2h ago") with the exact timestamp on hover — timestamps
// render through relTimeEl() so every one carries the hover detail.
function relTime(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (isNaN(t)) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  if (d < 30) return d + 'd ago';
  const mo = Math.round(d / 30);
  if (mo < 12) return mo + 'mo ago';
  return Math.round(mo / 12) + 'y ago';
}

function relTimeEl(iso) {
  return el('span', { title: iso ? fmtDateTime(iso) + ' · ' + utcStr(iso) : null, text: relTime(iso) });
}

function fmtDur(ms) {
  if (ms == null) return '—';
  const n = Number(ms);
  if (isNaN(n)) return '—';
  return n >= 1000 ? (n / 1000).toFixed(1) + 's' : n + 'ms';
}

function humanize(key) { return String(key).replace(/_/g, ' '); }

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Compact single value for diffs / params — never multiline, always short.
function fmtVal(v) {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return truncate(v, 60) || '""';
  if (typeof v === 'object') return truncate(JSON.stringify(v), 60);
  return String(v);
}

const valueEq = (a, b) =>
  JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

const num = (v) => (v == null ? 0 : Number(v) || 0);

// The ? tooltip (CLARITY RULE): a plain-English explanation on hover/focus.
function tip(text, left) {
  return el('button', { class: 'tip' + (left ? ' tip-left' : ''), type: 'button', 'data-tip': text, 'aria-label': text, text: '?' });
}

// get_config → typed map. Every consumer routes through configToMap /
// normalizeConfig; a key missing from the map means UNKNOWN — the caller
// must render an explicit unknown state and disable the control, never
// substitute a default (a kill switch must not render OFF as a parse
// fallback).
function configToMap(resp) {
  const rows = (resp && Array.isArray(resp.config)) ? resp.config : [];
  const map = {};
  for (const row of rows) {
    if (row && typeof row.key === 'string' && 'value' in row) map[row.key] = row.value;
  }
  return map;
}

function normalizeConfig(resp) {
  const map = configToMap(resp);
  return {
    // undefined = unknown (key absent or wrong type), distinct from false / a number
    scanning_enabled: typeof map.scanning_enabled === 'boolean' ? map.scanning_enabled : undefined,
    default_daily_scan_cap: (typeof map.default_daily_scan_cap === 'number' && Number.isFinite(map.default_daily_scan_cap))
      ? map.default_daily_scan_cap : undefined,
    monthly_budget_usd: (typeof map.monthly_budget_usd === 'number' && Number.isFinite(map.monthly_budget_usd))
      ? map.monthly_budget_usd : undefined,
  };
}

// ---------------------------------------------------------------------------
// Toasts — top-right queue; info/success auto-dismiss, errors persist.
// ---------------------------------------------------------------------------
const toastsEl = document.getElementById('toasts');
function toast(kind, text) {
  const t = el('div', { class: 'toast ' + (kind === 'ok' ? 'toast-ok' : kind === 'err' ? 'toast-err' : '') },
    el('span', { class: 'toast-text', text }),
    el('button', { class: 'toast-x', text: '✕', onclick: () => t.remove() }));
  toastsEl.append(t);
  if (kind !== 'err') setTimeout(() => t.remove(), 4200);
}

// ---------------------------------------------------------------------------
// Modal layer (shared confirm + free-form) — layered over everything.
// Typed confirms: destructive acts require the literal word before the
// button enables, and the body states consequences plainly.
// ---------------------------------------------------------------------------
const layerEl = document.getElementById('layer');

function closeTopLayer() {
  const last = layerEl.lastElementChild;
  if (last) last.remove();
}

function openLayer(contentEl, onBackdrop) {
  const wrap = el('div', {});
  const backdrop = el('div', { class: 'layer-backdrop', onclick: () => { if (onBackdrop) onBackdrop(); } });
  wrap.append(backdrop, contentEl);
  layerEl.append(wrap);
  return wrap;
}

// confirmModal({title, body (Node|string), danger, typed, confirmLabel, onConfirm})
// onConfirm may return a promise; the button shows progress and the modal
// closes on resolve (a throw keeps it open and surfaces the message).
function confirmModal(opts) {
  const msg = el('p', { class: 'msg' });
  const confirmBtn = el('button', {
    class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'),
    disabled: !!opts.typed,
  }, opts.confirmLabel || 'Confirm');
  let typedInput = null;
  if (opts.typed) {
    typedInput = el('input', { type: 'text', class: 'confirm-input', placeholder: opts.typed, autocomplete: 'off', spellcheck: 'false' });
    typedInput.addEventListener('input', () => { confirmBtn.disabled = typedInput.value !== opts.typed; });
  }
  const modal = el('div', { class: 'modal' },
    el('h3', { text: opts.title }),
    el('div', { class: 'modal-body' },
      typeof opts.body === 'string' ? el('p', { text: opts.body }) : opts.body,
      opts.typed ? el('label', { class: 'field' },
        'Type ' + opts.typed + ' to confirm:',
        typedInput) : null),
    msg,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: () => wrap.remove() }, 'Cancel'),
      confirmBtn));
  const wrap = openLayer(modal, () => wrap.remove());
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    setMsg(msg, 'info', 'Working…');
    try {
      await opts.onConfirm();
      wrap.remove();
    } catch (e) {
      if (e && e.handled) { wrap.remove(); return; }
      setMsg(msg, 'err', (e && e.message) || 'Failed.');
      confirmBtn.disabled = opts.typed ? typedInput.value !== opts.typed : false;
    }
  });
  if (typedInput) typedInput.focus();
  return wrap;
}

// Zoomable image lightbox (click toggles zoom, Esc/✕/backdrop closes).
function openLightbox(url) {
  const img = el('img', { src: url, alt: 'Scanned deal form' });
  const box = el('div', { class: 'lightbox' }, img);
  const x = el('button', { class: 'lightbox-x', text: '✕' });
  const wrap = el('div', {}, box, x);
  layerEl.append(wrap);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  x.addEventListener('click', close);
  box.addEventListener('click', (e) => {
    if (e.target === box) { close(); return; } // backdrop click closes
    box.classList.toggle('zoomed'); // image click toggles zoom
  });
}

// ---------------------------------------------------------------------------
// Table builder — data-label per cell (mobile card-collapse) + sticky head.
// cols: [{label, cls, tip}] · rows: arrays of Nodes/strings aligned to cols.
// ---------------------------------------------------------------------------
function buildTable(cols, rows, opts = {}) {
  const thead = el('thead', {}, el('tr', {}, cols.map((c) =>
    el('th', { class: c.cls || null },
      c.node ? c.node : c.label,
      c.tip ? [' ', tip(c.tip)] : null))));
  const tbody = el('tbody', {}, rows.map((r) => {
    const tr = el('tr', { class: r.rowClass || null, onclick: r.onclick || null });
    r.cells.forEach((cell, i) => {
      const td = el('td', { class: cols[i] && cols[i].cls || null, 'data-label': cols[i] ? cols[i].label : '' });
      if (cell != null) td.append(cell.nodeType ? cell : document.createTextNode(String(cell)));
      tr.append(td);
    });
    return tr;
  }));
  const table = el('table', { class: opts.noCollapse ? null : 'collapse' }, thead, tbody);
  if (opts.tfoot) table.append(opts.tfoot);
  return el('div', { class: 'table-wrap' }, table);
}

function skeletonRows(n, h) {
  const wrap = el('div', {});
  for (let i = 0; i < n; i++) wrap.append(el('div', { class: 'skeleton skel-line', style: h ? 'height:' + h + 'px' : null }));
  return wrap;
}

function emptyState(title, body) {
  return el('div', { class: 'empty' }, el('strong', { text: title }), el('span', { text: body }));
}

// ---------------------------------------------------------------------------
// SVG charts — hand-rolled line/area with hover tooltips, and sparklines.
// series: [{label, color (css var name or color), points: [{x, y}]}] where x
// is a label (date). All series share the x domain of the first series.
// ---------------------------------------------------------------------------
let chartTipEl = null;
function chartTip(html, cx, cy) {
  if (!chartTipEl) {
    chartTipEl = el('div', { class: 'chart-tooltip' });
    document.body.append(chartTipEl);
  }
  chartTipEl.innerHTML = '';
  chartTipEl.append(html);
  chartTipEl.style.left = Math.min(cx + 14, window.innerWidth - 180) + 'px';
  chartTipEl.style.top = (cy + 14) + 'px';
  chartTipEl.style.display = 'block';
}
function hideChartTip() { if (chartTipEl) chartTipEl.style.display = 'none'; }

function lineChart(series, opts = {}) {
  const W = 720, H = opts.height || 200, PADL = 34, PADR = 8, PADT = 10, PADB = 20;
  const xs = series[0] ? series[0].points.map((p) => p.x) : [];
  const n = xs.length;
  const maxY = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.y)));
  const x = (i) => (n <= 1 ? PADL : PADL + (i * (W - PADL - PADR)) / (n - 1));
  const y = (v) => PADT + (H - PADT - PADB) * (1 - v / maxY);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  // Uniform scaling (no preserveAspectRatio:none): stretching would distort
  // the axis text. Width tracks the container; height follows the ratio.
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

  const mk = (name, attrs) => {
    const node = document.createElementNS(svgNS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  // y gridlines (4) + labels
  for (let g = 0; g <= 3; g++) {
    const v = Math.round((maxY * g) / 3);
    const gy = y(v);
    svg.append(mk('line', { x1: PADL, x2: W - PADR, y1: gy, y2: gy, stroke: 'var(--border)', 'stroke-width': 1 }));
    const label = mk('text', { x: PADL - 6, y: gy + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--text-3)' });
    label.textContent = String(v);
    svg.append(label);
  }
  // x labels: ~5 evenly spaced (MM-DD)
  const step = Math.max(1, Math.floor(n / 5));
  for (let i = 0; i < n; i += step) {
    const label = mk('text', { x: x(i), y: H - 5, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--text-3)' });
    label.textContent = String(xs[i]).slice(5);
    svg.append(label);
  }

  for (const s of series) {
    const pts = s.points.map((p, i) => x(i) + ',' + y(p.y)).join(' ');
    if (s.area && n > 1) {
      const area = mk('polygon', {
        points: PADL + ',' + y(0) + ' ' + pts + ' ' + x(n - 1) + ',' + y(0),
        fill: s.color, 'fill-opacity': 0.12, stroke: 'none',
      });
      svg.append(area);
    }
    svg.append(mk('polyline', {
      points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  }

  // hover: nearest x index → tooltip with every series' value + marker line
  const hover = mk('line', { x1: 0, x2: 0, y1: PADT, y2: H - PADB, stroke: 'var(--text-3)', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
  svg.append(hover);
  svg.addEventListener('mousemove', (e) => {
    if (!n) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - PADL) / (W - PADL - PADR)) * (n - 1))));
    hover.setAttribute('x1', x(i));
    hover.setAttribute('x2', x(i));
    hover.setAttribute('visibility', 'visible');
    const box = el('div', {}, el('div', { class: 'strong', text: xs[i] }),
      series.map((s) => el('div', {},
        el('span', { class: 'swatch', style: 'background:' + s.color + ';display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px' }),
        s.label + ': ' + (opts.yFormat ? opts.yFormat(s.points[i].y) : s.points[i].y))));
    chartTip(box, e.clientX, e.clientY);
  });
  svg.addEventListener('mouseleave', () => { hover.setAttribute('visibility', 'hidden'); hideChartTip(); });

  const wrap = el('div', { class: 'chart-card' });
  wrap.append(svg);
  if (!opts.noLegend && series.length > 1) {
    wrap.append(el('div', { class: 'chart-legend' }, series.map((s) =>
      el('span', {}, el('span', { class: 'swatch', style: 'background:' + s.color }), s.label))));
  }
  return wrap;
}

function sparkline(values, color) {
  const W = 120, H = 30, PAD = 2;
  const n = values.length;
  const maxY = Math.max(1, ...values);
  const x = (i) => (n <= 1 ? PAD : PAD + (i * (W - 2 * PAD)) / (n - 1));
  const y = (v) => PAD + (H - 2 * PAD) * (1 - v / maxY);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'none');
  const pts = values.map((v, i) => x(i) + ',' + y(v)).join(' ');
  const poly = document.createElementNS(svgNS, 'polyline');
  poly.setAttribute('points', pts);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', color);
  poly.setAttribute('stroke-width', '1.6');
  const area = document.createElementNS(svgNS, 'polygon');
  area.setAttribute('points', x(0) + ',' + y(0) + ' ' + pts + ' ' + x(n - 1) + ',' + y(0));
  area.setAttribute('fill', color);
  area.setAttribute('fill-opacity', '0.13');
  svg.append(area, poly);
  return el('div', { class: 'stat-spark' }, svg);
}

// Zero-fill a per-day array over the trailing N UTC days.
// rows: [{date|day: 'YYYY-MM-DD', ...}]; blank(dayStr) builds an empty row.
function zeroFillDays(rows, days, keyField, blank) {
  const byDay = new Map(rows.map((r) => [String(r[keyField] || '').slice(0, 10), r]));
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) || blank(key));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSV + JSON download helpers (client-side export)
// ---------------------------------------------------------------------------
function downloadBlob(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function toCSV(rows) {
  if (!rows.length) return '';
  // Column order: union of keys in first-seen order (deals share a schema,
  // so this is effectively the table's column order).
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n');
}

// ---------------------------------------------------------------------------
// Hash router — #/overview, #/users, #/user/{id}/{tab}, #/deal/{id},
// #/stats, #/tools/{tab}, #/log, #/settings. Back/forward + refresh work;
// the deal drawer layers over the remembered base route.
// ---------------------------------------------------------------------------
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { name: 'overview', args: [] };
  const name = parts[0];
  const known = ['overview', 'users', 'user', 'deal', 'stats', 'tools', 'log', 'settings'];
  if (!known.includes(name)) return { name: 'overview', args: [] };
  return { name, args: parts.slice(1) };
}

function nav(path) {
  const target = '#/' + path.replace(/^#?\/?/, '');
  if (location.hash === target) { handleRoute(); return; }
  location.hash = target; // hashchange → handleRoute
}

function handleRoute() {
  const route = parseHash();
  state.route = route;
  if (route.name !== 'deal') state.baseRoute = route;
  if (state.view === 'panel') render();
  // View data hooks live in views.js (DT.onRoute).
  if (state.view === 'panel' && DT.onRoute) DT.onRoute(route);
}

window.addEventListener('hashchange', handleRoute);

// ---------------------------------------------------------------------------
// Theme toggle (manual choice persisted; system preference is the default)
// ---------------------------------------------------------------------------
const themeBtn = document.getElementById('theme-toggle');
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('dt-admin-theme', next); } catch (e) { /* private mode */ }
});

// ---------------------------------------------------------------------------
// Shell chrome: sidebar nav, mobile toggle, sign-out
// ---------------------------------------------------------------------------
const shellEl = document.getElementById('shell');
const sidenavEl = document.getElementById('sidenav');
const sidefootEl = document.getElementById('sidefoot');
const navToggle = document.getElementById('nav-toggle');
const navBackdrop = document.getElementById('sidebar-backdrop');
const signoutBtn = document.getElementById('signout');
const searchOpenBtn = document.getElementById('search-open');
const appEl = document.getElementById('app');

const NAV_ITEMS = [
  ['overview', 'Overview', '⌂'],
  ['users', 'Users', '👥'],
  ['stats', 'Stats', '📈'],
  ['tools', 'Tools', '🛠'],
  ['log', 'Log', '☰'],
  ['settings', 'Settings', '⚙'],
];

function renderNav() {
  sidenavEl.textContent = '';
  const active = state.route.name === 'user' ? 'users'
    : state.route.name === 'deal' ? (state.baseRoute ? (state.baseRoute.name === 'user' ? 'users' : state.baseRoute.name) : 'users')
      : state.route.name;
  for (const [id, label, ico] of NAV_ITEMS) {
    sidenavEl.append(el('button', {
      class: 'side-link' + (active === id ? ' active' : ''),
      onclick: () => { closeMobileNav(); nav(id); },
    }, el('span', { class: 'side-ico', text: ico }), label));
  }
  sidefootEl.textContent = '';
  sidefootEl.append(el('span', { text: 'repdealtracker.app · admin' }));
}

function openMobileNav() { shellEl.classList.add('nav-open'); navBackdrop.hidden = false; }
function closeMobileNav() { shellEl.classList.remove('nav-open'); navBackdrop.hidden = true; }
navToggle.addEventListener('click', () => {
  if (shellEl.classList.contains('nav-open')) closeMobileNav(); else openMobileNav();
});
navBackdrop.addEventListener('click', closeMobileNav);

signoutBtn.addEventListener('click', async () => {
  await db.auth.signOut().catch(() => {});
  resetToSignin('');
});

db.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT' && state.view !== 'signin') resetToSignin('');
});

function resetToSignin(msg) {
  state.view = 'signin';
  state.signinMsg = msg || '';
  state.detail = null;
  state.drawer = null;
  for (const k of Object.keys(state.cache)) state.cache[k] = /Err$|Query$/.test(k) ? '' : null;
  state.cache.usersQuery = '';
  state.cache.usersSort = { key: 'created_at', dir: 'desc' };
  layerEl.textContent = '';
  render();
}

// ---------------------------------------------------------------------------
// Global search (⌘K / topbar button): users from the cached roster, deals
// from list_deals_index (cached 5 min), debounced; grouped; Enter opens.
// ---------------------------------------------------------------------------
const DEALS_INDEX_TTL = 5 * 60 * 1000;

async function ensureDealsIndex() {
  const c = state.cache.dealsIndex;
  if (c && Date.now() - c.at < DEALS_INDEX_TTL) return c.rows;
  const resp = await adminApi('list_deals_index');
  const rows = (resp && resp.deals) || [];
  state.cache.dealsIndex = { at: Date.now(), rows };
  return rows;
}

async function ensureUsers() {
  if (state.cache.users) return state.cache.users;
  const resp = await adminApi('list_users');
  state.cache.users = (resp && resp.users) || [];
  return state.cache.users;
}

function openSearch() {
  const input = el('input', { type: 'text', placeholder: 'Search users and deals…', autocomplete: 'off', spellcheck: 'false' });
  const results = el('div', { class: 'search-results' },
    el('p', { class: 'search-empty', text: 'Type to search every user and every deal (owner or account #). Deals refresh every 5 minutes.' }));
  const modal = el('div', { class: 'search-modal' },
    el('div', { class: 'search-input-row' }, el('span', { class: 'search-fake-icon', text: '⌕' }), input, el('kbd', { text: 'esc' })),
    results);
  const wrap = openLayer(modal, () => close());
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };

  let hits = [];
  let sel = 0;
  let debounceTimer = null;
  let searchSeq = 0;

  const renderHits = () => {
    results.textContent = '';
    if (!input.value.trim()) {
      results.append(el('p', { class: 'search-empty', text: 'Type to search every user and every deal (owner or account #).' }));
      return;
    }
    if (!hits.length) {
      results.append(el('p', { class: 'search-empty', text: 'No matches. Users match on email; deals match on owner name, account number, or exact deal id.' }));
      return;
    }
    let lastGroup = '';
    hits.forEach((h, i) => {
      if (h.group !== lastGroup) {
        results.append(el('div', { class: 'search-group', text: h.group }));
        lastGroup = h.group;
      }
      const btn = el('button', { class: 'search-hit' + (i === sel ? ' sel' : ''), onclick: () => { close(); h.go(); } },
        el('span', { class: 'hit-main' }, h.label),
        el('span', { class: 'hit-sub', text: h.sub || '' }));
      results.append(btn);
    });
  };

  const runSearch = async () => {
    const q = input.value.trim().toLowerCase();
    const seq = ++searchSeq;
    if (!q) { hits = []; renderHits(); return; }
    try {
      const [users, deals] = await Promise.all([ensureUsers(), ensureDealsIndex()]);
      if (seq !== searchSeq) return; // stale response
      const emailById = new Map(users.map((u) => [u.user_id, u.email || '']));
      const userHits = users
        .filter((u) => (u.email || '').toLowerCase().includes(q))
        .slice(0, 6)
        .map((u) => ({
          group: 'Users',
          label: u.email || u.user_id,
          sub: intFmt(u.deal_count) + ' deals',
          go: () => nav('user/' + u.user_id + '/overview'),
        }));
      const dealHits = deals
        .filter((d) => {
          if (String(d.id).toLowerCase() === q) return true;
          if (typeof d.account_number === 'string' && d.account_number.toLowerCase().includes(q)) return true;
          const owners = Array.isArray(d.owner_names) ? d.owner_names : [];
          return owners.some((o) => typeof o === 'string' && o.toLowerCase().includes(q));
        })
        .slice(0, 10)
        .map((d) => {
          const owners = Array.isArray(d.owner_names) ? d.owner_names : [];
          const owner = typeof owners[0] === 'string' ? owners[0] : '(no owner)';
          return {
            group: 'Deals',
            label: owner + (d.cancelled ? ' · cancelled' : ''),
            sub: fmtISODate(d.deal_date) + ' · ' + money(d.volume) + ' · ' + (emailById.get(d.user_id) || ''),
            go: () => nav('deal/' + d.id),
          };
        });
      hits = userHits.concat(dealHits);
      sel = 0;
      renderHits();
    } catch (e) {
      if (e && e.handled) { close(); return; }
      if (seq !== searchSeq) return;
      results.textContent = '';
      results.append(el('p', { class: 'search-empty msg-err', text: 'Search failed: ' + e.message }));
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 200);
  });
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(hits.length - 1, sel + 1); renderHits(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); renderHits(); }
    else if (e.key === 'Enter' && hits[sel]) { close(); hits[sel].go(); }
  };
  document.addEventListener('keydown', onKey);
  input.focus();
}

searchOpenBtn.addEventListener('click', openSearch);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && state.view === 'panel') {
    e.preventDefault();
    openSearch();
  }
});

// ---------------------------------------------------------------------------
// Top-level render — delegates panel content to views.js
// ---------------------------------------------------------------------------
function render() {
  const inPanel = state.view === 'panel';
  signoutBtn.hidden = !(inPanel || state.view === 'denied');
  themeBtn.hidden = false;
  searchOpenBtn.hidden = !inPanel;
  navToggle.hidden = !inPanel;
  document.getElementById('sidebar').style.display = inPanel ? '' : 'none';
  appEl.textContent = '';
  if (state.view === 'loading') {
    appEl.append(el('div', { class: 'stack' },
      el('div', { class: 'skeleton skel-line', style: 'width:220px' }),
      el('div', { class: 'skeleton skel-block' })));
    return;
  }
  if (state.view === 'signin') { appEl.append(DT.viewSignin()); return; }
  if (state.view === 'denied') { appEl.append(DT.viewDenied()); return; }
  renderNav();
  appEl.append(DT.viewPanel());
}

// ---------------------------------------------------------------------------
// Boot + auth flow
// ---------------------------------------------------------------------------
async function init() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { resetToSignin(''); return; }
  state.sessionUserId = session.user ? session.user.id : null;
  probe();
}

// With a session, get_config doubles as the "is this an admin?" probe.
async function probe() {
  state.view = 'loading';
  render();
  try {
    const resp = await adminApi('get_config');
    state.cache.config = normalizeConfig(resp);
    state.view = 'panel';
    handleRoute();
  } catch (e) {
    if (!e.handled) resetToSignin('Could not reach the admin API: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Namespace for views.js
// ---------------------------------------------------------------------------
window.DT = {
  db, state, adminApi, ApiError,
  el, setMsg, tip, toast,
  intFmt, money, fmtCost, pctFmt, fmtBytes, fmtISODate, fmtDateTime, utcStr,
  relTime, relTimeEl, fmtDur, humanize, truncate, fmtVal, valueEq, num,
  configToMap, normalizeConfig,
  confirmModal, openLayer, closeTopLayer, openLightbox,
  buildTable, skeletonRows, emptyState,
  lineChart, sparkline, zeroFillDays,
  downloadBlob, toCSV,
  nav, render, renderNav, probe, resetToSignin,
  ensureUsers, ensureDealsIndex, openSearch,
  init,
  // views.js assigns these:
  onRoute: null, viewSignin: null, viewDenied: null, viewPanel: null,
};
const DT = window.DT;
})();
