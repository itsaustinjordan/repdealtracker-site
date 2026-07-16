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
// State
// ---------------------------------------------------------------------------
const state = {
  view: 'loading',       // loading | signin | denied | panel
  tab: 'users',          // users | stats | settings | log
  signinMsg: '',
  config: null,          // { scanning_enabled, default_daily_scan_cap }
  configError: '',
  users: null,           // null = loading, [] = loaded
  usersError: '',
  usersQuery: '',        // client-side email filter
  usersSort: { key: 'created_at', dir: 'desc' },
  detail: null,          // { row, data, error, deleted, section, deals, activity, deletedDeals }
  stats: null,           // null = loading, [] = loaded (zero-filled 30 days)
  statsError: '',
  health: null,          // null = loading; { daily, by_version, recent_failures }
  healthError: '',
  log: null,             // null = loading; { rows, nextBefore }
  logError: '',
  drawer: null,          // { dealId, data: {deal, audit, scan_event}, error, edit }
};

const appEl = document.getElementById('app');
const signoutBtn = document.getElementById('signout');

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
  state.config = null;
  state.users = null;
  state.usersQuery = '';
  state.detail = null;
  state.stats = null;
  state.health = null;
  state.log = null;
  state.drawer = null;
  render();
}

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
// Small DOM + formatting helpers
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
const fmtCost = (n) => (n == null ? '' : '$' + Number(n).toFixed(4));
const pctFmt = (n) => (n == null ? '—' : (Number(n) * 100).toFixed(1) + '%');

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString();
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

function fmtDur(ms) {
  if (ms == null) return '—';
  const n = Number(ms);
  if (isNaN(n)) return '—';
  return n >= 1000 ? (n / 1000).toFixed(1) + 's' : n + 'ms';
}

function humanize(key) {
  return String(key).replace(/_/g, ' ');
}

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

function lastActive(u) {
  const a = Date.parse(u.last_sign_in_at || '') || 0;
  const b = Date.parse(u.last_deal_at || '') || 0;
  const m = Math.max(a, b);
  return m ? new Date(m).toISOString() : null;
}

// get_config returns { config: [ { key, value, updated_at }, ... ] } with
// values already JSON-typed (boolean / number). Every get_config consumer
// goes through configToMap; a key missing from the map means UNKNOWN — the
// caller must render an explicit unknown state and disable the control,
// never substitute a default (a kill switch must not render OFF as a
// parse fallback).
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
  };
}

// ---------------------------------------------------------------------------
// Deal field registry — mirrors the server's DEALS_COLUMNS (admin-api) and
// schema.sql. id / user_id are immutable (rendered read-only in edit mode).
// ---------------------------------------------------------------------------
const DEAL_GROUPS = [
  ['Identity', ['id', 'user_id', 'account_number', 'owner_names', 'phone_numbers',
    'representative_number', 'manager_number', 'closing_officer_number']],
  ['Dates', ['deal_date', 'date_logged', 'paid_in_full_date', 'pender_final_payment_date']],
  ['Money', ['purchase_price', 'upg_amount', 'volume', 'down_payment', 'closing_cost',
    'interval_dues', 'down_payment_required', 'balance_remaining', 'amount_received_today',
    'amount_received_breakdown', 'additional_payments_due', 'annual_rate', 'months_financed',
    'monthly_payment']],
  ['Commission', ['commission_rate', 'commission_amount', 'commission_status', 'commission_source']],
  ['Status', ['pender_status', 'cancelled', 'cancel_reason', 'deal_type', 'existing_owner']],
  ['Meta', ['entry_method', 'market_source', 'site_origin', 'resort', 'unit_size', 'notes',
    'source_image_ref', 'scan_event_id', 'import_metadata']],
];

const IMMUTABLE_COLS = ['id', 'user_id'];

// Input type per column; anything absent = nullable free text.
// Arrays are enum options ('' entry = nullable).
const FIELD_TYPES = {
  purchase_price: 'number', down_payment: 'number', closing_cost: 'number',
  interval_dues: 'number', amount_received_today: 'number', annual_rate: 'number',
  months_financed: 'number', monthly_payment: 'number', upg_amount: 'number',
  down_payment_required: 'number', balance_remaining: 'number', volume: 'number',
  commission_rate: 'number', commission_amount: 'number',
  pender_status: 'bool', cancelled: 'bool',
  existing_owner: 'bool-null',
  deal_type: ['new', 'upgrade'],
  commission_status: ['pending', 'earned'],
  commission_source: ['computed', 'manual', 'imported'],
  entry_method: ['scanned', 'manual'],
  cancel_reason: ['', 'rescission', 'unpaid_pender'],
  deal_date: 'date', paid_in_full_date: 'date', pender_final_payment_date: 'date',
  date_logged: 'datetime',
  owner_names: 'lines', phone_numbers: 'lines',
  additional_payments_due: 'json-array', import_metadata: 'json',
};

// NOT NULL columns whose input type can produce null — blank blocks save
// client-side instead of round-tripping a 23502.
const NOT_NULL_COLS = ['volume', 'commission_rate', 'commission_amount',
  'down_payment_required', 'balance_remaining', 'date_logged'];

// Mirror of the server's IMPORTED_GUARD_FIELDS (§3.11c).
const GUARD_FIELDS = ['commission_rate', 'commission_amount', 'commission_status',
  'commission_source', 'volume', 'purchase_price', 'upg_amount'];

const MONEY_COLS = ['purchase_price', 'upg_amount', 'volume', 'down_payment', 'closing_cost',
  'interval_dues', 'down_payment_required', 'balance_remaining', 'amount_received_today',
  'commission_amount', 'monthly_payment'];
const PCT_COLS = ['commission_rate', 'annual_rate'];
const ISO_DATE_COLS = ['deal_date', 'paid_in_full_date', 'pender_final_payment_date'];

// Encode a stored value into its edit-input string.
function encodeFieldValue(col, v) {
  const t = FIELD_TYPES[col] || 'text';
  if (v === null || v === undefined) return '';
  if (Array.isArray(t)) return String(v);
  switch (t) {
    case 'number': return String(v);
    case 'bool': case 'bool-null': return v ? 'true' : 'false';
    case 'date': return String(v).slice(0, 10);
    case 'lines': return Array.isArray(v) ? v.join('\n') : '';
    case 'json': case 'json-array': return JSON.stringify(v, null, 2);
    default: return String(v);
  }
}

// Parse an edit-input string back into a column value.
// Returns { value } or { error }.
function parseFieldValue(col, raw) {
  const t = FIELD_TYPES[col] || 'text';
  let out;
  if (Array.isArray(t)) {
    out = { value: raw === '' ? null : raw };
  } else if (t === 'number') {
    const s = String(raw).trim();
    if (s === '') out = { value: null };
    else {
      const n = Number(s);
      out = Number.isFinite(n) ? { value: n } : { error: 'not a number' };
    }
  } else if (t === 'bool') {
    out = { value: raw === 'true' };
  } else if (t === 'bool-null') {
    out = { value: raw === '' ? null : raw === 'true' };
  } else if (t === 'date') {
    out = { value: raw === '' ? null : raw };
  } else if (t === 'datetime') {
    const s = String(raw).trim();
    out = { value: s === '' ? null : s };
  } else if (t === 'lines') {
    out = { value: String(raw).split('\n').map((x) => x.trim()).filter(Boolean) };
  } else if (t === 'json' || t === 'json-array') {
    const s = String(raw).trim();
    if (s === '') out = { value: t === 'json-array' ? [] : null }; // jsonb NOT NULL DEFAULT '[]'
    else {
      try { out = { value: JSON.parse(s) }; } catch (e) { out = { error: 'invalid JSON' }; }
    }
  } else {
    const s = String(raw);
    out = { value: s.trim() === '' ? null : s };
  }
  if (!out.error && out.value === null && NOT_NULL_COLS.includes(col)) {
    out = { error: 'required (NOT NULL column)' };
  }
  return out;
}

const valueEq = (a, b) =>
  JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

// Read-view formatting per column.
function readValue(col, v) {
  if (col === 'import_metadata') {
    return v && typeof v === 'object' ? 'present (' + Object.keys(v).length + ' keys)' : '—';
  }
  if (v === null || v === undefined) return '—';
  if (MONEY_COLS.includes(col)) return money(v);
  if (PCT_COLS.includes(col)) return String(v) + '%';
  if (ISO_DATE_COLS.includes(col)) return fmtISODate(v);
  if (col === 'date_logged') return fmtDateTime(v);
  if (col === 'owner_names' || col === 'phone_numbers') {
    return Array.isArray(v) && v.length ? v.join(', ') : '—';
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Status badge per the app's §3.5 language: TEXT = type, COLOR = money state
// (green earned, amber open pender, grey cancelled, red unpaid).
function dealStatusBadge(deal) {
  if (deal.cancelled) {
    return deal.cancel_reason === 'unpaid_pender'
      ? el('span', { class: 'badge badge-unpaid', text: 'Unpaid' })
      : el('span', { class: 'badge badge-cancelled', text: 'Cancelled' });
  }
  const earned = deal.commission_status === 'earned';
  const cls = earned ? 'badge-earned' : 'badge-pending';
  return el('span', { class: 'badge ' + cls, text: deal.pender_status ? 'Pender' : 'Full Down' });
}

function sourceBadge(src) {
  if (src === 'imported') return el('span', { class: 'badge badge-src-imported', text: 'imported' });
  if (src === 'manual') return el('span', { class: 'badge badge-src-manual', text: 'manual' });
  if (src === 'computed' || src == null) return el('span', { class: 'badge badge-src-computed', text: 'computed' });
  // unknown ≠ default: an unexpected value renders as itself, never mapped.
  return el('span', { class: 'badge badge-src-computed', text: String(src) });
}

// Changed field NAMES for an audit row (UPDATE only).
function changedFieldNames(a) {
  if (a.action !== 'UPDATE') return [];
  const oldR = a.old_row || {};
  const newR = a.new_row || {};
  const keys = new Set(Object.keys(oldR).concat(Object.keys(newR)));
  return [...keys].filter((k) => !valueEq(oldR[k], newR[k])).sort();
}

// ---------------------------------------------------------------------------
// Boot + auth flow
// ---------------------------------------------------------------------------
async function init() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    resetToSignin('');
    return;
  }
  probe();
}

// With a session, get_config doubles as the "is this an admin?" probe.
async function probe() {
  state.view = 'loading';
  render();
  try {
    const resp = await adminApi('get_config');
    state.config = normalizeConfig(resp);
    state.view = 'panel';
    state.tab = 'users';
    state.detail = null;
    state.drawer = null;
    render();
    loadUsers();
  } catch (e) {
    if (!e.handled) resetToSignin('Could not reach the admin API: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------
async function loadUsers() {
  state.usersError = '';
  state.users = null;
  if (state.view === 'panel' && state.tab === 'users' && !state.detail) render();
  try {
    const resp = await adminApi('list_users');
    state.users = (resp && resp.users) || [];
  } catch (e) {
    if (e.handled) return;
    state.users = [];
    state.usersError = e.message;
  }
  if (state.view === 'panel' && state.tab === 'users' && !state.detail) render();
}

function normalizeDetail(resp) {
  const d = resp || {};
  return {
    aggregates: d.aggregates || d.user || d.stats || {},
    events: d.scan_events || d.recent_scan_events || d.events || [],
    settings: d.user_settings || d.settings || null,
    cap: d.cap || d.scan_limit || d.scan_cap || d.cap_row || null,
  };
}

function openDetail(row) {
  state.detail = {
    row, data: null, error: '', deleted: null,
    section: 'overview',
    deals: { query: '', cancelled: 'any', pender: 'any', offset: 0, rows: null, total: 0, error: '' },
    activity: { rows: null, nextBefore: null, error: '', loadingMore: false },
    deletedDeals: { rows: null, error: '' },
  };
  render();
  loadDetail(row.user_id);
}

async function loadDetail(userId) {
  try {
    const resp = await adminApi('user_detail', { user_id: userId });
    if (!state.detail || state.detail.row.user_id !== userId) return;
    state.detail.data = normalizeDetail(resp);
  } catch (e) {
    if (e.handled) return;
    if (!state.detail || state.detail.row.user_id !== userId) return;
    state.detail.error = e.message;
    state.detail.data = { aggregates: {}, events: [], settings: null, cap: null };
  }
  if (state.view === 'panel' && state.tab === 'users' && state.detail) render();
}

function rerenderIfSection(id) {
  if (state.view === 'panel' && state.tab === 'users' && state.detail && state.detail.section === id) render();
}

// silent = keep the current rows on screen while refreshing (post-save).
async function loadDeals(silent) {
  const d = state.detail;
  if (!d) return;
  const s = d.deals;
  s.error = '';
  if (!silent) { s.rows = null; rerenderIfSection('deals'); }
  const params = { user_id: d.row.user_id, limit: 50, offset: s.offset };
  if (s.query.trim()) params.query = s.query.trim();
  if (s.cancelled !== 'any') params.cancelled = s.cancelled === 'true';
  if (s.pender !== 'any') params.pender = s.pender === 'true';
  try {
    const resp = await adminApi('list_deals', params);
    if (state.detail !== d) return;
    s.rows = (resp && resp.deals) || [];
    s.total = resp && typeof resp.total === 'number' ? resp.total : 0;
  } catch (e) {
    if (e.handled) return;
    if (state.detail !== d) return;
    s.rows = [];
    s.total = 0;
    s.error = e.message;
  }
  rerenderIfSection('deals');
}

async function loadActivity(more) {
  const d = state.detail;
  if (!d) return;
  const s = d.activity;
  s.error = '';
  if (!more) { s.rows = null; s.nextBefore = null; rerenderIfSection('activity'); }
  else { s.loadingMore = true; rerenderIfSection('activity'); }
  const params = { user_id: d.row.user_id, limit: 100 };
  if (more && s.nextBefore) params.before = s.nextBefore;
  try {
    const resp = await adminApi('user_audit', params);
    if (state.detail !== d) return;
    const rows = (resp && resp.audit) || [];
    s.rows = more ? (s.rows || []).concat(rows) : rows;
    s.nextBefore = (resp && resp.next_before) || null;
  } catch (e) {
    if (e.handled) return;
    if (state.detail !== d) return;
    if (!more) s.rows = [];
    s.error = e.message;
  }
  s.loadingMore = false;
  rerenderIfSection('activity');
}

async function loadDeletedDeals() {
  const d = state.detail;
  if (!d) return;
  const s = d.deletedDeals;
  s.error = '';
  s.rows = null;
  rerenderIfSection('deleted');
  try {
    const resp = await adminApi('list_deleted_deals', { user_id: d.row.user_id, limit: 50 });
    if (state.detail !== d) return;
    s.rows = (resp && resp.deleted) || [];
  } catch (e) {
    if (e.handled) return;
    if (state.detail !== d) return;
    s.rows = [];
    s.error = e.message;
  }
  rerenderIfSection('deleted');
}

const num = (v) => (v == null ? 0 : Number(v) || 0);

function normalizeStats(resp) {
  let rows = [];
  if (Array.isArray(resp)) rows = resp;
  else if (resp && Array.isArray(resp.days)) rows = resp.days;
  else if (resp && Array.isArray(resp.stats)) rows = resp.stats;
  else if (resp && Array.isArray(resp.rows)) rows = resp.rows;
  return rows.map((r) => ({
    day: String(r.day || r.date || '').slice(0, 10),
    total: num(r.total),
    success: num(r.success),
    parse_fail: num(r.parse_fail),
    api_fail: num(r.api_fail),
    blocked_quota: num(r.blocked_quota),
    blocked_kill_switch: num(r.blocked_kill_switch),
    recovered: num(r.recovered_count != null ? r.recovered_count : r.recovered),
    tokens_in: num(r.input_tokens != null ? r.input_tokens : r.input_token_sum),
    tokens_out: num(r.output_tokens != null ? r.output_tokens : r.output_token_sum),
    est_cost_usd: r.est_cost_usd == null ? null : Number(r.est_cost_usd),
  }));
}

// The backend only returns days that have events; fill the gaps so the panel
// always shows a continuous 30-day series (UTC days).
function zeroFill(rows, days) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) || {
      day: key, total: 0, success: 0, parse_fail: 0, api_fail: 0,
      blocked_quota: 0, blocked_kill_switch: 0, recovered: 0,
      tokens_in: 0, tokens_out: 0, est_cost_usd: null,
    });
  }
  return out;
}

async function loadStats() {
  state.statsError = '';
  state.stats = null;
  if (state.view === 'panel' && state.tab === 'stats') render();
  try {
    const resp = await adminApi('scan_stats', { days: 30 });
    state.stats = zeroFill(normalizeStats(resp), 30);
  } catch (e) {
    if (e.handled) return;
    state.stats = [];
    state.statsError = e.message;
  }
  if (state.view === 'panel' && state.tab === 'stats') render();
}

async function loadHealth() {
  state.healthError = '';
  state.health = null;
  if (state.view === 'panel' && state.tab === 'stats') render();
  try {
    const resp = await adminApi('health_stats', { days: 30 });
    state.health = {
      daily: (resp && Array.isArray(resp.daily)) ? resp.daily : [],
      by_version: (resp && Array.isArray(resp.by_version)) ? resp.by_version : [],
      recent_failures: (resp && Array.isArray(resp.recent_failures)) ? resp.recent_failures : [],
    };
  } catch (e) {
    if (e.handled) return;
    state.health = { daily: [], by_version: [], recent_failures: [] };
    state.healthError = e.message;
  }
  if (state.view === 'panel' && state.tab === 'stats') render();
}

async function loadLog(more) {
  state.logError = '';
  if (!more) { state.log = null; if (state.view === 'panel' && state.tab === 'log') render(); }
  const params = { limit: 100 };
  const prev = more && state.log ? state.log : null;
  if (prev && prev.nextBefore) params.before = prev.nextBefore;
  try {
    const resp = await adminApi('list_admin_actions', params);
    const rows = (resp && resp.actions) || [];
    state.log = {
      rows: prev ? prev.rows.concat(rows) : rows,
      nextBefore: (resp && resp.next_before) || null,
    };
  } catch (e) {
    if (e.handled) return;
    if (!state.log) state.log = { rows: [], nextBefore: null };
    state.logError = e.message;
  }
  if (state.view === 'panel' && state.tab === 'log') render();
}

async function refreshConfig() {
  state.configError = '';
  try {
    const resp = await adminApi('get_config');
    state.config = normalizeConfig(resp);
  } catch (e) {
    if (e.handled) return;
    state.configError = e.message;
  }
  if (state.view === 'panel' && state.tab === 'settings') render();
}

// ---------------------------------------------------------------------------
// Deal drawer loaders
// ---------------------------------------------------------------------------
function openDrawer(dealId) {
  state.drawer = { dealId, data: null, error: '', edit: null };
  render();
  loadDrawer(dealId);
}

async function loadDrawer(dealId) {
  const dr = state.drawer;
  if (!dr || dr.dealId !== dealId) return;
  try {
    const resp = await adminApi('get_deal', { deal_id: dealId });
    if (state.drawer !== dr) return;
    dr.data = {
      deal: (resp && resp.deal) || {},
      audit: (resp && resp.audit) || [],
      scan_event: (resp && resp.scan_event) || null,
    };
  } catch (e) {
    if (e.handled) return;
    if (state.drawer !== dr) return;
    dr.error = e.message;
  }
  render();
}

// Post-save: refresh audit/scan without blanking the drawer.
async function refreshDrawerQuiet(dr) {
  try {
    const resp = await adminApi('get_deal', { deal_id: dr.dealId });
    if (state.drawer !== dr) return;
    dr.data = {
      deal: (resp && resp.deal) || dr.data.deal,
      audit: (resp && resp.audit) || dr.data.audit,
      scan_event: resp ? (resp.scan_event || null) : dr.data.scan_event,
    };
    render();
  } catch (e) { /* quiet refresh — keep what we have */ }
}

function closeDrawer() {
  state.drawer = null;
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  signoutBtn.classList.toggle('hidden', !(state.view === 'panel' || state.view === 'denied'));
  appEl.textContent = '';
  if (state.view === 'loading') {
    appEl.append(el('p', { class: 'msg-info', text: 'Loading…' }));
  } else if (state.view === 'signin') {
    appEl.append(viewSignin());
  } else if (state.view === 'denied') {
    appEl.append(viewDenied());
  } else {
    appEl.append(viewPanel());
    if (state.drawer) appEl.append(viewDrawer());
  }
}

function viewSignin() {
  const msg = el('p', { class: 'msg msg-err', text: state.signinMsg });
  const email = el('input', { type: 'email', autocomplete: 'username', required: true, placeholder: 'you@example.com' });
  const pass = el('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Password' });
  const btn = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Sign in' });
  return el('form', {
    class: 'card signin-card',
    onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      const { error } = await db.auth.signInWithPassword({
        email: email.value.trim(),
        password: pass.value,
      });
      if (error) {
        setMsg(msg, 'err', error.message || 'Sign-in failed.');
        btn.disabled = false;
        btn.textContent = 'Sign in';
        return;
      }
      state.signinMsg = '';
      probe();
    },
  },
    el('h1', { text: 'Admin sign-in' }),
    el('label', {}, 'Email', email),
    el('label', {}, 'Password', pass),
    btn,
    msg);
}

function viewDenied() {
  return el('div', { class: 'card center-card' },
    el('h1', { text: 'Not authorized' }),
    el('p', { text: 'This account is not authorized to use the admin panel.' }),
    el('button', {
      class: 'btn',
      onclick: async () => {
        await db.auth.signOut().catch(() => {});
        resetToSignin('');
      },
    }, 'Sign out'));
}

function viewPanel() {
  const tabs = el('nav', { class: 'tabs' },
    [['users', 'Users'], ['stats', 'Stats'], ['settings', 'Settings'], ['log', 'Log']].map(([id, label]) =>
      el('button', {
        class: 'tab' + (state.tab === id ? ' active' : ''),
        onclick: () => switchTab(id),
      }, label)));
  const content = el('div', { class: 'tab-content' });
  if (state.tab === 'users') content.append(state.detail ? viewUserDetail() : viewUsers());
  else if (state.tab === 'stats') content.append(viewStats());
  else if (state.tab === 'log') content.append(viewLog());
  else content.append(viewSettings());
  return el('div', {}, tabs, content);
}

function switchTab(id) {
  state.tab = id;
  if (id === 'users') state.detail = null; // Users tab click also acts as "back to list"
  render();
  if (id === 'users' && state.users === null) loadUsers();
  if (id === 'stats') {
    if (state.stats === null) loadStats();
    if (state.health === null) loadHealth();
  }
  if (id === 'settings') refreshConfig();
  if (id === 'log' && state.log === null) loadLog();
}

// ---------------------------------------------------------------------------
// Users tab
// ---------------------------------------------------------------------------
function badges(u) {
  const out = [];
  if (u.is_admin) out.push(el('span', { class: 'badge badge-admin', text: 'ADMIN' }));
  if (u.banned) out.push(el('span', { class: 'badge badge-banned', text: 'BANNED' }));
  if (typeof u.note === 'string' && u.note.trim()) {
    out.push(el('span', { class: 'badge badge-note', text: '✎ note', title: truncate(u.note, 300) }));
  }
  return out;
}

function capOf(u) {
  const defCap = state.config ? state.config.default_daily_scan_cap : null;
  const cap = u.daily_cap != null ? u.daily_cap : defCap;
  return cap != null ? String(cap) : '—';
}

const USER_SORTS = {
  email: { get: (u) => (u.email || '').toLowerCase(), dir: 'asc', str: true },
  created_at: { get: (u) => u.created_at || '', dir: 'desc', str: true },
  last_active: { get: (u) => lastActive(u) || '', dir: 'desc', str: true },
  deal_count: { get: (u) => num(u.deal_count), dir: 'desc' },
  volume_sum: { get: (u) => num(u.volume_sum), dir: 'desc' },
  scans_30d: { get: (u) => num(u.scans_30d), dir: 'desc' },
};

function sortedFilteredUsers() {
  const q = state.usersQuery.trim().toLowerCase();
  let list = (state.users || []).slice();
  if (q) list = list.filter((u) => (u.email || '').toLowerCase().includes(q));
  const s = USER_SORTS[state.usersSort.key] || USER_SORTS.created_at;
  const mul = state.usersSort.dir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    const av = s.get(a); const bv = s.get(b);
    const c = s.str ? String(av).localeCompare(String(bv)) : (av - bv);
    return c * mul;
  });
  return list;
}

function viewUsers() {
  const wrap = el('div', {},
    el('div', { class: 'section-head' },
      el('h2', { text: 'Users' }),
      el('button', { class: 'btn btn-small', onclick: () => loadUsers() }, 'Refresh')));
  if (state.usersError) wrap.append(el('p', { class: 'msg msg-err', text: state.usersError }));
  if (state.users === null) {
    wrap.append(el('p', { class: 'msg-info', text: 'Loading users…' }));
    return wrap;
  }
  if (!state.users.length) {
    if (!state.usersError) wrap.append(el('p', { class: 'msg-info', text: 'No users.' }));
    return wrap;
  }

  const search = el('input', {
    type: 'text', class: 'input-search', placeholder: 'Search email…',
  });
  search.value = state.usersQuery;
  wrap.append(el('div', { class: 'users-controls' }, search));

  const tbody = el('tbody', {});
  const countEl = el('p', { class: 'hint' });

  const sortableTh = (key, label, cls) => {
    const active = state.usersSort.key === key;
    const arrow = active ? (state.usersSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return el('th', {
      class: 'sortable' + (cls ? ' ' + cls : ''),
      onclick: () => {
        if (state.usersSort.key === key) {
          state.usersSort.dir = state.usersSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.usersSort = { key, dir: USER_SORTS[key].dir };
        }
        render();
      },
    }, label + arrow);
  };

  const renderRows = () => {
    tbody.textContent = '';
    const list = sortedFilteredUsers();
    countEl.textContent = list.length === state.users.length
      ? state.users.length + ' users'
      : list.length + ' of ' + state.users.length + ' users';
    for (const u of list) {
      tbody.append(el('tr', { class: 'clickable', onclick: () => openDetail(u) },
        el('td', {}, u.email || '—', badges(u)),
        el('td', { text: fmtDate(u.created_at) }),
        el('td', { text: fmtDateTime(lastActive(u)) }),
        el('td', { class: 'num', text: intFmt(u.deal_count) }),
        el('td', { class: 'num', text: money(u.volume_sum) }),
        el('td', { class: 'num', text: intFmt(u.scans_30d) }),
        el('td', { class: 'num', text: intFmt(u.scans_24h == null ? 0 : u.scans_24h) + ' / ' + capOf(u) })));
    }
    if (!list.length) {
      tbody.append(el('tr', {}, el('td', { colspan: '7', class: 'msg-info', text: 'No matching users.' })));
    }
  };

  // Keystrokes re-render only the table body — the input keeps focus.
  search.addEventListener('input', () => {
    state.usersQuery = search.value;
    renderRows();
  });

  const tbl = el('table', {},
    el('thead', {}, el('tr', {},
      sortableTh('email', 'Email'),
      sortableTh('created_at', 'Joined'),
      sortableTh('last_active', 'Last active'),
      sortableTh('deal_count', 'Deals', 'num'),
      sortableTh('volume_sum', 'Volume', 'num'),
      sortableTh('scans_30d', 'Scans 30d', 'num'),
      el('th', { class: 'num', text: 'Scans 24h' }))),
    tbody);
  renderRows();
  wrap.append(countEl);
  wrap.append(el('div', { class: 'table-wrap' }, tbl));
  return wrap;
}

// ---------------------------------------------------------------------------
// User detail — sectioned (Overview / Deals / Activity / Deleted)
// ---------------------------------------------------------------------------
function viewUserDetail() {
  const d = state.detail;
  const row = d.row;

  const back = el('button', {
    class: 'btn-link',
    onclick: () => { state.detail = null; render(); },
  }, '← All users');

  // -- deleted summary view --
  if (d.deleted) {
    const counts = (d.deleted && typeof d.deleted === 'object' && d.deleted.counts && typeof d.deleted.counts === 'object')
      ? d.deleted.counts : d.deleted;
    const entries = counts && typeof counts === 'object'
      ? Object.entries(counts).filter(([, v]) => typeof v === 'number' || typeof v === 'string')
      : [];
    return el('div', {},
      back,
      el('div', { class: 'card', style: 'margin-top:16px' },
        el('h2', { text: 'User deleted' }),
        el('p', { text: (row.email || 'The account') + ' has been permanently deleted.' }),
        entries.length
          ? el('ul', { class: 'counts' }, entries.map(([k, v]) => el('li', { text: humanize(k) + ': ' + v })))
          : el('p', { class: 'msg-info', text: 'No deletion counts returned.' }),
        el('button', {
          class: 'btn',
          onclick: () => { state.detail = null; render(); loadUsers(); },
        }, 'Back to users')));
  }

  const root = el('div', {}, back);

  const badgeSlot = el('span', {}, badges(row));
  root.append(el('div', { class: 'detail-head' },
    el('h2', { text: row.email || row.user_id }),
    badgeSlot));

  if (d.error) root.append(el('p', { class: 'msg msg-err', text: 'Could not load details: ' + d.error }));

  const sections = [['overview', 'Overview'], ['deals', 'Deals'], ['activity', 'Activity'], ['deleted', 'Deleted']];
  root.append(el('nav', { class: 'subtabs' }, sections.map(([id, label]) =>
    el('button', {
      class: 'tab' + (d.section === id ? ' active' : ''),
      onclick: () => switchSection(id),
    }, label))));

  if (d.section === 'deals') root.append(sectionDeals(d));
  else if (d.section === 'activity') root.append(sectionActivity(d));
  else if (d.section === 'deleted') root.append(sectionDeleted(d));
  else root.append(sectionOverview(d, badgeSlot));

  return root;
}

function switchSection(id) {
  const d = state.detail;
  if (!d) return;
  d.section = id;
  render();
  if (id === 'deals' && d.deals.rows === null) loadDeals();
  if (id === 'activity' && d.activity.rows === null) loadActivity();
  if (id === 'deleted' && d.deletedDeals.rows === null) loadDeletedDeals();
}

// -- Overview: aggregates + note + settings + cap/pause + actions + delete --
function sectionOverview(d, badgeSlot) {
  const row = d.row;
  const isAdmin = !!row.is_admin;
  const adminTip = 'Admin accounts cannot be banned or deleted';
  const root = el('div', {});
  const refreshBadges = () => { badgeSlot.textContent = ''; badges(row).forEach((b) => badgeSlot.append(b)); };

  // -- aggregates --
  const a = Object.assign({}, row, (d.data && d.data.aggregates) || {});
  const items = [
    ['Joined', fmtDateTime(a.created_at)],
    ['Last sign-in', fmtDateTime(a.last_sign_in_at)],
    ['Last deal', fmtDateTime(a.last_deal_at)],
    ['Deals', intFmt(a.deal_count)],
    ['Volume', money(a.volume_sum)],
    ['Scans 30d', intFmt(a.scans_30d)],
    ['Scans 24h', intFmt(a.scans_24h == null ? 0 : a.scans_24h) + ' / ' + capOf(a)],
    ['Tokens in (30d)', intFmt(a.input_tokens_30d)],
    ['Tokens out (30d)', intFmt(a.output_tokens_30d)],
  ];
  if (a.banned && a.banned_until) items.push(['Banned until', fmtDateTime(a.banned_until)]);
  root.append(el('dl', { class: 'agg-grid' }, items.map(([k, v]) =>
    el('div', { class: 'agg-item' }, el('dt', { text: k }), el('dd', { text: v })))));

  // -- admin note --
  root.append(el('h3', { text: 'Admin note' }));
  const noteArea = el('textarea', { class: 'note-area', rows: '3', placeholder: 'Private operator note for this user' });
  const noteFromDetail = d.data && d.data.aggregates && typeof d.data.aggregates.note === 'string'
    ? d.data.aggregates.note : null;
  noteArea.value = noteFromDetail != null ? noteFromDetail : (typeof row.note === 'string' ? row.note : '');
  const noteMsg = el('p', { class: 'msg' });
  const noteSave = el('button', { class: 'btn btn-primary btn-small' }, 'Save note');
  noteSave.addEventListener('click', async () => {
    noteSave.disabled = true;
    setMsg(noteMsg, 'info', 'Saving…');
    try {
      await adminApi('set_user_note', { user_id: row.user_id, note: noteArea.value });
      row.note = noteArea.value;
      if (d.data && d.data.aggregates) d.data.aggregates.note = noteArea.value;
      refreshBadges();
      setMsg(noteMsg, 'ok', noteArea.value.trim() ? 'Note saved.' : 'Note cleared.');
    } catch (e) {
      if (!e.handled) setMsg(noteMsg, 'err', e.message);
    }
    noteSave.disabled = false;
  });
  root.append(noteArea, el('div', { class: 'btn-row' }, noteSave), noteMsg);

  // -- user settings (if the backend returned any) --
  const us = d.data && d.data.settings;
  if (us && typeof us === 'object') {
    const entries = Object.entries(us).filter(([k]) => !['user_id', 'id', 'created_at', 'updated_at'].includes(k));
    if (entries.length) {
      root.append(el('h3', { text: 'User settings' }));
      root.append(el('dl', { class: 'agg-grid' }, entries.map(([k, v]) =>
        el('div', { class: 'agg-item' },
          el('dt', { text: humanize(k) }),
          el('dd', { text: v == null ? '—' : (typeof v === 'object' ? JSON.stringify(v) : String(v)) })))));
    }
  }

  // -- scan cap editor + pause/resume --
  root.append(el('h3', { text: 'Daily scan cap' }));
  const defCap = state.config ? state.config.default_daily_scan_cap : undefined;
  const defLabel = 'default' + (defCap != null ? ' (' + defCap + ')' : ' (unknown)');
  const capRow = d.data && d.data.cap;
  let currentCap = capRow && capRow.daily_cap != null ? capRow.daily_cap
    : (row.daily_cap != null ? row.daily_cap : null);
  const currentLabel = el('span', { text: currentCap != null ? String(currentCap) : defLabel });
  const capMsg = el('p', { class: 'msg' });
  const capInput = el('input', {
    type: 'number', min: '0', step: '1', class: 'input-small',
    value: currentCap != null ? String(currentCap) : '', placeholder: 'cap',
  });
  const capNote = el('input', { type: 'text', class: 'input-note', placeholder: 'Note (optional)' });
  const capSave = el('button', { class: 'btn btn-primary btn-small' }, 'Save');
  const capClear = el('button', { class: 'btn btn-small' }, 'Clear to default');
  const pauseBtn = el('button', { class: 'btn btn-small' }, '…');

  const syncPause = () => {
    const paused = currentCap === 0;
    pauseBtn.textContent = paused ? 'Resume scanning' : 'Pause scanning';
    pauseBtn.className = 'btn btn-small' + (paused ? ' btn-primary' : ' btn-danger-outline');
  };
  syncPause();

  async function applyCap(value, noteOverride) {
    capSave.disabled = capClear.disabled = pauseBtn.disabled = true;
    setMsg(capMsg, 'info', 'Saving…');
    try {
      const params = { user_id: row.user_id, daily_cap: value };
      const noteVal = noteOverride !== undefined ? noteOverride : capNote.value.trim();
      if (noteVal) params.note = noteVal;
      await adminApi('set_scan_cap', params);
      row.daily_cap = value;
      currentCap = value;
      currentLabel.textContent = value != null ? String(value) : defLabel;
      capInput.value = value != null ? String(value) : '';
      syncPause();
      setMsg(capMsg, 'ok', value === 0 ? 'Scanning paused (cap 0).'
        : value != null ? 'Cap saved.' : 'Override cleared — using the default cap.');
    } catch (e) {
      if (!e.handled) setMsg(capMsg, 'err', e.message);
    }
    capSave.disabled = capClear.disabled = pauseBtn.disabled = false;
  }

  capSave.addEventListener('click', () => {
    const raw = capInput.value.trim();
    if (raw === '') { setMsg(capMsg, 'err', 'Enter a cap, or use “Clear to default”.'); return; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) { setMsg(capMsg, 'err', 'The cap must be a non-negative whole number.'); return; }
    applyCap(n);
  });
  capClear.addEventListener('click', () => applyCap(null));
  pauseBtn.addEventListener('click', () => {
    const paused = currentCap === 0;
    applyCap(paused ? null : 0, paused ? undefined : 'paused via panel');
  });

  root.append(el('p', { class: 'hint' }, 'Current: ', currentLabel));
  root.append(el('div', { class: 'cap-row' }, capInput, capNote, capSave, capClear, pauseBtn));
  root.append(el('p', { class: 'hint', text: 'Pause sets this user’s cap to 0; Resume clears the override back to the default cap.' }));
  root.append(capMsg);

  // -- account actions --
  root.append(el('h3', { text: 'Account actions' }));
  const actMsg = el('p', { class: 'msg' });
  const actConfirm = el('div', {});

  const banBtn = el('button', {
    class: 'btn' + (row.banned ? '' : ' btn-danger-outline'),
    disabled: isAdmin,
    title: isAdmin ? adminTip : null,
  }, row.banned ? 'Unban user' : 'Ban user');

  banBtn.addEventListener('click', () => {
    actConfirm.textContent = '';
    const banning = !row.banned;
    actConfirm.append(el('div', { class: 'confirm-box' + (banning ? ' danger' : '') },
      el('p', {
        text: banning
          ? 'Ban this user? They will no longer be able to sign in. Note: an existing session can stay valid for up to ~1 hour.'
          : 'Unban this user? They will be able to sign in again.',
      }),
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn ' + (banning ? 'btn-danger' : 'btn-primary'),
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await adminApi(banning ? 'ban_user' : 'unban_user', { user_id: row.user_id });
              row.banned = banning;
              actConfirm.textContent = '';
              banBtn.textContent = row.banned ? 'Unban user' : 'Ban user';
              banBtn.className = 'btn' + (row.banned ? '' : ' btn-danger-outline');
              refreshBadges();
              setMsg(actMsg, 'ok', banning
                ? 'User banned. Their existing session may remain valid for up to ~1 hour.'
                : 'User unbanned.');
            } catch (err) {
              e.target.disabled = false;
              if (!err.handled) setMsg(actMsg, 'err', err.message);
            }
          },
        }, banning ? 'Confirm ban' : 'Confirm unban'),
        el('button', { class: 'btn', onclick: () => { actConfirm.textContent = ''; } }, 'Cancel'))));
  });

  const emailAction = (label, action, okText) => {
    const btn = el('button', { class: 'btn' }, label);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      setMsg(actMsg, 'info', 'Sending…');
      try {
        await adminApi(action, { email: row.email });
        setMsg(actMsg, 'ok', okText);
      } catch (e) {
        if (!e.handled) setMsg(actMsg, 'err', e.message);
      }
      btn.disabled = false;
    });
    return btn;
  };

  root.append(el('div', { class: 'action-row' },
    banBtn,
    emailAction('Resend confirmation', 'resend_confirmation', 'Confirmation email sent.'),
    emailAction('Send password reset', 'send_password_reset', 'Password reset email sent.')));
  root.append(actMsg);
  root.append(actConfirm);

  // -- delete user --
  const delZone = el('div', { class: 'danger-zone' }, el('h3', { text: 'Delete user' }));
  const delMsg = el('p', { class: 'msg' });
  const delConfirm = el('div', {});
  const delBtn = el('button', {
    class: 'btn btn-danger-outline',
    disabled: isAdmin,
    title: isAdmin ? adminTip : null,
  }, 'Delete user…');

  delBtn.addEventListener('click', () => {
    delConfirm.textContent = '';
    const emailInput = el('input', { type: 'email', placeholder: row.email || 'email', autocomplete: 'off' });
    const confirmBtn = el('button', { class: 'btn btn-danger', disabled: true }, 'Permanently delete');
    emailInput.addEventListener('input', () => {
      confirmBtn.disabled = emailInput.value !== row.email;
    });
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      setMsg(delMsg, 'info', 'Deleting…');
      try {
        const resp = await adminApi('delete_user', { user_id: row.user_id, confirm_email: emailInput.value });
        state.users = (state.users || []).filter((u) => u.user_id !== row.user_id);
        state.detail.deleted = (resp && resp.deleted) || {};
        render();
      } catch (e) {
        confirmBtn.disabled = emailInput.value !== row.email;
        if (!e.handled) setMsg(delMsg, 'err', e.message);
      }
    });
    delConfirm.append(el('div', { class: 'confirm-box danger' },
      el('p', { text: 'This permanently deletes the account, deals, images, settings, and audit history. This cannot be undone.' }),
      el('label', {}, 'Type the user’s email exactly to confirm:', emailInput),
      el('div', { class: 'btn-row' },
        confirmBtn,
        el('button', { class: 'btn', onclick: () => { delConfirm.textContent = ''; setMsg(delMsg, 'info', ''); } }, 'Cancel'))));
  });

  delZone.append(delBtn, delConfirm, delMsg);
  root.append(delZone);

  // -- scan events --
  root.append(el('h3', { text: 'Recent scan events (last 50)' }));
  if (!d.data) {
    root.append(el('p', { class: 'msg-info', text: 'Loading…' }));
  } else if (!d.data.events.length) {
    root.append(el('p', { class: 'msg-info', text: 'No scan events.' }));
  } else {
    const rows = d.data.events.map((ev) => {
      const meta = ev.meta || {};
      const attempts = Array.isArray(meta.attempts) ? meta.attempts : null;
      const retried = !!(attempts && attempts.length > 1);
      const recovered = Array.isArray(meta.recovered_on_retry) && meta.recovered_on_retry.some(Boolean);
      const ts = ev.created_at || ev.at || ev.timestamp || null;
      const lcf = Array.isArray(ev.low_confidence_fields) ? ev.low_confidence_fields : [];
      const tokTxt = (ev.input_tokens == null ? '—' : intFmt(ev.input_tokens))
        + ' / ' + (ev.output_tokens == null ? '—' : intFmt(ev.output_tokens));
      return el('tr', {},
        el('td', { title: utcStr(ts), text: fmtDateTime(ts) }),
        el('td', {}, el('span', {
          class: statusClass(ev.status),
          title: lcf.length ? 'Low confidence: ' + lcf.join(', ') : null,
          text: ev.status || '—',
        })),
        el('td', { text: ev.model || '—' }),
        el('td', { class: 'num', text: tokTxt }),
        el('td', { class: 'num', text: fmtDur(ev.duration_ms) }),
        el('td', { text: ev.error_code || '' }),
        el('td', {},
          retried ? el('span', { class: 'badge badge-retried', text: 'retried' }) : null,
          recovered ? el('span', { class: 'badge badge-recovered', text: 'recovered' }) : null));
    });
    root.append(el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', { text: 'Time' }),
          el('th', { text: 'Status' }),
          el('th', { text: 'Model' }),
          el('th', { class: 'num', text: 'Tokens in / out' }),
          el('th', { class: 'num', text: 'Duration' }),
          el('th', { text: 'Error' }),
          el('th', { text: '' }))),
        el('tbody', {}, rows))));
  }

  return root;
}

// -- Deals section: server-paginated search/browse --
function sectionDeals(d) {
  const s = d.deals;
  const root = el('div', {});

  const search = el('input', { type: 'text', class: 'input-search', placeholder: 'Owner, account #, or deal id…' });
  search.value = s.query;
  const cancelledSel = el('select', { class: 'select-small' },
    el('option', { value: 'any', text: 'Cancelled: any' }),
    el('option', { value: 'false', text: 'Non-cancelled' }),
    el('option', { value: 'true', text: 'Cancelled only' }));
  cancelledSel.value = s.cancelled;
  const penderSel = el('select', { class: 'select-small' },
    el('option', { value: 'any', text: 'Type: any' }),
    el('option', { value: 'true', text: 'Penders' }),
    el('option', { value: 'false', text: 'Full downs' }));
  penderSel.value = s.pender;
  const go = () => {
    s.query = search.value;
    s.cancelled = cancelledSel.value;
    s.pender = penderSel.value;
    s.offset = 0;
    loadDeals();
  };
  const searchBtn = el('button', { class: 'btn btn-primary btn-small', onclick: go }, 'Search');
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  cancelledSel.addEventListener('change', go);
  penderSel.addEventListener('change', go);

  root.append(el('div', { class: 'deals-controls' }, search, searchBtn, cancelledSel, penderSel));
  if (s.error) root.append(el('p', { class: 'msg msg-err', text: s.error }));
  if (s.rows === null) {
    root.append(el('p', { class: 'msg-info', text: 'Loading deals…' }));
    return root;
  }
  if (!s.rows.length) {
    root.append(el('p', { class: 'msg-info', text: s.query || s.cancelled !== 'any' || s.pender !== 'any' ? 'No deals match.' : 'No deals.' }));
    return root;
  }

  const tbl = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: 'Date' }),
      el('th', { text: 'Owner' }),
      el('th', { text: 'Account' }),
      el('th', { class: 'num', text: 'Volume' }),
      el('th', { class: 'num', text: 'Commission' }),
      el('th', { text: 'Status' }),
      el('th', { text: 'Entry' }))),
    el('tbody', {}, s.rows.map((deal) =>
      el('tr', { class: 'clickable', onclick: () => openDrawer(deal.id) },
        el('td', { text: fmtISODate(deal.deal_date) }),
        el('td', { text: deal.owner_name || '—' }),
        el('td', { class: 'mono-sm', text: deal.account_number || '—' }),
        el('td', { class: 'num', text: money(deal.volume) }),
        el('td', { class: 'num', text: money(deal.commission_amount) }),
        el('td', {}, dealStatusBadge(deal), sourceBadge(deal.commission_source)),
        el('td', { text: deal.entry_method || '—' })))));
  root.append(el('div', { class: 'table-wrap' }, tbl));

  // pagination
  const from = s.offset + 1;
  const to = s.offset + s.rows.length;
  const pager = el('div', { class: 'pager' },
    el('button', {
      class: 'btn btn-small', disabled: s.offset === 0,
      onclick: () => { s.offset = Math.max(0, s.offset - 50); loadDeals(); },
    }, '‹ Prev'),
    el('span', { class: 'hint', text: from + '–' + to + ' of ' + intFmt(s.total) }),
    el('button', {
      class: 'btn btn-small', disabled: to >= s.total,
      onclick: () => { s.offset = s.offset + 50; loadDeals(); },
    }, 'Next ›'));
  root.append(pager);
  return root;
}

// -- Activity section: audit timeline, FIELD NAMES only --
function sectionActivity(d) {
  const s = d.activity;
  const root = el('div', {});
  root.append(el('p', { class: 'hint', text: 'Row history across deals and settings. Field names only here — open a deal to see value-level diffs.' }));
  if (s.error) root.append(el('p', { class: 'msg msg-err', text: s.error }));
  if (s.rows === null) {
    root.append(el('p', { class: 'msg-info', text: 'Loading activity…' }));
    return root;
  }
  if (!s.rows.length) {
    root.append(el('p', { class: 'msg-info', text: 'No recorded activity.' }));
    return root;
  }

  const items = s.rows.map((a) => {
    let desc;
    if (a.action === 'INSERT') desc = el('span', { class: 'tl-created', text: 'row created' });
    else if (a.action === 'DELETE') desc = el('span', { class: 'tl-deleted', text: 'row deleted' });
    else {
      const names = changedFieldNames(a);
      const shown = names.slice(0, 12).map(humanize).join(', ');
      const extra = names.length > 12 ? ' +' + (names.length - 12) + ' more' : '';
      desc = el('span', { class: 'tl-fields', text: names.length ? shown + extra : 'no visible field changes' });
    }
    const isDeal = a.table_name === 'deals';
    return el('li', {
      class: isDeal ? 'clickable' : null,
      title: isDeal ? 'Open deal' : null,
      onclick: isDeal ? () => openDrawer(a.row_id) : null,
    },
      el('span', { class: 'tl-time', title: utcStr(a.changed_at), text: fmtDateTime(a.changed_at) }),
      ' ',
      el('span', { class: 'badge badge-table', text: a.table_name }),
      el('span', { class: 'badge badge-action-' + String(a.action).toLowerCase(), text: a.action }),
      ' ',
      desc);
  });
  root.append(el('ul', { class: 'timeline' }, items));

  if (s.nextBefore) {
    root.append(el('div', { class: 'load-more' },
      el('button', {
        class: 'btn btn-small', disabled: s.loadingMore,
        onclick: () => loadActivity(true),
      }, s.loadingMore ? 'Loading…' : 'Load older')));
  }
  return root;
}

// -- Deleted section: DELETE snapshots + restore --
function sectionDeleted(d) {
  const s = d.deletedDeals;
  const root = el('div', {});
  root.append(el('p', { class: 'hint', text: 'Deals deleted from this account, reconstructable from their audit snapshot.' }));
  if (s.error) root.append(el('p', { class: 'msg msg-err', text: s.error }));
  if (s.rows === null) {
    root.append(el('p', { class: 'msg-info', text: 'Loading deleted deals…' }));
    return root;
  }
  if (!s.rows.length) {
    root.append(el('p', { class: 'msg-info', text: 'No deleted deals.' }));
    return root;
  }

  const restoreMsg = el('p', { class: 'msg' });
  const confirmSlot = el('div', {});

  const tbl = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: 'Deleted' }),
      el('th', { text: 'Owner' }),
      el('th', { text: 'Deal date' }),
      el('th', { class: 'num', text: 'Volume' }),
      el('th', { class: 'num', text: 'Commission' }),
      el('th', { text: 'Source' }),
      el('th', { text: '' }))),
    el('tbody', {}, s.rows.map((r) =>
      el('tr', {},
        el('td', { title: utcStr(r.changed_at), text: fmtDateTime(r.changed_at) }),
        el('td', {}, r.owner_name || '—',
          r.cancelled ? el('span', { class: 'badge badge-cancelled', text: 'Cancelled' }) : null),
        el('td', { text: fmtISODate(r.deal_date) }),
        el('td', { class: 'num', text: money(r.volume) }),
        el('td', { class: 'num', text: money(r.commission_amount) }),
        el('td', {}, sourceBadge(r.commission_source)),
        el('td', {}, el('button', {
          class: 'btn btn-small',
          onclick: () => {
            confirmSlot.textContent = '';
            const goBtn = el('button', { class: 'btn btn-primary' }, 'Restore deal');
            goBtn.addEventListener('click', async () => {
              goBtn.disabled = true;
              setMsg(restoreMsg, 'info', 'Restoring…');
              try {
                const resp = await adminApi('restore_deal', { deal_id: r.row_id });
                s.rows = s.rows.filter((x) => x.row_id !== r.row_id);
                d.deals.rows = null; // deals list is stale now
                confirmSlot.textContent = '';
                setMsg(restoreMsg, 'ok', 'Deal restored.');
                render();
                openDrawer((resp && resp.deal && resp.deal.id) || r.row_id);
              } catch (e) {
                goBtn.disabled = false;
                if (e.handled) return;
                const msgs = {
                  no_snapshot: 'No deletion snapshot exists for this deal.',
                  already_exists: 'A deal with this id already exists — it was likely already restored.',
                };
                setMsg(restoreMsg, 'err', msgs[e.code] || e.message);
              }
            });
            confirmSlot.append(el('div', { class: 'confirm-box' },
              el('p', { text: 'Restores this deal exactly as it was at deletion, same ID and commission source.' }),
              el('p', { class: 'hint', text: (r.owner_name || 'Unknown owner') + ' · ' + fmtISODate(r.deal_date) + ' · ' + money(r.volume) }),
              el('div', { class: 'btn-row' },
                goBtn,
                el('button', { class: 'btn', onclick: () => { confirmSlot.textContent = ''; } }, 'Cancel'))));
          },
        }, 'Restore…'))))));
  root.append(el('div', { class: 'table-wrap' }, tbl));
  root.append(confirmSlot);
  root.append(restoreMsg);
  return root;
}

// ---------------------------------------------------------------------------
// Deal drawer
// ---------------------------------------------------------------------------
function viewDrawer() {
  const dr = state.drawer;
  const editing = !!dr.edit;

  const backdrop = el('div', {
    class: 'drawer-backdrop',
    onclick: () => { if (!state.drawer.edit) closeDrawer(); },
  });
  const panel = el('div', { class: 'drawer' });

  const closeBtn = el('button', { class: 'btn btn-small', onclick: () => {
    if (state.drawer.edit) return; // editing: use Cancel in the footer
    closeDrawer();
  }, text: '✕ Close', disabled: editing, title: editing ? 'Finish or cancel the edit first' : null });

  if (!dr.data && !dr.error) {
    panel.append(el('div', { class: 'drawer-head' }, el('h2', { text: 'Deal' }), closeBtn));
    panel.append(el('p', { class: 'msg-info', text: 'Loading deal…' }));
    return el('div', {}, backdrop, panel);
  }
  if (dr.error) {
    panel.append(el('div', { class: 'drawer-head' }, el('h2', { text: 'Deal' }), closeBtn));
    panel.append(el('p', { class: 'msg msg-err', text: dr.error }));
    return el('div', {}, backdrop, panel);
  }

  const deal = dr.data.deal;
  const owners = Array.isArray(deal.owner_names) ? deal.owner_names : [];
  const title = owners.length ? owners.join(', ') : 'Deal';

  const head = el('div', { class: 'drawer-head' },
    el('div', {},
      el('h2', { text: title }),
      el('p', { class: 'drawer-sub mono-sm', text: deal.id || '' })),
    el('div', { class: 'btn-row' },
      !editing ? el('button', { class: 'btn btn-primary btn-small', onclick: startEdit }, 'Edit') : null,
      closeBtn));
  panel.append(head);

  panel.append(el('div', { class: 'drawer-badges' },
    dealStatusBadge(deal), sourceBadge(deal.commission_source),
    el('span', { class: 'badge badge-table', text: deal.entry_method || '—' })));

  if (editing) panel.append(drawerEdit(dr));
  else panel.append(drawerRead(dr));

  return el('div', {}, backdrop, panel);
}

function drawerRead(dr) {
  const deal = dr.data.deal;
  const root = el('div', {});

  for (const [group, cols] of DEAL_GROUPS) {
    root.append(el('h4', { class: 'group-head', text: group }));
    root.append(el('dl', { class: 'agg-grid' }, cols.map((col) =>
      el('div', { class: 'agg-item' },
        el('dt', { text: humanize(col) }),
        el('dd', {
          class: col === 'id' || col === 'user_id' || col === 'scan_event_id' ? 'mono-sm' : null,
          text: readValue(col, deal[col]),
          title: deal[col] != null && typeof deal[col] === 'object' ? truncate(JSON.stringify(deal[col]), 500) : null,
        })))));
  }

  // -- linked scan event --
  if (deal.scan_event_id) {
    root.append(el('h4', { class: 'group-head', text: 'Scan event' }));
    const ev = dr.data.scan_event;
    if (!ev) {
      root.append(el('p', { class: 'msg-info', text: 'Scan event ' + deal.scan_event_id + ' no longer exists (purged).' }));
    } else {
      const items = [
        ['Time', fmtDateTime(ev.created_at)],
        ['Status', ev.status || '—'],
        ['Model', ev.model || '—'],
        ['Prompt', ev.prompt_version || '—'],
        ['Tokens in / out', (ev.input_tokens == null ? '—' : intFmt(ev.input_tokens)) + ' / ' + (ev.output_tokens == null ? '—' : intFmt(ev.output_tokens))],
        ['Duration', fmtDur(ev.duration_ms)],
        ['Error', ev.error_code || '—'],
      ];
      root.append(el('dl', { class: 'agg-grid' }, items.map(([k, v]) =>
        el('div', { class: 'agg-item' }, el('dt', { text: k }), el('dd', { text: v })))));
    }
  }

  // -- per-deal audit timeline with VALUE diffs --
  root.append(el('h4', { class: 'group-head', text: 'History' }));
  const audit = dr.data.audit || [];
  if (!audit.length) {
    root.append(el('p', { class: 'msg-info', text: 'No audit history (predates the audit trigger).' }));
  } else {
    root.append(el('ul', { class: 'timeline' }, audit.map((a) => {
      const li = el('li', {},
        el('span', { class: 'tl-time', title: utcStr(a.changed_at), text: fmtDateTime(a.changed_at) }),
        ' ',
        el('span', { class: 'badge badge-action-' + String(a.action).toLowerCase(), text: a.action }));
      if (a.action === 'UPDATE') {
        const names = changedFieldNames(a);
        const oldR = a.old_row || {};
        const newR = a.new_row || {};
        li.append(el('div', { class: 'tl-diffs' }, names.map((k) =>
          el('div', { class: 'tl-diff' },
            el('span', { class: 'tl-field', text: humanize(k) + ': ' }),
            el('span', { class: 'diff-old', text: fmtVal(oldR[k]) }),
            ' → ',
            el('span', { class: 'diff-new', text: fmtVal(newR[k]) })))));
      } else {
        li.append(' ', el('span', {
          class: a.action === 'DELETE' ? 'tl-deleted' : 'tl-created',
          text: a.action === 'DELETE' ? 'row deleted' : 'row created',
        }));
      }
      return li;
    })));
  }
  return root;
}

function startEdit() {
  const dr = state.drawer;
  if (!dr || !dr.data) return;
  dr.edit = { values: {}, confirm: '', force: false, msg: '', saving: false };
  render();
}

function drawerEdit(dr) {
  const deal = dr.data.deal;
  const edit = dr.edit;
  const root = el('div', {});
  const imported = deal.commission_source === 'imported';

  // ---- grouped inputs ----
  for (const [group, cols] of DEAL_GROUPS) {
    root.append(el('h4', { class: 'group-head', text: group }));
    const grid = el('div', { class: 'edit-grid' });
    for (const col of cols) {
      grid.append(el('label', { class: 'edit-label', text: humanize(col) }));
      if (IMMUTABLE_COLS.includes(col)) {
        grid.append(el('span', { class: 'mono-sm ro-val', text: deal[col] == null ? '—' : String(deal[col]) }));
        continue;
      }
      const t = FIELD_TYPES[col] || 'text';
      const raw = col in edit.values ? edit.values[col] : encodeFieldValue(col, deal[col]);
      let input;
      if (Array.isArray(t)) {
        input = el('select', {}, t.map((opt) =>
          el('option', { value: opt, text: opt === '' ? '(none)' : opt })));
        // unknown ≠ default: a NOT NULL enum that is null (legacy) or holds an
        // out-of-list value renders its ACTUAL state as an extra option — the
        // select must never quietly display a valid-looking choice.
        if (raw === '' && !t.includes('')) {
          input.prepend(el('option', { value: '', text: '(unset)' }));
        } else if (raw !== '' && !t.includes(raw)) {
          input.prepend(el('option', { value: raw, text: raw + ' (current)' }));
        }
        input.value = raw;
      } else if (t === 'bool') {
        input = el('select', {},
          el('option', { value: 'true', text: 'true' }),
          el('option', { value: 'false', text: 'false' }));
        input.value = raw === '' ? 'false' : raw;
        if (raw === '') { input.prepend(el('option', { value: '', text: '(unset)' })); input.value = ''; }
      } else if (t === 'bool-null') {
        input = el('select', {},
          el('option', { value: '', text: '(null)' }),
          el('option', { value: 'true', text: 'true' }),
          el('option', { value: 'false', text: 'false' }));
        input.value = raw;
      } else if (t === 'lines') {
        input = el('textarea', { rows: '3', class: 'edit-area', placeholder: 'one per line' });
        input.value = raw;
      } else if (t === 'json' || t === 'json-array') {
        input = el('textarea', { rows: '4', class: 'edit-area mono-sm', placeholder: t === 'json-array' ? '[]' : 'null' });
        input.value = raw;
      } else if (t === 'date') {
        input = el('input', { type: 'date' });
        input.value = raw;
      } else if (t === 'number') {
        input = el('input', { type: 'number', step: 'any' });
        input.value = raw;
      } else {
        input = el('input', { type: 'text' });
        input.value = raw;
      }
      const evName = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(evName, () => {
        edit.values[col] = input.value;
        updateFooter();
      });
      if (GUARD_FIELDS.includes(col) && imported) input.classList.add('guard-field');
      grid.append(input);
    }
    root.append(grid);
  }

  // ---- footer: warnings + diff + confirm + save ----
  const footer = el('div', { class: 'edit-footer' });

  if (imported) {
    footer.append(el('div', { class: 'warn-imported' },
      el('strong', { text: 'PAID-TRUTH DEAL: ' }),
      'commission figures are payroll ground truth (§3.11c). Changing money/commission fields requires force and breaks reconciliation if wrong.'));
  } else {
    footer.append(el('div', { class: 'warn-derived' },
      'Server edits do NOT recompute derived fields (volume, commission, pender dates). If you change inputs, update derived fields here yourself — or have the rep edit in-app, which recomputes.'));
  }

  const diffPanel = el('div', { class: 'diff-panel' });
  footer.append(diffPanel);

  let forceRow = null;
  let forceCheck = null;
  if (imported) {
    forceCheck = el('input', { type: 'checkbox' });
    forceCheck.checked = edit.force;
    forceCheck.addEventListener('change', () => { edit.force = forceCheck.checked; updateFooter(); });
    forceRow = el('label', { class: 'force-row' }, forceCheck,
      ' Force this edit (force_imported) — required when changing commission-adjacent fields');
    footer.append(forceRow);
  }

  const confirmInput = el('input', { type: 'text', class: 'input-small confirm-input', placeholder: 'CONFIRM', autocomplete: 'off' });
  confirmInput.value = edit.confirm;
  const saveBtn = el('button', { class: 'btn btn-danger' }, 'Save changes');
  const cancelBtn = el('button', { class: 'btn', onclick: () => { dr.edit = null; render(); } }, 'Cancel');
  const saveMsg = el('p', { class: 'msg' });
  if (edit.msg) setMsg(saveMsg, 'err', edit.msg);

  confirmInput.addEventListener('input', () => {
    edit.confirm = confirmInput.value;
    updateFooter();
  });

  function computePending() {
    const pending = {};
    const errors = {};
    for (const col of Object.keys(edit.values)) {
      const res = parseFieldValue(col, edit.values[col]);
      if (res.error) { errors[col] = res.error; continue; }
      const orig = deal[col] === undefined ? null : deal[col];
      if (!valueEq(res.value, orig)) pending[col] = res.value;
    }
    return { pending, errors };
  }

  function updateFooter() {
    const { pending, errors } = computePending();
    const keys = Object.keys(pending);
    const errKeys = Object.keys(errors);
    diffPanel.textContent = '';
    if (!keys.length && !errKeys.length) {
      diffPanel.append(el('p', { class: 'hint', text: 'No pending changes.' }));
    } else {
      if (keys.length) diffPanel.append(el('p', { class: 'diff-head', text: 'Pending changes (' + keys.length + ')' }));
      for (const k of keys) {
        diffPanel.append(el('div', { class: 'diff-row' },
          el('span', { class: 'tl-field', text: humanize(k) + ': ' }),
          el('span', { class: 'diff-old', text: fmtVal(deal[k] === undefined ? null : deal[k]) }),
          ' → ',
          el('span', { class: 'diff-new', text: fmtVal(pending[k]) }),
          GUARD_FIELDS.includes(k) && imported
            ? el('span', { class: 'badge badge-unpaid', text: 'guarded' }) : null));
      }
      for (const k of errKeys) {
        diffPanel.append(el('div', { class: 'diff-row' },
          el('span', { class: 'tl-field', text: humanize(k) + ': ' }),
          el('span', { class: 'msg-err', text: errors[k] })));
      }
    }
    const guardTouched = imported && keys.some((k) => GUARD_FIELDS.includes(k));
    if (forceRow) forceRow.classList.toggle('force-needed', guardTouched && !edit.force);
    saveBtn.disabled = edit.saving || !keys.length || errKeys.length > 0 || edit.confirm !== 'CONFIRM';
    return { pending, errors };
  }

  saveBtn.addEventListener('click', async () => {
    const { pending, errors } = updateFooter();
    if (Object.keys(errors).length || !Object.keys(pending).length || edit.confirm !== 'CONFIRM') return;
    edit.saving = true;
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    setMsg(saveMsg, 'info', 'Saving…');
    const params = { deal_id: dr.dealId, fields: pending };
    if (edit.force) params.force_imported = true;
    try {
      const resp = await adminApi('update_deal', params);
      dr.data.deal = (resp && resp.deal) || dr.data.deal;
      dr.edit = null;
      render();
      refreshDrawerQuiet(dr);       // pull the fresh audit row
      if (state.detail) loadDeals(true); // keep the table behind in sync
    } catch (e) {
      edit.saving = false;
      cancelBtn.disabled = false;
      if (e.handled) return;
      const msgs = {
        imported_guard: 'Blocked: this deal’s commission figures are imported payroll truth. Check the force box to proceed (imported_guard).',
        unknown_field: 'The server rejected a field name (unknown_field): ' + e.message,
        immutable_field: 'id and user_id can never be edited (immutable_field).',
        invalid_value: 'A value doesn’t fit its column: ' + e.message,
        deal_not_found: 'This deal no longer exists — it may have been deleted.',
      };
      edit.msg = msgs[e.code] || e.message;
      setMsg(saveMsg, 'err', edit.msg);
      updateFooter();
    }
  });

  footer.append(el('div', { class: 'save-row' },
    el('span', { class: 'hint', text: 'Type CONFIRM to enable Save:' }),
    confirmInput, saveBtn, cancelBtn));
  footer.append(saveMsg);
  root.append(footer);
  updateFooter();
  return root;
}

function statusClass(s) {
  if (s === 'success') return 'st st-success';
  if (s === 'parse_fail' || s === 'api_fail') return 'st st-fail';
  if (typeof s === 'string' && s.indexOf('blocked') === 0) return 'st st-blocked';
  return 'st st-other';
}

// ---------------------------------------------------------------------------
// Stats tab (scan_stats section unchanged + new Health section)
// ---------------------------------------------------------------------------
function viewStats() {
  const wrap = el('div', {},
    el('div', { class: 'section-head' },
      el('h2', { text: 'Scan stats — last 30 days' }),
      el('button', { class: 'btn btn-small', onclick: () => { loadStats(); loadHealth(); } }, 'Refresh')),
    el('p', { class: 'hint', text: 'Days in UTC.' }));
  if (state.statsError) wrap.append(el('p', { class: 'msg msg-err', text: state.statsError }));
  if (state.stats === null) {
    wrap.append(el('p', { class: 'msg-info', text: 'Loading stats…' }));
    wrap.append(viewHealth());
    return wrap;
  }
  const rows = state.stats;
  const max = Math.max(1, ...rows.map((r) => r.total));

  // pure-CSS horizontal bars of daily totals, segmented by outcome
  const chart = el('div', { class: 'chart' }, rows.map((r) => {
    const failures = r.parse_fail + r.api_fail;
    const blocked = r.blocked_quota + r.blocked_kill_switch;
    const other = Math.max(0, r.total - r.success - failures - blocked);
    const seg = (n, cls, label) => (n > 0
      ? el('span', { class: 'bar-seg ' + cls, style: 'width:' + (n / max * 100) + '%', title: label + ': ' + n })
      : null);
    return el('div', { class: 'bar-row' },
      el('span', { class: 'bar-label', text: r.day.slice(5) }),
      el('span', { class: 'bar-track' },
        seg(r.success, 'seg-success', 'success'),
        seg(failures, 'seg-fail', 'failures'),
        seg(blocked, 'seg-blocked', 'blocked'),
        seg(other, 'seg-other', 'other')),
      el('span', { class: 'bar-count', text: r.total ? String(r.total) : '' }));
  }));
  wrap.append(chart);
  wrap.append(el('div', { class: 'chart-legend' },
    el('span', {}, el('span', { class: 'swatch seg-success' }), 'Success'),
    el('span', {}, el('span', { class: 'swatch seg-fail' }), 'Failures'),
    el('span', {}, el('span', { class: 'swatch seg-blocked' }), 'Blocked'),
    el('span', {}, el('span', { class: 'swatch seg-other' }), 'Other')));

  // per-day table with totals row
  const totals = rows.reduce((acc, r) => {
    acc.total += r.total;
    acc.success += r.success;
    acc.failures += r.parse_fail + r.api_fail;
    acc.blocked += r.blocked_quota + r.blocked_kill_switch;
    acc.recovered += r.recovered;
    acc.tokens_in += r.tokens_in;
    acc.tokens_out += r.tokens_out;
    if (r.est_cost_usd != null) { acc.cost += r.est_cost_usd; acc.hasCost = true; }
    return acc;
  }, { total: 0, success: 0, failures: 0, blocked: 0, recovered: 0, tokens_in: 0, tokens_out: 0, cost: 0, hasCost: false });

  const tbl = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: 'Day (UTC)' }),
      el('th', { class: 'num', text: 'Total' }),
      el('th', { class: 'num', text: 'Success' }),
      el('th', { class: 'num', text: 'Failures' }),
      el('th', { class: 'num', text: 'Blocked' }),
      el('th', { class: 'num', text: 'Recovered' }),
      el('th', { class: 'num', text: 'Tokens in' }),
      el('th', { class: 'num', text: 'Tokens out' }),
      el('th', { class: 'num', text: 'Est. cost' }))),
    el('tbody', {}, rows.map((r) =>
      el('tr', {},
        el('td', { text: r.day }),
        el('td', { class: 'num', text: intFmt(r.total) }),
        el('td', { class: 'num', text: intFmt(r.success) }),
        el('td', { class: 'num', text: intFmt(r.parse_fail + r.api_fail) }),
        el('td', { class: 'num', text: intFmt(r.blocked_quota + r.blocked_kill_switch) }),
        el('td', { class: 'num', text: intFmt(r.recovered) }),
        el('td', { class: 'num', text: intFmt(r.tokens_in) }),
        el('td', { class: 'num', text: intFmt(r.tokens_out) }),
        el('td', { class: 'num', text: fmtCost(r.est_cost_usd) })))),
    el('tfoot', {}, el('tr', {},
      el('th', { text: 'Total' }),
      el('td', { class: 'num', text: intFmt(totals.total) }),
      el('td', { class: 'num', text: intFmt(totals.success) }),
      el('td', { class: 'num', text: intFmt(totals.failures) }),
      el('td', { class: 'num', text: intFmt(totals.blocked) }),
      el('td', { class: 'num', text: intFmt(totals.recovered) }),
      el('td', { class: 'num', text: intFmt(totals.tokens_in) }),
      el('td', { class: 'num', text: intFmt(totals.tokens_out) }),
      el('td', { class: 'num', text: totals.hasCost ? fmtCost(totals.cost) : '' }))));
  wrap.append(el('div', { class: 'table-wrap' }, tbl));

  wrap.append(viewHealth());
  return wrap;
}

// Zero-fill health daily rows to a continuous 30-day UTC series.
function zeroFillHealth(daily, days) {
  const byDay = new Map(daily.map((r) => [String(r.date || '').slice(0, 10), r]));
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) || {
      date: key, total: 0, success: 0, parse_fail: 0, api_fail: 0,
      blocked_quota: 0, blocked_kill_switch: 0, recovered_count: 0,
      p50_duration_ms: null, p95_duration_ms: null,
    });
  }
  return out;
}

function viewHealth() {
  const wrap = el('div', { class: 'health-section' },
    el('h2', { text: 'Health — last 30 days' }));
  if (state.healthError) wrap.append(el('p', { class: 'msg msg-err', text: state.healthError }));
  if (state.health === null) {
    wrap.append(el('p', { class: 'msg-info', text: 'Loading health…' }));
    return wrap;
  }
  const h = state.health;

  // -- daily latency / failure-rate table --
  const daily = zeroFillHealth(h.daily, 30);
  wrap.append(el('h3', { text: 'Daily latency & failure rate' }));
  wrap.append(el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: 'Day (UTC)' }),
      el('th', { class: 'num', text: 'Total' }),
      el('th', { class: 'num', text: 'Failures' }),
      el('th', { class: 'num', text: 'Fail rate' }),
      el('th', { class: 'num', text: 'Blocked' }),
      el('th', { class: 'num', text: 'Recovered' }),
      el('th', { class: 'num', text: 'p50' }),
      el('th', { class: 'num', text: 'p95' }))),
    el('tbody', {}, daily.map((r) => {
      const failures = num(r.parse_fail) + num(r.api_fail);
      const blocked = num(r.blocked_quota) + num(r.blocked_kill_switch);
      return el('tr', {},
        el('td', { text: r.date }),
        el('td', { class: 'num', text: intFmt(r.total) }),
        el('td', { class: 'num', text: intFmt(failures) }),
        el('td', { class: 'num', text: r.total > 0 ? pctFmt(failures / r.total) : '—' }),
        el('td', { class: 'num', text: intFmt(blocked) }),
        el('td', { class: 'num', text: intFmt(r.recovered_count) }),
        el('td', { class: 'num', text: fmtDur(r.p50_duration_ms) }),
        el('td', { class: 'num', text: fmtDur(r.p95_duration_ms) }));
    })))));

  // -- prompt_version × model breakdown --
  wrap.append(el('h3', { text: 'By prompt version × model' }));
  if (!h.by_version.length) {
    wrap.append(el('p', { class: 'msg-info', text: 'No scan events in the window.' }));
  } else {
    wrap.append(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { text: 'Prompt' }),
        el('th', { text: 'Model' }),
        el('th', { class: 'num', text: 'Total' }),
        el('th', { class: 'num', text: 'Success rate' }),
        el('th', { class: 'num', text: 'Recovered' }),
        el('th', { class: 'num', text: 'Avg tokens in' }),
        el('th', { class: 'num', text: 'Avg tokens out' }))),
      el('tbody', {}, h.by_version.map((v) =>
        el('tr', {},
          el('td', { text: v.prompt_version || '—' }),
          el('td', { text: v.model || '—' }),
          el('td', { class: 'num', text: intFmt(v.total) }),
          el('td', { class: 'num', text: pctFmt(v.success_rate) }),
          el('td', { class: 'num', text: intFmt(v.recovered_count) }),
          el('td', { class: 'num', text: intFmt(v.avg_input_tokens) }),
          el('td', { class: 'num', text: intFmt(v.avg_output_tokens) })))))));
  }

  // -- recent failures feed --
  wrap.append(el('h3', { text: 'Recent failures (last 25, all time)' }));
  if (!h.recent_failures.length) {
    wrap.append(el('p', { class: 'msg-info', text: 'No failures recorded.' }));
  } else {
    wrap.append(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { text: 'Time' }),
        el('th', { text: 'Email' }),
        el('th', { text: 'Status' }),
        el('th', { text: 'Error' }),
        el('th', { class: 'num', text: 'Duration' }))),
      el('tbody', {}, h.recent_failures.map((r) =>
        el('tr', {},
          el('td', { title: utcStr(r.created_at), text: fmtDateTime(r.created_at) }),
          el('td', { text: r.email || '—' }),
          el('td', {}, el('span', { class: statusClass(r.status), text: r.status || '—' })),
          el('td', { text: r.error_code || '' }),
          el('td', { class: 'num', text: fmtDur(r.duration_ms) })))))));
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------
function viewSettings() {
  const wrap = el('div', {}, el('h2', { text: 'Settings' }));
  if (state.configError) wrap.append(el('p', { class: 'msg msg-err', text: state.configError }));
  const cfg = state.config;
  if (!cfg) {
    wrap.append(el('p', { class: 'msg-info', text: 'Loading…' }));
    return wrap;
  }

  const setMsgEl = el('p', { class: 'msg' });
  const confirmSlot = el('div', {});

  // -- kill switch --
  // scanning_enabled === undefined means the backend did not return the key:
  // render an explicit unknown state with the control disabled — never
  // default the switch to OFF (or ON).
  const toggle = el('input', { type: 'checkbox' });
  const syncToggle = () => {
    const v = state.config.scanning_enabled;
    toggle.checked = v === true;
    toggle.disabled = typeof v !== 'boolean';
  };
  syncToggle();
  toggle.addEventListener('change', () => {
    syncToggle(); // revert; only the confirm applies the change
    if (typeof state.config.scanning_enabled === 'boolean') showToggleConfirm();
  });

  function showToggleConfirm() {
    confirmSlot.textContent = '';
    const disabling = state.config.scanning_enabled;
    confirmSlot.append(el('div', { class: 'confirm-box' + (disabling ? ' danger' : '') },
      el('p', {
        text: disabling
          ? 'Disable scanning? Scanning will fail for ALL users until re-enabled.'
          : 'Re-enable scanning for all users?',
      }),
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn ' + (disabling ? 'btn-danger' : 'btn-primary'),
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await adminApi('set_config', { key: 'scanning_enabled', value: !disabling });
              const resp = await adminApi('get_config');
              state.config = normalizeConfig(resp);
              confirmSlot.textContent = '';
              syncToggle();
              syncHint();
              setMsg(setMsgEl, 'ok', state.config.scanning_enabled === true ? 'Scanning enabled.' : 'Scanning disabled.');
            } catch (err) {
              e.target.disabled = false;
              if (!err.handled) setMsg(setMsgEl, 'err', err.message);
            }
          },
        }, disabling ? 'Disable scanning' : 'Enable scanning'),
        el('button', { class: 'btn', onclick: () => { confirmSlot.textContent = ''; } }, 'Cancel'))));
  }

  const enabledHint = el('p', { class: 'hint' });
  const syncHint = () => {
    const v = state.config.scanning_enabled;
    if (typeof v !== 'boolean') {
      enabledHint.className = 'msg msg-err';
      enabledHint.textContent = 'Unknown — the backend did not return scanning_enabled. Control disabled.';
    } else if (v) {
      enabledHint.className = 'hint';
      enabledHint.textContent = 'Scanning is currently enabled.';
    } else {
      enabledHint.className = 'msg msg-err';
      enabledHint.textContent = 'Scanning is currently DISABLED — every scan fails until re-enabled.';
    }
  };
  syncHint();

  wrap.append(el('div', { class: 'setting-row' },
    el('label', { class: 'switch' }, toggle, el('span', { class: 'slider' })),
    el('div', {},
      el('strong', { text: 'Scanning enabled' }),
      enabledHint,
      confirmSlot)));

  // -- default daily scan cap --
  // Same unknown rule: no value from the backend → explicit unknown,
  // control disabled — never an empty-but-editable field masquerading
  // as the real state.
  const capKnown = typeof cfg.default_daily_scan_cap === 'number';
  const capInput = el('input', {
    type: 'number', min: '0', step: '1', class: 'input-small',
    value: capKnown ? String(cfg.default_daily_scan_cap) : '',
    placeholder: capKnown ? null : 'unknown',
    disabled: !capKnown,
  });
  const capMsg = el('span', { class: 'msg' });
  const capSave = el('button', { class: 'btn btn-primary btn-small', disabled: !capKnown }, 'Save');
  const capHint = el('p', {
    class: capKnown ? 'hint' : 'msg msg-err',
    text: capKnown
      ? 'Applies to every user without a per-user override.'
      : 'Unknown — the backend did not return default_daily_scan_cap. Control disabled.',
  });
  capSave.addEventListener('click', async () => {
    const raw = capInput.value.trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 0) {
      setMsg(capMsg, 'err', 'Enter a non-negative whole number.');
      return;
    }
    capSave.disabled = true;
    setMsg(capMsg, 'info', 'Saving…');
    try {
      await adminApi('set_config', { key: 'default_daily_scan_cap', value: n });
      const resp = await adminApi('get_config');
      state.config = normalizeConfig(resp);
      capInput.value = typeof state.config.default_daily_scan_cap === 'number'
        ? String(state.config.default_daily_scan_cap) : '';
      setMsg(capMsg, 'ok', 'Saved.');
    } catch (e) {
      if (!e.handled) setMsg(capMsg, 'err', e.message);
    }
    capSave.disabled = false;
  });

  wrap.append(el('div', { class: 'setting-row' },
    el('div', {},
      el('strong', { text: 'Default daily scan cap' }),
      capHint,
      el('div', { class: 'cap-row' }, capInput, capSave, capMsg))));

  wrap.append(setMsgEl);
  return wrap;
}

// ---------------------------------------------------------------------------
// Log tab — admin actions
// ---------------------------------------------------------------------------
function paramsCompact(p) {
  if (!p || typeof p !== 'object') return '—';
  const entries = Object.entries(p);
  if (!entries.length) return '—';
  return entries.map(([k, v]) =>
    k + '=' + (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v))).join('  ');
}

function viewLog() {
  const wrap = el('div', {},
    el('div', { class: 'section-head' },
      el('h2', { text: 'Admin actions log' }),
      el('button', { class: 'btn btn-small', onclick: () => loadLog() }, 'Refresh')),
    el('p', { class: 'hint', text: 'Every mutating admin-api action, newest first. Params carry field names and counts — values live in the audit history.' }));
  if (state.logError) wrap.append(el('p', { class: 'msg msg-err', text: state.logError }));
  if (state.log === null) {
    wrap.append(el('p', { class: 'msg-info', text: 'Loading log…' }));
    return wrap;
  }
  const rows = state.log.rows;
  if (!rows.length) {
    wrap.append(el('p', { class: 'msg-info', text: 'No admin actions recorded yet.' }));
    return wrap;
  }
  const tbl = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: 'Time' }),
      el('th', { text: 'Admin' }),
      el('th', { text: 'Action' }),
      el('th', { text: 'Target' }),
      el('th', { text: 'Params' }))),
    el('tbody', {}, rows.map((r) => {
      const target = r.target_email
        || (r.target_user_id ? truncate(r.target_user_id, 13) : null)
        || r.target_id || '—';
      const compact = paramsCompact(r.params);
      return el('tr', {},
        el('td', { title: utcStr(r.created_at), text: fmtDateTime(r.created_at) }),
        el('td', { text: r.admin_email || truncate(r.admin_user_id || '—', 13) }),
        el('td', {}, el('span', { class: 'badge badge-table', text: r.action })),
        el('td', { text: target, title: r.target_user_id || null }),
        el('td', { class: 'params-cell', text: truncate(compact, 160), title: compact === '—' ? null : compact }));
    })));
  wrap.append(el('div', { class: 'table-wrap' }, tbl));
  if (state.log.nextBefore) {
    wrap.append(el('div', { class: 'load-more' },
      el('button', { class: 'btn btn-small', onclick: () => loadLog(true) }, 'Load older')));
  }
  return wrap;
}

// ---------------------------------------------------------------------------
init();
})();
