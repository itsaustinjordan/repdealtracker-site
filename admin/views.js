/* Deal Tracker Admin v3 — views: every tab, the user detail, the deal
   drawer, tools, and settings. Loaded after core.js; talks to the backend
   only through DT.adminApi and renders through DT's primitives. */
(() => {
'use strict';
const {
  db, state, adminApi,
  el, setMsg, tip, toast,
  intFmt, money, fmtCost, pctFmt, fmtBytes, fmtISODate, fmtDateTime, utcStr,
  relTime, relTimeEl, fmtDur, humanize, truncate, fmtVal, valueEq, num,
  normalizeConfig, configToMap,
  confirmModal, openLightbox,
  buildTable, skeletonRows, emptyState,
  lineChart, sparkline, zeroFillDays,
  downloadBlob, toCSV,
  nav, render, probe,
  ensureUsers, ensureDealsIndex,
} = window.DT;
const C = state.cache;

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

// The extraction-prompt field roster (replay diff order — §4.1).
const EXTRACTED_FIELDS = ['deal_date', 'site_origin', 'account_number', 'owner_names',
  'phone_numbers', 'resort', 'unit_size', 'market_source', 'purchase_price', 'down_payment',
  'closing_cost', 'interval_dues', 'amount_received_today', 'amount_received_breakdown',
  'additional_payments_due', 'annual_rate', 'months_financed', 'monthly_payment',
  'representative_number', 'upg_amount', 'manager_number', 'closing_officer_number'];

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

// Status badge per the app's §3.5 language: TEXT = type, COLOR = money state.
function dealStatusBadge(deal) {
  if (deal.cancelled) {
    return deal.cancel_reason === 'unpaid_pender'
      ? el('span', { class: 'badge badge-danger', text: 'Unpaid' })
      : el('span', { class: 'badge badge-neutral', text: 'Cancelled' });
  }
  const earned = deal.commission_status === 'earned';
  const cls = earned ? 'badge-success' : 'badge-warning';
  return el('span', { class: 'badge ' + cls, text: deal.pender_status ? 'Pender' : 'Full Down' });
}

function sourceBadge(src) {
  if (src === 'imported') return el('span', { class: 'badge badge-accent', text: 'imported' });
  if (src === 'manual') return el('span', { class: 'badge badge-outline', text: 'manual' });
  if (src === 'computed' || src == null) return el('span', { class: 'badge badge-neutral', text: 'computed' });
  // unknown ≠ default: an unexpected value renders as itself, never mapped.
  return el('span', { class: 'badge badge-neutral', text: String(src) });
}

function planBadge(plan) {
  if (plan === 'comped') return el('span', { class: 'badge badge-success', text: 'COMPED' });
  if (plan === 'standard' || plan == null) return null; // the default plan carries no badge
  return el('span', { class: 'badge badge-neutral', text: String(plan) }); // unknown renders as itself
}

function statusPill(s) {
  const cls = s === 'success' ? 'badge-success'
    : (s === 'parse_fail' || s === 'api_fail') ? 'badge-danger'
      : (typeof s === 'string' && s.indexOf('blocked') === 0) ? 'badge-warning' : 'badge-neutral';
  return el('span', { class: 'badge ' + cls, text: s || '—' });
}

function severityBadge(sev) {
  const cls = sev === 'error' ? 'badge-danger' : sev === 'warn' ? 'badge-warning' : 'badge-neutral';
  return el('span', { class: 'badge ' + cls, text: sev });
}

function changedFieldNames(a) {
  if (a.action !== 'UPDATE') return [];
  const oldR = a.old_row || {};
  const newR = a.new_row || {};
  const keys = new Set(Object.keys(oldR).concat(Object.keys(newR)));
  return [...keys].filter((k) => !valueEq(oldR[k], newR[k])).sort();
}

function lastActive(u) {
  const a = Date.parse(u.last_sign_in_at || '') || 0;
  const b = Date.parse(u.last_deal_at || '') || 0;
  const m = Math.max(a, b);
  return m ? new Date(m).toISOString() : null;
}

function purpose(text) { return el('p', { class: 'section-purpose', text }); }

// ---------------------------------------------------------------------------
// Loaders (cache-backed; force = refetch)
// ---------------------------------------------------------------------------
async function loadDashboard(force) {
  if (C.dashboard && !force) return;
  C.dashboardErr = '';
  if (force) C.dashboard = null;
  rerender('overview');
  try {
    C.dashboard = await adminApi('dashboard_stats');
  } catch (e) {
    if (e.handled) return;
    C.dashboardErr = e.message;
    C.dashboard = C.dashboard || null;
  }
  rerender('overview');
}

async function loadUsers(force) {
  if (C.users && !force) return;
  C.usersErr = '';
  if (force) C.users = null;
  rerender('users');
  try {
    const resp = await adminApi('list_users');
    C.users = (resp && resp.users) || [];
  } catch (e) {
    if (e.handled) return;
    C.users = C.users || [];
    C.usersErr = e.message;
  }
  rerender('users');
}

async function loadStats(force) {
  if (C.stats && !force) return;
  C.statsErr = '';
  if (force) C.stats = null;
  rerender('stats');
  try {
    const resp = await adminApi('scan_stats', { days: 30 });
    const rows = (resp && Array.isArray(resp.days)) ? resp.days : [];
    C.stats = rows;
  } catch (e) {
    if (e.handled) return;
    C.stats = C.stats || [];
    C.statsErr = e.message;
  }
  rerender('stats');
}

async function loadHealth(force) {
  if (C.health && !force) return;
  C.healthErr = '';
  if (force) C.health = null;
  rerender('stats');
  try {
    const resp = await adminApi('health_stats', { days: 30 });
    C.health = {
      daily: (resp && Array.isArray(resp.daily)) ? resp.daily : [],
      by_version: (resp && Array.isArray(resp.by_version)) ? resp.by_version : [],
      recent_failures: (resp && Array.isArray(resp.recent_failures)) ? resp.recent_failures : [],
    };
  } catch (e) {
    if (e.handled) return;
    C.health = C.health || { daily: [], by_version: [], recent_failures: [] };
    C.healthErr = e.message;
  }
  rerender('stats');
}

async function loadLog(more) {
  C.logErr = '';
  const prev = more && C.log ? C.log : null;
  if (!more) { C.log = null; rerender('log'); }
  const params = { limit: 100 };
  if (prev && prev.nextBefore) params.before = prev.nextBefore;
  try {
    const resp = await adminApi('list_admin_actions', params);
    const rows = (resp && resp.actions) || [];
    C.log = {
      rows: prev ? prev.rows.concat(rows) : rows,
      nextBefore: (resp && resp.next_before) || null,
    };
  } catch (e) {
    if (e.handled) return;
    if (!C.log) C.log = { rows: [], nextBefore: null };
    C.logErr = e.message;
  }
  rerender('log');
}

async function loadConfig(force) {
  if (C.config && !force) return;
  C.configErr = '';
  try {
    const resp = await adminApi('get_config');
    C.config = normalizeConfig(resp);
  } catch (e) {
    if (e.handled) return;
    C.configErr = e.message;
  }
  rerender('settings');
}

async function loadClientConfig(force) {
  if (C.clientConfig && !force) return;
  C.clientConfigErr = '';
  try {
    const resp = await adminApi('get_client_config');
    C.clientConfig = configToMap(resp); // key → value (raw jsonb objects)
  } catch (e) {
    if (e.handled) return;
    C.clientConfigErr = e.message;
  }
  rerender('settings');
}

async function loadTables(force) {
  if (C.tables && !force) return;
  C.tablesErr = '';
  if (force) C.tables = null;
  rerender('tools');
  try {
    const resp = await adminApi('admin_stats_tables');
    C.tables = (resp && resp.tables) || [];
  } catch (e) {
    if (e.handled) return;
    C.tables = C.tables || [];
    C.tablesErr = e.message;
  }
  rerender('tools');
}

async function loadAdmins(force) {
  if (C.admins && !force) return;
  C.adminsErr = '';
  if (force) C.admins = null;
  rerender('settings');
  try {
    const resp = await adminApi('list_admins');
    C.admins = (resp && resp.admins) || [];
  } catch (e) {
    if (e.handled) return;
    C.admins = C.admins || [];
    C.adminsErr = e.message;
  }
  rerender('settings');
}

async function runIntegrityGlobal() {
  C.integrityRunning = true;
  C.integrityErr = '';
  rerender('tools');
  try {
    await ensureUsers();
    C.integrity = await adminApi('integrity_check', {});
  } catch (e) {
    if (!e.handled) C.integrityErr = e.message;
  }
  C.integrityRunning = false;
  rerender('tools');
}

async function runStorageReport() {
  C.storageRunning = true;
  C.storageErr = '';
  rerender('tools');
  try {
    C.storage = await adminApi('storage_report');
    C.storage._selected = new Set();
  } catch (e) {
    if (!e.handled) C.storageErr = e.message;
  }
  C.storageRunning = false;
  rerender('tools');
}

// Re-render only when the given route is still on screen.
function rerender(name) {
  if (state.view !== 'panel') return;
  const r = state.route;
  const active = r.name === 'deal' ? (state.baseRoute ? state.baseRoute.name : 'users') : r.name;
  const match = name === active || (name === 'users' && active === 'user');
  if (match || r.name === 'deal') render();
}

// ---------------------------------------------------------------------------
// Routing hooks
// ---------------------------------------------------------------------------
function routeToPath(route) {
  if (!route) return 'overview';
  return [route.name].concat(route.args).map(encodeURIComponent).join('/');
}

window.DT.onRoute = (route) => {
  if (route.name === 'overview') loadDashboard(false);
  if (route.name === 'users') loadUsers(false);
  if (route.name === 'stats') { loadStats(false); loadHealth(false); }
  if (route.name === 'log' && C.log === null) loadLog(false);
  if (route.name === 'settings') { loadConfig(true); loadClientConfig(true); loadAdmins(false); }
  if (route.name === 'tools') {
    state.toolsTab = ['integrity', 'storage', 'data'].includes(route.args[0]) ? route.args[0] : state.toolsTab;
    if (state.toolsTab === 'data') loadTables(false);
  }
  if (route.name === 'user') {
    const userId = route.args[0];
    const tab = ['overview', 'deals', 'activity', 'deleted'].includes(route.args[1]) ? route.args[1] : 'overview';
    if (!state.detail || state.detail.userId !== userId) {
      state.detail = {
        userId, tab, data: null, error: '', deleted: null, integrity: null, integrityRunning: false,
        deals: { query: '', cancelled: 'any', pender: 'any', offset: 0, rows: null, total: 0, error: '' },
        activity: { rows: null, nextBefore: null, error: '', loadingMore: false },
        deletedDeals: { rows: null, error: '' },
      };
      loadUsers(false);
      loadDetail(userId);
    } else {
      state.detail.tab = tab;
    }
    if (tab === 'deals' && state.detail.deals.rows === null) loadDeals(false);
    if (tab === 'activity' && state.detail.activity.rows === null) loadActivity(false);
    if (tab === 'deleted' && state.detail.deletedDeals.rows === null) loadDeletedDeals();
    render();
  }
  if (route.name === 'deal') {
    const dealId = route.args[0];
    // Deep link straight to a deal: the base view behind the drawer defaults
    // to Users — make sure its data loads too.
    if (!state.baseRoute) loadUsers(false);
    if (!state.drawer || state.drawer.dealId !== dealId) {
      state.drawer = { dealId, data: null, error: '', edit: null, replay: null, replayRunning: false };
      loadDrawer(dealId);
    }
    render();
  } else if (state.drawer) {
    state.drawer = null;
    render();
  }
};

function closeDrawer() {
  nav(routeToPath(state.baseRoute || { name: 'users', args: [] }));
}

// ---------------------------------------------------------------------------
// Detail + drawer loaders (v2 logic, response shapes unchanged)
// ---------------------------------------------------------------------------
function normalizeDetail(resp) {
  const d = resp || {};
  return {
    aggregates: d.aggregates || d.user || d.stats || {},
    events: d.scan_events || d.recent_scan_events || d.events || [],
    settings: d.user_settings || d.settings || null,
    cap: d.cap || d.scan_limit || d.scan_cap || d.cap_row || null,
    entitlement: d.entitlement || null,
  };
}

async function loadDetail(userId) {
  try {
    const resp = await adminApi('user_detail', { user_id: userId });
    if (!state.detail || state.detail.userId !== userId) return;
    state.detail.data = normalizeDetail(resp);
  } catch (e) {
    if (e.handled) return;
    if (!state.detail || state.detail.userId !== userId) return;
    state.detail.error = e.message;
    state.detail.data = { aggregates: {}, events: [], settings: null, cap: null, entitlement: null };
  }
  if (state.route.name === 'user') render();
}

async function loadDeals(silent) {
  const d = state.detail;
  if (!d) return;
  const s = d.deals;
  s.error = '';
  if (!silent) { s.rows = null; if (d.tab === 'deals') render(); }
  const params = { user_id: d.userId, limit: 50, offset: s.offset };
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
  if (state.route.name === 'user' && d.tab === 'deals') render();
}

async function loadActivity(more) {
  const d = state.detail;
  if (!d) return;
  const s = d.activity;
  s.error = '';
  if (!more) { s.rows = null; s.nextBefore = null; }
  else s.loadingMore = true;
  if (d.tab === 'activity') render();
  const params = { user_id: d.userId, limit: 100 };
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
  if (state.route.name === 'user' && d.tab === 'activity') render();
}

async function loadDeletedDeals() {
  const d = state.detail;
  if (!d) return;
  const s = d.deletedDeals;
  s.error = '';
  s.rows = null;
  if (d.tab === 'deleted') render();
  try {
    const resp = await adminApi('list_deleted_deals', { user_id: d.userId, limit: 50 });
    if (state.detail !== d) return;
    s.rows = (resp && resp.deleted) || [];
  } catch (e) {
    if (e.handled) return;
    if (state.detail !== d) return;
    s.rows = [];
    s.error = e.message;
  }
  if (state.route.name === 'user' && d.tab === 'deleted') render();
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
      image_url: (resp && typeof resp.image_url === 'string') ? resp.image_url : null,
    };
  } catch (e) {
    if (e.handled) return;
    if (state.drawer !== dr) return;
    dr.error = e.message;
  }
  render();
}

async function refreshDrawerQuiet(dr) {
  try {
    const resp = await adminApi('get_deal', { deal_id: dr.dealId });
    if (state.drawer !== dr) return;
    dr.data = {
      deal: (resp && resp.deal) || dr.data.deal,
      audit: (resp && resp.audit) || dr.data.audit,
      scan_event: resp ? (resp.scan_event || null) : dr.data.scan_event,
      image_url: resp && typeof resp.image_url === 'string' ? resp.image_url : dr.data.image_url,
    };
    render();
  } catch (e) { /* quiet refresh — keep what we have */ }
}

// ---------------------------------------------------------------------------
// Sign-in / denied
// ---------------------------------------------------------------------------
window.DT.viewSignin = () => {
  const msg = el('p', { class: 'msg msg-err', text: state.signinMsg });
  const email = el('input', { type: 'email', autocomplete: 'username', required: true, placeholder: 'you@example.com' });
  const pass = el('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Password' });
  const btn = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Sign in' });
  return el('div', { class: 'signin-wrap' },
    el('form', {
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
      el('p', { class: 'muted small', text: 'Sign in with your Deal Tracker account. Only allowlisted admin accounts can enter.' }),
      el('label', { class: 'field' }, 'Email', email),
      el('label', { class: 'field' }, 'Password', pass),
      btn,
      msg));
};

window.DT.viewDenied = () => {
  return el('div', { class: 'signin-wrap' },
    el('div', { class: 'card signin-card' },
      el('h1', { text: 'Not authorized' }),
      el('p', { text: 'This account is not authorized to use the admin panel.' }),
      el('button', {
        class: 'btn',
        onclick: async () => {
          await db.auth.signOut().catch(() => {});
          window.DT.resetToSignin('');
        },
      }, 'Sign out')));
};

// ---------------------------------------------------------------------------
// Panel dispatch
// ---------------------------------------------------------------------------
window.DT.viewPanel = () => {
  const r = state.route;
  const base = r.name === 'deal' ? (state.baseRoute || { name: 'users', args: [] }) : r;
  const wrap = el('div', {});
  if (base.name === 'users') wrap.append(viewUsers());
  else if (base.name === 'user') wrap.append(viewUserDetail());
  else if (base.name === 'stats') wrap.append(viewStats());
  else if (base.name === 'tools') wrap.append(viewTools());
  else if (base.name === 'log') wrap.append(viewLog());
  else if (base.name === 'settings') wrap.append(viewSettings());
  else wrap.append(viewOverview());
  if (r.name === 'deal' && state.drawer) wrap.append(viewDrawer());
  return wrap;
};

// ---------------------------------------------------------------------------
// OVERVIEW
// ---------------------------------------------------------------------------
function viewOverview() {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'page-head' },
    el('h1', { text: 'Overview' }),
    el('button', { class: 'btn btn-small', onclick: () => loadDashboard(true) }, '↻ Refresh')));
  wrap.append(purpose('The health of the app right now — today’s scanning, cost against the monthly budget, and anything that needs attention.'));

  if (C.dashboardErr) wrap.append(el('p', { class: 'msg msg-err', text: C.dashboardErr }));
  const d = C.dashboard;
  if (!d) {
    const grid = el('div', { class: 'stat-grid' });
    for (let i = 0; i < 5; i++) grid.append(el('div', { class: 'skeleton skel-stat' }));
    wrap.append(grid, el('div', { class: 'skeleton skel-block' }));
    return wrap;
  }

  // --- status callouts (only when something is abnormal) ---
  if (d.scanning_enabled === false) {
    wrap.append(el('div', { class: 'callout callout-danger' },
      el('div', { class: 'callout-body' },
        el('strong', { text: 'Scanning is OFF for every user' }),
        'The kill switch is flipped — every scan attempt fails until it’s re-enabled.'),
      el('button', { class: 'btn btn-danger', onclick: () => nav('settings') }, 'Open Settings')));
  } else if (d.scanning_enabled === null) {
    // unknown ≠ default — say so explicitly, never assume ON or OFF.
    wrap.append(el('div', { class: 'callout callout-warning' },
      el('div', { class: 'callout-body' },
        el('strong', { text: 'Kill-switch state unknown' }),
        'The backend did not return scanning_enabled. Scanning may or may not be running — check Settings.'),
      el('button', { class: 'btn', onclick: () => nav('settings') }, 'Open Settings')));
  }
  if (d.budget_tripped) {
    wrap.append(el('div', { class: 'callout callout-danger' },
      el('div', { class: 'callout-body' },
        el('strong', { text: 'Monthly budget reached — scanning is blocked' }),
        'Estimated Claude spend this month (' + money(d.mtd_cost_usd) + ') has hit the ' + money(d.monthly_budget_usd) +
        ' ceiling. Scans fail until the month rolls over or the budget is raised.'),
      el('button', { class: 'btn btn-danger', onclick: () => nav('settings') }, 'Raise budget')));
  } else if (d.monthly_budget_usd != null && d.monthly_budget_usd > 0 && d.mtd_cost_usd / d.monthly_budget_usd >= 0.8) {
    wrap.append(el('div', { class: 'callout callout-warning' },
      el('div', { class: 'callout-body' },
        el('strong', { text: 'Approaching the monthly budget' }),
        money(d.mtd_cost_usd) + ' of ' + money(d.monthly_budget_usd) + ' estimated spend used. At the ceiling, scanning stops for everyone.'),
      el('button', { class: 'btn', onclick: () => nav('settings') }, 'Review')));
  }

  // --- stat cards ---
  const spark30 = zeroFillDays(d.sparkline_30d || [], 30, 'date', (key) => ({ date: key, total: 0 }));
  const today = d.today || {};
  const grid = el('div', { class: 'stat-grid' });

  const stat = (label, tipText, value, delta, sparkEl) => {
    const card = el('div', { class: 'stat-card' },
      el('div', { class: 'stat-label' }, label, tip(tipText)),
      el('div', { class: 'stat-value', text: value }));
    if (delta) card.append(el('div', { class: 'stat-delta', text: delta }));
    if (sparkEl) card.append(sparkEl);
    return card;
  };

  grid.append(stat('Scans today', 'Extraction requests since midnight UTC — successes, failures, and blocked attempts all count.',
    intFmt(today.scans),
    intFmt(today.success) + ' ok · ' + intFmt(today.failures) + ' failed · ' + intFmt(today.blocked) + ' blocked',
    sparkline(spark30.map((r) => num(r.total)), 'var(--accent)')));

  grid.append(stat('Fail rate 7d', 'Of scans that actually ran in the last 7 days (blocked ones don’t count), the share that failed with a parse or API error.',
    d.fail_rate_7d == null ? '—' : pctFmt(d.fail_rate_7d),
    d.fail_rate_7d == null ? 'no scans ran this week' : null));

  grid.append(stat('Active today', 'Users who opened the app today (UTC) — counted by the app’s daily heartbeat, so dashboard-only opens count too.',
    intFmt(d.active_today),
    intFmt(d.active_7d) + ' active in the last 7 days'));

  grid.append(stat('Signups 7d', 'New accounts created in the last 7 days.',
    intFmt(d.signups_7d)));

  const budgetCard = el('div', { class: 'stat-card' },
    el('div', { class: 'stat-label' }, 'Cost this month', tip('Estimated Claude API spend for the current calendar month (UTC), from per-scan token counts at current pricing. The same number the automatic budget stop uses.')),
    el('div', { class: 'stat-value', text: money(d.mtd_cost_usd) }));
  if (d.monthly_budget_usd != null) {
    const frac = d.monthly_budget_usd > 0 ? Math.min(1, d.mtd_cost_usd / d.monthly_budget_usd) : 1;
    budgetCard.append(
      el('div', { class: 'stat-delta', text: 'of ' + money(d.monthly_budget_usd) + ' budget' }),
      el('div', { class: 'progress' + (frac >= 1 ? ' danger' : frac >= 0.8 ? ' warn' : ''), style: 'margin-top:6px' },
        el('span', { style: 'width:' + (frac * 100).toFixed(1) + '%' })));
  } else {
    budgetCard.append(el('div', { class: 'stat-delta', text: 'budget unknown — check Settings' }));
  }
  grid.append(budgetCard);
  wrap.append(grid);

  // --- 30d chart ---
  wrap.append(el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Scans — last 30 days' }),
      tip('Total extraction requests per UTC day, every outcome included. The Stats tab breaks this down by result.')),
    lineChart([{ label: 'Scans', color: 'var(--accent)', area: true, points: spark30.map((r) => ({ x: r.date, y: num(r.total) })) }],
      { height: 190, noLegend: true })));

  // --- recent failures + recent actions ---
  const cols2 = el('div', { class: 'stack', style: 'margin-top:16px' });
  const failCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Recent failures' }),
      tip('The last 5 scans that didn’t succeed, all time. Click one to open that user.')));
  const fails = d.recent_failures || [];
  if (!fails.length) {
    failCard.append(emptyState('No failures recorded', 'When a scan fails to parse or the API errors, it shows up here.'));
  } else {
    failCard.append(buildTable(
      [{ label: 'When' }, { label: 'User' }, { label: 'Status' }, { label: 'Error' }],
      fails.map((r) => ({
        rowClass: 'clickable',
        onclick: () => {
          const u = (C.users || []).find((x) => x.email === r.email);
          if (u) nav('user/' + u.user_id + '/overview'); else nav('users');
        },
        cells: [relTimeEl(r.created_at), r.email || '—', statusPill(r.status), r.error_code || '—'],
      }))));
  }
  cols2.append(failCard);

  const actCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Recent admin actions' }),
      tip('The last 5 changes made through this panel. The Log tab has the full history.')));
  const acts = d.recent_actions || [];
  if (!acts.length) {
    actCard.append(emptyState('Nothing yet', 'Every change made through this panel is recorded and will appear here.'));
  } else {
    actCard.append(buildTable(
      [{ label: 'When' }, { label: 'Admin' }, { label: 'Action' }, { label: 'Target' }],
      acts.map((r) => ({
        rowClass: r.target_user_id ? 'clickable' : null,
        onclick: r.target_user_id ? () => nav('user/' + r.target_user_id + '/overview') : null,
        cells: [relTimeEl(r.created_at), r.admin_email || truncate(r.admin_user_id || '—', 13),
          el('span', { class: 'badge badge-neutral', text: r.action }),
          r.target_email || r.target_id || '—'],
      }))));
    actCard.append(el('p', { class: 'small', style: 'margin-top:8px' }, el('button', { class: 'btn-link', onclick: () => nav('log') }, 'Open the full log →')));
  }
  cols2.append(actCard);
  wrap.append(cols2);
  return wrap;
}

// ---------------------------------------------------------------------------
// USERS (roster)
// ---------------------------------------------------------------------------
const USER_SORTS = {
  email: { get: (u) => (u.email || '').toLowerCase(), dir: 'asc', str: true },
  created_at: { get: (u) => u.created_at || '', dir: 'desc', str: true },
  last_active: { get: (u) => lastActive(u) || '', dir: 'desc', str: true },
  deal_count: { get: (u) => num(u.deal_count), dir: 'desc' },
  volume_sum: { get: (u) => num(u.volume_sum), dir: 'desc' },
  scans_30d: { get: (u) => num(u.scans_30d), dir: 'desc' },
};

function userBadges(u) {
  const out = [];
  if (u.is_admin) out.push(el('span', { class: 'badge badge-accent', text: 'ADMIN' }));
  if (u.banned) out.push(el('span', { class: 'badge badge-danger', text: 'BANNED' }));
  const pb = planBadge(u.plan);
  if (pb) out.push(pb);
  if (typeof u.note === 'string' && u.note.trim()) {
    out.push(el('span', { class: 'badge badge-outline', text: '✎ note', title: truncate(u.note, 300) }));
  }
  return out;
}

function capOf(u) {
  const defCap = C.config ? C.config.default_daily_scan_cap : null;
  const cap = u.daily_cap != null ? u.daily_cap : defCap;
  return cap != null ? String(cap) : '—';
}

function viewUsers() {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'page-head' },
    el('h1', { text: 'Users' }),
    el('button', { class: 'btn btn-small', onclick: () => loadUsers(true) }, '↻ Refresh')));
  wrap.append(purpose('Every account in the app. Click a user to inspect their deals, adjust limits or plan, or handle support.'));
  if (C.usersErr) wrap.append(el('p', { class: 'msg msg-err', text: C.usersErr }));
  if (C.users === null) { wrap.append(skeletonRows(8, 26)); return wrap; }
  if (!C.users.length) {
    if (!C.usersErr) wrap.append(emptyState('No users yet', 'Accounts appear here the moment someone signs up in the app.'));
    return wrap;
  }

  const search = el('input', { type: 'text', class: 'input-search', placeholder: 'Filter by email…', style: 'min-width:220px' });
  search.value = C.usersQuery;
  const countEl = el('p', { class: 'muted small', style: 'margin:8px 0' });
  const tableSlot = el('div', {});

  const sortableTh = (key, label, cls) => {
    const active = C.usersSort.key === key;
    const arrow = active ? (C.usersSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return {
      label,
      cls: (cls || '') + ' sortable',
      node: el('span', {
        onclick: () => {
          if (C.usersSort.key === key) C.usersSort.dir = C.usersSort.dir === 'asc' ? 'desc' : 'asc';
          else C.usersSort = { key, dir: USER_SORTS[key].dir };
          renderTable();
        },
        text: label + arrow,
        style: 'cursor:pointer',
      }),
    };
  };

  const renderTable = () => {
    const q = C.usersQuery.trim().toLowerCase();
    let list = (C.users || []).slice();
    if (q) list = list.filter((u) => (u.email || '').toLowerCase().includes(q));
    const s = USER_SORTS[C.usersSort.key] || USER_SORTS.created_at;
    const mul = C.usersSort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const av = s.get(a); const bv = s.get(b);
      const c = s.str ? String(av).localeCompare(String(bv)) : (av - bv);
      return c * mul;
    });
    countEl.textContent = list.length === C.users.length
      ? C.users.length + ' users'
      : list.length + ' of ' + C.users.length + ' users';
    tableSlot.textContent = '';
    if (!list.length) {
      tableSlot.append(emptyState('No matching users', 'Nobody’s email contains “' + C.usersQuery.trim() + '”.'));
      return;
    }
    tableSlot.append(buildTable(
      [
        sortableTh('email', 'Email'),
        sortableTh('created_at', 'Joined'),
        sortableTh('last_active', 'Last active'),
        sortableTh('deal_count', 'Deals', 'num'),
        sortableTh('volume_sum', 'Volume', 'num'),
        sortableTh('scans_30d', 'Scans 30d', 'num'),
        { label: 'Scans 24h', cls: 'num', tip: 'Scans in the last 24 hours against this user’s daily cap. Blocked attempts don’t count.' },
      ],
      list.map((u) => ({
        rowClass: 'clickable',
        onclick: () => nav('user/' + u.user_id + '/overview'),
        cells: [
          el('span', {}, u.email || '—', userBadges(u)),
          relTimeEl(u.created_at),
          relTimeEl(lastActive(u)),
          intFmt(u.deal_count),
          money(u.volume_sum),
          intFmt(u.scans_30d),
          intFmt(u.scans_24h == null ? 0 : u.scans_24h) + ' / ' + capOf(u),
        ],
      }))));
  };

  search.addEventListener('input', () => { C.usersQuery = search.value; renderTable(); });
  wrap.append(el('div', { class: 'row', style: 'margin-bottom:4px' }, search), countEl, tableSlot);
  renderTable();
  return wrap;
}

// ---------------------------------------------------------------------------
// USER DETAIL (Overview / Deals / Activity / Deleted)
// ---------------------------------------------------------------------------
function detailRow() {
  const d = state.detail;
  const cached = (C.users || []).find((u) => u.user_id === d.userId);
  const fromDetail = d.data && d.data.aggregates && d.data.aggregates.user_id ? d.data.aggregates : null;
  return Object.assign({}, cached || {}, fromDetail || {});
}

function viewUserDetail() {
  const d = state.detail;
  if (!d) return el('div', {});
  const row = detailRow();
  const wrap = el('div', {});

  wrap.append(el('button', { class: 'btn-link', onclick: () => nav('users') }, '← All users'));

  if (d.deleted) {
    const counts = (d.deleted && typeof d.deleted === 'object') ? d.deleted : {};
    return el('div', {},
      el('button', { class: 'btn-link', onclick: () => nav('users') }, '← All users'),
      el('div', { class: 'card', style: 'margin-top:16px' },
        el('h2', { text: 'User deleted' }),
        el('p', { text: (row.email || 'The account') + ' has been permanently deleted.' }),
        el('ul', {}, Object.entries(counts).map(([k, v]) => el('li', { text: humanize(k) + ': ' + v }))),
        el('button', { class: 'btn', onclick: () => { state.detail = null; loadUsers(true); nav('users'); } }, 'Back to users')));
  }

  wrap.append(el('div', { class: 'page-head', style: 'margin-top:10px' },
    el('h1', { text: row.email || d.userId }),
    el('span', {}, userBadges(row))));
  if (d.error) wrap.append(el('p', { class: 'msg msg-err', text: 'Could not load details: ' + d.error }));

  const tabs = [['overview', 'Overview'], ['deals', 'Deals'], ['activity', 'Activity'], ['deleted', 'Deleted']];
  wrap.append(el('div', { class: 'subtabs' }, tabs.map(([id, label]) =>
    el('button', { class: 'subtab' + (d.tab === id ? ' active' : ''), onclick: () => nav('user/' + d.userId + '/' + id) }, label))));

  if (d.tab === 'deals') wrap.append(sectionDeals(d));
  else if (d.tab === 'activity') wrap.append(sectionActivity(d));
  else if (d.tab === 'deleted') wrap.append(sectionDeleted(d));
  else wrap.append(sectionOverview(d, row));
  return wrap;
}

function sectionOverview(d, row) {
  const isAdmin = !!row.is_admin;
  const adminTip = 'Admin accounts cannot be banned or deleted';
  const root = el('div', { class: 'stack' });

  // -- aggregates --
  const a = Object.assign({}, row, (d.data && d.data.aggregates) || {});
  const aggCard = el('div', { class: 'card' });
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
  aggCard.append(el('dl', { class: 'agg-grid' }, items.map(([k, v]) =>
    el('div', { class: 'agg-item' }, el('dt', { text: k }), el('dd', { text: v })))));
  root.append(aggCard);

  // -- plan (entitlement) --
  const planCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Plan' }),
      tip('What this user pays. “Comped” means free access forever — meant for testers and friends; it will bypass the future paywall.')));
  const ent = d.data && d.data.entitlement;
  const currentPlan = (ent && typeof ent.plan === 'string') ? ent.plan : (row.plan || 'standard');
  const planSel = el('select', {},
    el('option', { value: 'standard', text: 'standard — normal (future: paying) user' }),
    el('option', { value: 'comped', text: 'comped — free access, never billed' }));
  if (!['standard', 'comped'].includes(currentPlan)) {
    planSel.prepend(el('option', { value: currentPlan, text: currentPlan + ' (current)' })); // unknown ≠ default
  }
  planSel.value = currentPlan;
  const planNote = el('input', { type: 'text', placeholder: 'Why (optional — e.g. “beta tester”)', style: 'flex:1;min-width:160px' });
  if (ent && typeof ent.note === 'string') planNote.value = ent.note;
  const planMsg = el('p', { class: 'msg' });
  const planSave = el('button', { class: 'btn btn-primary btn-small' }, 'Save plan');
  planSave.addEventListener('click', async () => {
    planSave.disabled = true;
    setMsg(planMsg, 'info', 'Saving…');
    try {
      const params = { user_id: d.userId, plan: planSel.value };
      if (planNote.value.trim()) params.note = planNote.value.trim();
      await adminApi('set_entitlement', params);
      row.plan = planSel.value;
      if (C.users) {
        const u = C.users.find((x) => x.user_id === d.userId);
        if (u) u.plan = planSel.value;
      }
      setMsg(planMsg, 'ok', 'Plan saved.');
      toast('ok', 'Plan set to ' + planSel.value + '.');
    } catch (e) {
      if (!e.handled) setMsg(planMsg, 'err', e.message);
    }
    planSave.disabled = false;
  });
  planCard.append(el('div', { class: 'row' }, planSel, planNote, planSave), planMsg);
  root.append(planCard);

  // -- admin note --
  const noteCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Admin note' }),
      tip('A private operator note about this user. Only admins ever see it.')));
  const noteArea = el('textarea', { rows: '3', style: 'width:100%', placeholder: 'Private operator note for this user' });
  const noteFromDetail = d.data && d.data.aggregates && typeof d.data.aggregates.note === 'string'
    ? d.data.aggregates.note : null;
  noteArea.value = noteFromDetail != null ? noteFromDetail : (typeof row.note === 'string' ? row.note : '');
  const noteMsg = el('p', { class: 'msg' });
  const noteSave = el('button', { class: 'btn btn-primary btn-small' }, 'Save note');
  noteSave.addEventListener('click', async () => {
    noteSave.disabled = true;
    setMsg(noteMsg, 'info', 'Saving…');
    try {
      await adminApi('set_user_note', { user_id: d.userId, note: noteArea.value });
      row.note = noteArea.value;
      if (C.users) {
        const u = C.users.find((x) => x.user_id === d.userId);
        if (u) u.note = noteArea.value;
      }
      setMsg(noteMsg, 'ok', noteArea.value.trim() ? 'Note saved.' : 'Note cleared.');
    } catch (e) {
      if (!e.handled) setMsg(noteMsg, 'err', e.message);
    }
    noteSave.disabled = false;
  });
  noteCard.append(noteArea, el('div', { class: 'btn-row' }, noteSave), noteMsg);
  root.append(noteCard);

  // -- export + integrity --
  const exportCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Export & checks' }),
      tip('Download everything stored for this user, or run the data consistency checks on just their book.')));
  const expMsg = el('p', { class: 'msg' });
  const expJson = el('button', { class: 'btn btn-small' }, '⬇ Everything (JSON)');
  const expCsv = el('button', { class: 'btn btn-small' }, '⬇ Deals (CSV)');
  const runCheck = el('button', { class: 'btn btn-small' }, '✓ Run integrity check');
  const nameStub = (row.email || d.userId).replace(/[^a-z0-9.@-]+/gi, '_');
  const dateStub = new Date().toISOString().slice(0, 10);
  async function doExport(kind) {
    expJson.disabled = expCsv.disabled = true;
    setMsg(expMsg, 'info', 'Building export…');
    try {
      const resp = await adminApi('export_user', { user_id: d.userId });
      if (kind === 'json') {
        downloadBlob('dealtracker-' + nameStub + '-' + dateStub + '.json', 'application/json', JSON.stringify(resp, null, 2));
      } else {
        downloadBlob('deals-' + nameStub + '-' + dateStub + '.csv', 'text/csv', toCSV(resp.deals || []));
      }
      setMsg(expMsg, 'ok', 'Export downloaded (' + intFmt((resp.deals || []).length) + ' deals).');
    } catch (e) {
      if (!e.handled) setMsg(expMsg, 'err', e.message);
    }
    expJson.disabled = expCsv.disabled = false;
  }
  expJson.addEventListener('click', () => doExport('json'));
  expCsv.addEventListener('click', () => doExport('csv'));

  const integritySlot = el('div', {});
  runCheck.addEventListener('click', async () => {
    runCheck.disabled = true;
    integritySlot.textContent = '';
    integritySlot.append(skeletonRows(4, 20));
    try {
      const resp = await adminApi('integrity_check', { user_id: d.userId });
      integritySlot.textContent = '';
      integritySlot.append(renderIntegrityChecks(resp, false));
    } catch (e) {
      integritySlot.textContent = '';
      if (!e.handled) integritySlot.append(el('p', { class: 'msg msg-err', text: e.message }));
    }
    runCheck.disabled = false;
  });
  exportCard.append(el('div', { class: 'btn-row' }, expJson, expCsv, runCheck), expMsg, integritySlot);
  root.append(exportCard);

  // -- scan cap / pause --
  const capCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Daily scan cap' }),
      tip('How many scans this user may run per rolling 24 hours. Empty override = the app-wide default. Pause sets the cap to 0 — the user keeps their data but can’t scan.')));
  const defCap = C.config ? C.config.default_daily_scan_cap : undefined;
  const defLabel = 'default' + (defCap != null ? ' (' + defCap + ')' : ' (unknown)');
  const capRow = d.data && d.data.cap;
  let currentCap = capRow && capRow.daily_cap != null ? capRow.daily_cap
    : (row.daily_cap != null ? row.daily_cap : null);
  const currentLabel = el('span', { class: 'strong', text: currentCap != null ? String(currentCap) : defLabel });
  const capMsg = el('p', { class: 'msg' });
  const capInput = el('input', { type: 'number', min: '0', step: '1', class: 'input-small', value: currentCap != null ? String(currentCap) : '', placeholder: 'cap' });
  const capNote = el('input', { type: 'text', placeholder: 'Note (optional)', style: 'flex:1;min-width:140px' });
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
      const params = { user_id: d.userId, daily_cap: value };
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
  capCard.append(
    el('p', { class: 'small muted' }, 'Current: ', currentLabel),
    el('div', { class: 'row', style: 'margin-top:8px' }, capInput, capNote, capSave, capClear, pauseBtn),
    capMsg);
  root.append(capCard);

  // -- account actions --
  const actCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Account actions' }),
      tip('Ban blocks sign-in (existing sessions can survive up to ~1 hour). The email actions send the standard Supabase emails.')));
  const actMsg = el('p', { class: 'msg' });
  const banBtn = el('button', {
    class: 'btn' + (row.banned ? '' : ' btn-danger-outline'),
    disabled: isAdmin, title: isAdmin ? adminTip : null,
  }, row.banned ? 'Unban user' : 'Ban user');
  banBtn.addEventListener('click', () => {
    const banning = !row.banned;
    confirmModal({
      title: banning ? 'Ban ' + (row.email || 'this user') + '?' : 'Unban ' + (row.email || 'this user') + '?',
      body: banning
        ? 'They will no longer be able to sign in. Their data stays intact. Note: a session they already hold can stay valid for up to ~1 hour.'
        : 'They will be able to sign in again immediately.',
      danger: banning,
      confirmLabel: banning ? 'Ban user' : 'Unban user',
      onConfirm: async () => {
        await adminApi(banning ? 'ban_user' : 'unban_user', { user_id: d.userId });
        row.banned = banning;
        toast('ok', banning ? 'User banned. An existing session may last up to ~1 hour.' : 'User unbanned.');
        render();
      },
    });
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
  actCard.append(el('div', { class: 'btn-row' },
    banBtn,
    emailAction('Resend confirmation', 'resend_confirmation', 'Confirmation email sent.'),
    emailAction('Send password reset', 'send_password_reset', 'Password reset email sent.')), actMsg);
  root.append(actCard);

  // -- delete user (typed email confirm — unchanged server contract) --
  const delZone = el('div', { class: 'danger-zone' },
    el('h3', { text: 'Delete user' }),
    el('p', { class: 'small', text: 'Permanently deletes the account, every deal, every scanned image, settings, and audit history. Nothing can be recovered afterwards — the restore tool only works while audit history exists.' }));
  const delBtn = el('button', { class: 'btn btn-danger-outline', style: 'margin-top:10px', disabled: isAdmin, title: isAdmin ? adminTip : null }, 'Delete user…');
  delBtn.addEventListener('click', () => {
    const emailInput = el('input', { type: 'email', placeholder: row.email || 'email', autocomplete: 'off' });
    const confirmBtn = el('button', { class: 'btn btn-danger', disabled: true }, 'Permanently delete');
    const msg = el('p', { class: 'msg' });
    emailInput.addEventListener('input', () => { confirmBtn.disabled = emailInput.value !== row.email; });
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      setMsg(msg, 'info', 'Deleting…');
      try {
        const resp = await adminApi('delete_user', { user_id: d.userId, confirm_email: emailInput.value });
        state.detail.deleted = (resp && resp.deleted) || {};
        C.users = (C.users || []).filter((u) => u.user_id !== d.userId);
        wrapModal.remove();
        render();
      } catch (e) {
        confirmBtn.disabled = emailInput.value !== row.email;
        if (!e.handled) setMsg(msg, 'err', e.message);
      }
    });
    const modal = el('div', { class: 'modal' },
      el('h3', { text: 'Delete ' + (row.email || 'this user') + '?' }),
      el('div', { class: 'modal-body' },
        el('p', { text: 'This permanently deletes the account, all ' + intFmt(row.deal_count) + ' deals, scanned images, settings, and the audit history. It cannot be undone.' }),
        el('label', { class: 'field' }, 'Type the user’s email exactly to confirm:', emailInput)),
      msg,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => wrapModal.remove() }, 'Cancel'),
        confirmBtn));
    const wrapModal = window.DT.openLayer(modal, () => wrapModal.remove());
    emailInput.focus();
  });
  delZone.append(delBtn);
  root.append(delZone);

  // -- recent scan events --
  const evCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Recent scan events' }),
      tip('This user’s last 50 extraction requests — result, model, token spend, and timing.')));
  if (!d.data) {
    evCard.append(skeletonRows(4, 18));
  } else if (!d.data.events.length) {
    evCard.append(emptyState('No scan events', 'Scan history appears once this user runs an extraction. History exists from 2026-07-16 (telemetry deploy day).'));
  } else {
    evCard.append(buildTable(
      [{ label: 'When' }, { label: 'Status' }, { label: 'Model' }, { label: 'Tokens in/out', cls: 'num' }, { label: 'Duration', cls: 'num' }, { label: 'Error' }, { label: '' }],
      d.data.events.map((ev) => {
        const meta = ev.meta || {};
        const attempts = Array.isArray(meta.attempts) ? meta.attempts : null;
        const retried = !!(attempts && attempts.some((n) => Number(n) > 1));
        const recovered = Array.isArray(meta.recovered_on_retry) && meta.recovered_on_retry.some(Boolean);
        const lcf = Array.isArray(ev.low_confidence_fields) ? ev.low_confidence_fields : [];
        return {
          cells: [
            relTimeEl(ev.created_at),
            el('span', { title: lcf.length ? 'Low confidence: ' + lcf.join(', ') : null }, statusPill(ev.status)),
            ev.model || '—',
            (ev.input_tokens == null ? '—' : intFmt(ev.input_tokens)) + ' / ' + (ev.output_tokens == null ? '—' : intFmt(ev.output_tokens)),
            fmtDur(ev.duration_ms),
            ev.error_code || '—',
            el('span', {},
              retried ? el('span', { class: 'badge badge-outline', text: 'retried' }) : null,
              recovered ? el('span', { class: 'badge badge-success', text: 'recovered' }) : null),
          ],
        };
      })));
  }
  root.append(evCard);
  return root;
}

function sectionDeals(d) {
  const s = d.deals;
  const root = el('div', {});
  const search = el('input', { type: 'text', placeholder: 'Owner, account #, or deal id…', style: 'min-width:220px;flex:1' });
  search.value = s.query;
  const cancelledSel = el('select', {},
    el('option', { value: 'any', text: 'Cancelled: any' }),
    el('option', { value: 'false', text: 'Non-cancelled' }),
    el('option', { value: 'true', text: 'Cancelled only' }));
  cancelledSel.value = s.cancelled;
  const penderSel = el('select', {},
    el('option', { value: 'any', text: 'Type: any' }),
    el('option', { value: 'true', text: 'Penders' }),
    el('option', { value: 'false', text: 'Full downs' }));
  penderSel.value = s.pender;
  const go = () => {
    s.query = search.value;
    s.cancelled = cancelledSel.value;
    s.pender = penderSel.value;
    s.offset = 0;
    loadDeals(false);
  };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  cancelledSel.addEventListener('change', go);
  penderSel.addEventListener('change', go);
  root.append(el('div', { class: 'row', style: 'margin-bottom:12px' },
    search, el('button', { class: 'btn btn-primary btn-small', onclick: go }, 'Search'), cancelledSel, penderSel));

  if (s.error) root.append(el('p', { class: 'msg msg-err', text: s.error }));
  if (s.rows === null) { root.append(skeletonRows(6, 22)); return root; }
  if (!s.rows.length) {
    root.append(emptyState(
      s.query || s.cancelled !== 'any' || s.pender !== 'any' ? 'No deals match' : 'No deals yet',
      s.query ? 'Nothing matches that owner, account number, or id with the current filters.' : 'Deals appear here as this rep logs them.'));
    return root;
  }

  root.append(buildTable(
    [{ label: 'Date' }, { label: 'Owner' }, { label: 'Account' }, { label: 'Volume', cls: 'num' }, { label: 'Commission', cls: 'num' }, { label: 'Status' }, { label: 'Entry' }],
    s.rows.map((deal) => ({
      rowClass: 'clickable',
      onclick: () => nav('deal/' + deal.id),
      cells: [
        fmtISODate(deal.deal_date),
        deal.owner_name || '—',
        el('span', { class: 'mono-sm', text: deal.account_number || '—' }),
        money(deal.volume),
        money(deal.commission_amount),
        el('span', {}, dealStatusBadge(deal), sourceBadge(deal.commission_source)),
        deal.entry_method || '—',
      ],
    }))));

  const from = s.offset + 1;
  const to = s.offset + s.rows.length;
  root.append(el('div', { class: 'pager' },
    el('button', { class: 'btn btn-small', disabled: s.offset === 0, onclick: () => { s.offset = Math.max(0, s.offset - 50); loadDeals(false); } }, '‹ Prev'),
    el('span', { text: from + '–' + to + ' of ' + intFmt(s.total) }),
    el('button', { class: 'btn btn-small', disabled: to >= s.total, onclick: () => { s.offset = s.offset + 50; loadDeals(false); } }, 'Next ›')));
  return root;
}

function sectionActivity(d) {
  const s = d.activity;
  const root = el('div', {});
  root.append(el('p', { class: 'muted small', style: 'margin-bottom:10px', text: 'Row history across deals and settings. Field names only here — open a deal to see value-level diffs.' }));
  if (s.error) root.append(el('p', { class: 'msg msg-err', text: s.error }));
  if (s.rows === null) { root.append(skeletonRows(6, 18)); return root; }
  if (!s.rows.length) {
    root.append(emptyState('No recorded activity', 'Every create, edit, and delete on this user’s deals and settings is recorded here. History exists from 2026-07-16.'));
    return root;
  }
  root.append(el('div', { class: 'card' }, el('ul', { class: 'timeline' }, s.rows.map((aRow) => {
    let desc;
    if (aRow.action === 'INSERT') desc = el('span', { class: 'tl-created', text: 'row created' });
    else if (aRow.action === 'DELETE') desc = el('span', { class: 'tl-deleted', text: 'row deleted' });
    else {
      const names = changedFieldNames(aRow);
      const shown = names.slice(0, 12).map(humanize).join(', ');
      const extra = names.length > 12 ? ' +' + (names.length - 12) + ' more' : '';
      desc = el('span', { class: 'tl-fields', text: names.length ? shown + extra : 'no visible field changes' });
    }
    const isDeal = aRow.table_name === 'deals';
    return el('li', {
      class: isDeal ? 'clickable' : null,
      title: isDeal ? 'Open deal' : null,
      onclick: isDeal ? () => nav('deal/' + aRow.row_id) : null,
    },
      el('span', { class: 'tl-time', title: utcStr(aRow.changed_at), text: relTime(aRow.changed_at) }),
      ' ',
      el('span', { class: 'badge badge-neutral', text: aRow.table_name }),
      el('span', { class: 'badge ' + (aRow.action === 'DELETE' ? 'badge-danger' : aRow.action === 'INSERT' ? 'badge-success' : 'badge-outline'), text: aRow.action }),
      ' ', desc);
  }))));
  if (s.nextBefore) {
    root.append(el('div', { class: 'pager' },
      el('button', { class: 'btn btn-small', disabled: s.loadingMore, onclick: () => loadActivity(true) },
        s.loadingMore ? 'Loading…' : 'Load older')));
  }
  return root;
}

function sectionDeleted(d) {
  const s = d.deletedDeals;
  const root = el('div', {});
  root.append(el('p', { class: 'muted small', style: 'margin-bottom:10px', text: 'Deals this rep deleted appear here and can be restored exactly as they were at deletion — same id, same commission source.' }));
  if (s.error) root.append(el('p', { class: 'msg msg-err', text: s.error }));
  if (s.rows === null) { root.append(skeletonRows(5, 20)); return root; }
  if (!s.rows.length) {
    root.append(emptyState('No deleted deals', 'Deals a rep deletes appear here and can be restored from their audit snapshot.'));
    return root;
  }
  root.append(buildTable(
    [{ label: 'Deleted' }, { label: 'Owner' }, { label: 'Deal date' }, { label: 'Volume', cls: 'num' }, { label: 'Commission', cls: 'num' }, { label: 'Source' }, { label: '' }],
    s.rows.map((r) => ({
      cells: [
        relTimeEl(r.changed_at),
        el('span', {}, r.owner_name || '—', r.cancelled ? el('span', { class: 'badge badge-neutral', text: 'Cancelled' }) : null),
        fmtISODate(r.deal_date),
        money(r.volume),
        money(r.commission_amount),
        sourceBadge(r.commission_source),
        el('button', {
          class: 'btn btn-small',
          onclick: () => confirmModal({
            title: 'Restore this deal?',
            body: el('div', {},
              el('p', { text: 'Restores the deal exactly as it was at deletion — same ID, same commission source, every field verbatim. The restore itself is recorded in the deal’s history.' }),
              el('p', { class: 'muted small', text: (r.owner_name || 'Unknown owner') + ' · ' + fmtISODate(r.deal_date) + ' · ' + money(r.volume) })),
            confirmLabel: 'Restore deal',
            onConfirm: async () => {
              try {
                const resp = await adminApi('restore_deal', { deal_id: r.row_id });
                s.rows = s.rows.filter((x) => x.row_id !== r.row_id);
                d.deals.rows = null; // deals list is stale now
                toast('ok', 'Deal restored.');
                nav('deal/' + ((resp && resp.deal && resp.deal.id) || r.row_id));
              } catch (e) {
                const msgs = {
                  no_snapshot: 'No deletion snapshot exists for this deal.',
                  already_exists: 'A deal with this id already exists — it was likely already restored.',
                };
                throw new Error(msgs[e.code] || e.message);
              }
            },
          }),
        }, 'Restore…'),
      ],
    }))));
  return root;
}

// ---------------------------------------------------------------------------
// DEAL DRAWER (image + replay + read + edit + history)
// ---------------------------------------------------------------------------
function viewDrawer() {
  const dr = state.drawer;
  const editing = !!dr.edit;
  const backdrop = el('div', { class: 'layer-backdrop', style: 'z-index:99', onclick: () => { if (!dr.edit) closeDrawer(); } });
  const panel = el('div', { class: 'drawer' });

  const closeBtn = el('button', {
    class: 'btn btn-small',
    onclick: () => { if (!dr.edit) closeDrawer(); },
    disabled: editing,
    title: editing ? 'Finish or cancel the edit first' : null,
    text: '✕ Close',
  });

  if (!dr.data && !dr.error) {
    panel.append(el('div', { class: 'drawer-head' }, el('h2', { text: 'Deal' }), closeBtn), skeletonRows(8, 20));
    return el('div', {}, backdrop, panel);
  }
  if (dr.error) {
    panel.append(el('div', { class: 'drawer-head' }, el('h2', { text: 'Deal' }), closeBtn),
      el('p', { class: 'msg msg-err', text: dr.error }));
    return el('div', {}, backdrop, panel);
  }

  const deal = dr.data.deal;
  const owners = Array.isArray(deal.owner_names) ? deal.owner_names : [];
  const title = owners.length ? owners.join(', ') : 'Deal';

  panel.append(el('div', { class: 'drawer-head' },
    el('div', {},
      el('h2', { text: title }),
      el('p', { class: 'drawer-sub mono', text: deal.id || '' })),
    el('div', { class: 'btn-row', style: 'margin:0' },
      !editing ? el('button', { class: 'btn btn-primary btn-small', onclick: () => { dr.edit = { values: {}, confirm: '', force: false, msg: '', saving: false }; render(); } }, 'Edit') : null,
      closeBtn)));

  panel.append(el('div', { style: 'margin-bottom:12px' },
    dealStatusBadge(deal), sourceBadge(deal.commission_source),
    el('span', { class: 'badge badge-outline', text: deal.entry_method || '—' })));

  if (editing) panel.append(drawerEdit(dr));
  else panel.append(drawerRead(dr));

  return el('div', {}, backdrop, panel);
}

function drawerRead(dr) {
  const deal = dr.data.deal;
  const root = el('div', {});

  // -- scanned image + replay --
  if (dr.data.image_url || deal.source_image_ref) {
    const imgPanel = el('div', { class: 'deal-image-panel card', style: 'padding:14px' });
    if (dr.data.image_url) {
      const img = el('img', { class: 'deal-thumb', src: dr.data.image_url, alt: 'Scanned form', title: 'Click to view full size' });
      img.addEventListener('click', () => openLightbox(dr.data.image_url));
      imgPanel.append(img);
    } else {
      imgPanel.append(el('p', { class: 'muted small', text: 'An image path is stored but the preview link could not be created.' }));
    }
    const side = el('div', { class: 'grow' },
      el('h3', { text: 'Scanned form' }),
      el('p', { class: 'muted small', style: 'margin:4px 0 10px', text: 'The original photo this deal was extracted from. Click it to zoom.' }));
    const replayBtn = el('button', { class: 'btn btn-small', disabled: dr.replayRunning }, dr.replayRunning ? 'Replaying…' : '⟳ Replay extraction');
    replayBtn.addEventListener('click', () => {
      confirmModal({
        title: 'Replay the extraction?',
        body: 'Runs the current production prompt on the stored image and shows the result next to what’s saved — useful for judging whether a re-scan would read better today. Costs roughly $0.01–0.03 in API spend. Nothing about the deal is changed.',
        confirmLabel: 'Run replay',
        onConfirm: async () => {
          dr.replayRunning = true;
          dr.replay = null;
          render();
          try {
            dr.replay = await adminApi('replay_extraction', { deal_id: dr.dealId });
          } catch (e) {
            if (!e.handled) dr.replay = { error: e.message };
          }
          dr.replayRunning = false;
          render();
        },
      });
    });
    side.append(replayBtn);
    imgPanel.append(side);
    root.append(imgPanel);
  }

  if (dr.replayRunning) root.append(el('div', { class: 'card' }, skeletonRows(5, 16)));
  if (dr.replay) root.append(renderReplay(dr));

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

  if (deal.scan_event_id) {
    root.append(el('h4', { class: 'group-head', text: 'Scan event' }));
    const ev = dr.data.scan_event;
    if (!ev) {
      root.append(el('p', { class: 'muted small', text: 'Scan event ' + deal.scan_event_id + ' no longer exists (purged).' }));
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

  root.append(el('h4', { class: 'group-head', text: 'History' }));
  const audit = dr.data.audit || [];
  if (!audit.length) {
    root.append(el('p', { class: 'muted small', text: 'No audit history (predates the audit trigger — history exists from 2026-07-16).' }));
  } else {
    root.append(el('ul', { class: 'timeline' }, audit.map((a) => {
      const li = el('li', {},
        el('span', { class: 'tl-time', title: utcStr(a.changed_at), text: fmtDateTime(a.changed_at) }),
        ' ',
        el('span', { class: 'badge ' + (a.action === 'DELETE' ? 'badge-danger' : a.action === 'INSERT' ? 'badge-success' : 'badge-outline'), text: a.action }));
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

function renderReplay(dr) {
  const r = dr.replay;
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-title' }, el('h2', { text: 'Replay result' }),
    tip('What the model reads from the stored image TODAY (left: saved on the deal; right: fresh read). Matching rows are dimmed; differences are highlighted.')));
  if (r.error) {
    card.append(el('p', { class: 'msg msg-err', text: 'Replay failed: ' + r.error }));
    return card;
  }
  card.append(el('div', { class: 'callout callout-info', style: 'margin-bottom:12px' },
    el('div', { class: 'callout-body' },
      el('strong', { text: 'Diagnostic only — nothing was changed' }),
      'Prompt ' + (r.prompt_version || '—') + ' · ' + intFmt(r.input_tokens) + ' in / ' + intFmt(r.output_tokens) + ' out tokens · est. ' + (r.est_cost_usd == null ? '—' : fmtCost(r.est_cost_usd)))));

  const stored = r.stored_fields || {};
  const replayed = r.replayed_fields || {};
  const rows = EXTRACTED_FIELDS.map((f) => {
    const sv = stored[f] === undefined ? null : stored[f];
    const rv = replayed[f] === undefined ? null : replayed[f];
    const match = valueEq(sv, rv);
    return {
      cells: [
        humanize(f),
        el('span', { text: readValue(f, sv) }),
        el('span', { text: readValue(f, rv) }),
      ],
      rowClass: match ? 'match-row' : 'mismatch-row',
      _match: match,
    };
  });
  const tableWrap = buildTable(
    [{ label: 'Field' }, { label: 'Stored on the deal' }, { label: 'Fresh replay' }],
    rows, { noCollapse: true });
  // apply match/mismatch cell classes
  const trs = tableWrap.querySelectorAll('tbody tr');
  trs.forEach((tr, i) => {
    const match = rows[i]._match;
    tr.querySelectorAll('td').forEach((td, j) => { if (j > 0) td.classList.add(match ? 'match' : 'mismatch'); });
  });
  tableWrap.querySelector('table').classList.add('replay-table');
  card.append(tableWrap);
  const diffs = rows.filter((x) => !x._match).length;
  card.append(el('p', { class: 'muted small', style: 'margin-top:8px', text: diffs === 0 ? 'The fresh read matches every stored field exactly.' : diffs + ' field(s) read differently. Stored values may have been hand-corrected after scanning — a difference is not automatically an error.' }));
  return card;
}

function drawerEdit(dr) {
  const deal = dr.data.deal;
  const edit = dr.edit;
  const root = el('div', {});
  const imported = deal.commission_source === 'imported';

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
        input = el('textarea', { rows: '4', class: 'edit-area', placeholder: t === 'json-array' ? '[]' : 'null' });
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

  const footer = el('div', {});
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

  const confirmInput = el('input', { type: 'text', class: 'confirm-input', placeholder: 'CONFIRM', autocomplete: 'off', spellcheck: 'false' });
  confirmInput.value = edit.confirm;
  const saveBtn = el('button', { class: 'btn btn-danger' }, 'Save changes');
  const cancelBtn = el('button', { class: 'btn', onclick: () => { dr.edit = null; render(); } }, 'Cancel');
  const saveMsg = el('p', { class: 'msg' });
  if (edit.msg) setMsg(saveMsg, 'err', edit.msg);
  confirmInput.addEventListener('input', () => { edit.confirm = confirmInput.value; updateFooter(); });

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
      diffPanel.append(el('p', { class: 'muted small', text: 'No pending changes.' }));
    } else {
      if (keys.length) diffPanel.append(el('p', { class: 'diff-head', text: 'Pending changes (' + keys.length + ')' }));
      for (const k of keys) {
        diffPanel.append(el('div', { class: 'diff-row' },
          el('span', { class: 'tl-field', text: humanize(k) + ': ' }),
          el('span', { class: 'diff-old', text: fmtVal(deal[k] === undefined ? null : deal[k]) }),
          ' → ',
          el('span', { class: 'diff-new', text: fmtVal(pending[k]) }),
          GUARD_FIELDS.includes(k) && imported
            ? el('span', { class: 'badge badge-danger', text: 'guarded' }) : null));
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
      toast('ok', 'Deal saved.');
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

  footer.append(el('div', { class: 'row', style: 'margin-top:4px' },
    el('span', { class: 'muted small', text: 'Type CONFIRM to enable Save:' }),
    confirmInput, saveBtn, cancelBtn));
  footer.append(saveMsg);
  root.append(footer);
  updateFooter();
  return root;
}

// ---------------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------------
function statsBlank(key) {
  return {
    date: key, total: 0, success: 0, parse_fail: 0, api_fail: 0,
    blocked_quota: 0, blocked_kill_switch: 0, recovered_count: 0,
    input_tokens: 0, output_tokens: 0, est_cost_usd: null,
  };
}

function viewStats() {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'page-head' },
    el('h1', { text: 'Stats' }),
    el('button', { class: 'btn btn-small', onclick: () => { loadStats(true); loadHealth(true); } }, '↻ Refresh')));
  wrap.append(purpose('Scanning volume, quality, and cost over the last 30 days. All day buckets are UTC.'));
  if (C.statsErr) wrap.append(el('p', { class: 'msg msg-err', text: C.statsErr }));
  if (C.stats === null) {
    wrap.append(el('div', { class: 'skeleton skel-block' }), skeletonRows(6, 20));
    return wrap;
  }

  const rows = zeroFillDays(C.stats, 30, 'date', statsBlank).map((r) => ({
    date: r.date,
    total: num(r.total),
    success: num(r.success),
    failures: num(r.parse_fail) + num(r.api_fail),
    // "blocked/other" = everything that isn't success or a failure, so newer
    // blocked statuses (e.g. the budget breaker) are never silently dropped.
    blocked: Math.max(0, num(r.total) - num(r.success) - num(r.parse_fail) - num(r.api_fail)),
    recovered: num(r.recovered_count != null ? r.recovered_count : r.recovered),
    tokens_in: num(r.input_tokens),
    tokens_out: num(r.output_tokens),
    est_cost_usd: r.est_cost_usd == null ? null : Number(r.est_cost_usd),
  }));

  wrap.append(el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Scan outcomes' }),
      tip('Per UTC day: successful scans, failed scans (parse or API errors), and blocked attempts (quota, kill switch, or budget).')),
    lineChart([
      { label: 'Success', color: 'var(--success)', area: true, points: rows.map((r) => ({ x: r.date, y: r.success })) },
      { label: 'Failures', color: 'var(--danger)', points: rows.map((r) => ({ x: r.date, y: r.failures })) },
      { label: 'Blocked', color: 'var(--warning)', points: rows.map((r) => ({ x: r.date, y: r.blocked })) },
    ], { height: 210 })));

  const totals = rows.reduce((acc, r) => {
    acc.total += r.total; acc.success += r.success; acc.failures += r.failures;
    acc.blocked += r.blocked; acc.recovered += r.recovered;
    acc.tokens_in += r.tokens_in; acc.tokens_out += r.tokens_out;
    if (r.est_cost_usd != null) { acc.cost += r.est_cost_usd; acc.hasCost = true; }
    return acc;
  }, { total: 0, success: 0, failures: 0, blocked: 0, recovered: 0, tokens_in: 0, tokens_out: 0, cost: 0, hasCost: false });

  const tfoot = el('tfoot', {}, el('tr', {},
    el('th', { text: 'Total' }),
    el('td', { class: 'num', text: intFmt(totals.total) }),
    el('td', { class: 'num', text: intFmt(totals.success) }),
    el('td', { class: 'num', text: intFmt(totals.failures) }),
    el('td', { class: 'num', text: intFmt(totals.blocked) }),
    el('td', { class: 'num', text: intFmt(totals.recovered) }),
    el('td', { class: 'num', text: intFmt(totals.tokens_in) }),
    el('td', { class: 'num', text: intFmt(totals.tokens_out) }),
    el('td', { class: 'num', text: totals.hasCost ? fmtCost(totals.cost) : '—' })));

  const dayTable = buildTable(
    [
      { label: 'Day (UTC)' },
      { label: 'Total', cls: 'num' },
      { label: 'Success', cls: 'num' },
      { label: 'Failures', cls: 'num', tip: 'Scans that ran but produced no usable result — parse failures plus API errors.' },
      { label: 'Blocked', cls: 'num', tip: 'Attempts stopped before running: daily quota, the kill switch, or the monthly budget.' },
      { label: 'Recovered', cls: 'num', tip: 'Images that failed once and succeeded on the automatic retry.' },
      { label: 'Tokens in', cls: 'num' },
      { label: 'Tokens out', cls: 'num' },
      { label: 'Est. cost', cls: 'num', tip: 'Estimated Claude spend from token counts at current pricing. “—” = a day with usage the pricing map couldn’t cost.' },
    ],
    rows.map((r) => ({
      cells: [r.date, intFmt(r.total), intFmt(r.success), intFmt(r.failures), intFmt(r.blocked),
        intFmt(r.recovered), intFmt(r.tokens_in), intFmt(r.tokens_out),
        r.est_cost_usd == null ? (r.total ? '—' : '') : fmtCost(r.est_cost_usd)],
    })), { tfoot });
  wrap.append(el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Per-day detail' })), dayTable));

  // ---- health ----
  wrap.append(el('h2', { style: 'margin:24px 0 4px', text: 'Health' }));
  wrap.append(purpose('How well extraction is working: speed percentiles, per-prompt success rates, and the latest failures.'));
  if (C.healthErr) wrap.append(el('p', { class: 'msg msg-err', text: C.healthErr }));
  if (C.health === null) { wrap.append(skeletonRows(5, 20)); return wrap; }
  const h = C.health;

  const hDaily = zeroFillDays(h.daily, 30, 'date', (key) => ({
    date: key, total: 0, success: 0, parse_fail: 0, api_fail: 0,
    blocked_quota: 0, blocked_kill_switch: 0, recovered_count: 0,
    p50_duration_ms: null, p95_duration_ms: null,
  }));

  wrap.append(el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Extraction latency' }),
      tip('How long the model call takes per scan. p50 = a typical scan; p95 = the slow ones. Gaps are days with no scans.')),
    lineChart([
      { label: 'p50', color: 'var(--accent)', points: hDaily.map((r) => ({ x: r.date, y: num(r.p50_duration_ms) / 1000 })) },
      { label: 'p95', color: 'var(--warning)', points: hDaily.map((r) => ({ x: r.date, y: num(r.p95_duration_ms) / 1000 })) },
    ], { height: 180, yFormat: (v) => v.toFixed(1) + 's' })));

  const vCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'By prompt version × model' }),
      tip('Success rate per prompt/model combination — the number to watch when the prompt or model changes.')));
  if (!h.by_version.length) {
    vCard.append(emptyState('No scan events in the window', 'This fills in once scans run.'));
  } else {
    vCard.append(buildTable(
      [{ label: 'Prompt' }, { label: 'Model' }, { label: 'Total', cls: 'num' }, { label: 'Success rate', cls: 'num' }, { label: 'Recovered', cls: 'num' }, { label: 'Avg tokens in', cls: 'num' }, { label: 'Avg tokens out', cls: 'num' }],
      h.by_version.map((v) => ({
        cells: [v.prompt_version || '—', v.model || '—', intFmt(v.total), pctFmt(v.success_rate),
          intFmt(v.recovered_count), intFmt(v.avg_input_tokens), intFmt(v.avg_output_tokens)],
      }))));
  }
  wrap.append(vCard);

  const fCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Recent failures (last 25, all time)' })));
  if (!h.recent_failures.length) {
    fCard.append(emptyState('No failures recorded', 'Failed and blocked scans appear here with their error code.'));
  } else {
    fCard.append(buildTable(
      [{ label: 'When' }, { label: 'User' }, { label: 'Status' }, { label: 'Error' }, { label: 'Duration', cls: 'num' }],
      h.recent_failures.map((r) => ({
        cells: [relTimeEl(r.created_at), r.email || '—', statusPill(r.status), r.error_code || '—', fmtDur(r.duration_ms)],
      }))));
  }
  wrap.append(fCard);
  return wrap;
}

// ---------------------------------------------------------------------------
// TOOLS (Integrity · Storage · Data)
// ---------------------------------------------------------------------------
function viewTools() {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'page-head' }, el('h1', { text: 'Tools' })));
  wrap.append(purpose('Deeper maintenance: data consistency checks across every account, storage cleanup, and database housekeeping.'));

  const tabs = [['integrity', 'Integrity'], ['storage', 'Storage'], ['data', 'Data']];
  wrap.append(el('div', { class: 'subtabs' }, tabs.map(([id, label]) =>
    el('button', { class: 'subtab' + (state.toolsTab === id ? ' active' : ''), onclick: () => nav('tools/' + id) }, label))));

  if (state.toolsTab === 'storage') wrap.append(toolsStorage());
  else if (state.toolsTab === 'data') wrap.append(toolsData());
  else wrap.append(toolsIntegrity());
  return wrap;
}

function toolsIntegrity() {
  const root = el('div', {});
  root.append(el('p', { class: 'muted small', style: 'margin-bottom:12px;max-width:70ch' },
    'Runs read-only consistency checks over every deal in the database, derived from the app’s business rules. Nothing is changed — each finding is a review item, and some (like the chargeback list) are expected data, not errors.'));
  const runBtn = el('button', { class: 'btn btn-primary', disabled: C.integrityRunning }, C.integrityRunning ? 'Running…' : '✓ Run all checks');
  runBtn.addEventListener('click', runIntegrityGlobal);
  root.append(el('div', { class: 'row', style: 'margin-bottom:14px' }, runBtn,
    C.integrity ? el('span', { class: 'muted small', text: intFmt(C.integrity.total_deals) + ' deals examined' }) : null));
  if (C.integrityErr) root.append(el('p', { class: 'msg msg-err', text: C.integrityErr }));
  if (C.integrityRunning) { root.append(skeletonRows(5, 26)); return root; }
  if (!C.integrity) {
    root.append(emptyState('Not run yet', 'Click “Run all checks” to examine every deal. Takes a few seconds.'));
    return root;
  }
  root.append(renderIntegrityChecks(C.integrity, true));
  return root;
}

// Shared integrity renderer (Tools global run + per-user run). Rows grouped
// by user when global.
function renderIntegrityChecks(resp, groupByUser) {
  const emailById = new Map((C.users || []).map((u) => [u.user_id, u.email || u.user_id]));
  const root = el('div', {});
  for (const check of (resp.checks || [])) {
    const clean = check.count === 0;
    const head = el('button', { class: 'check-head' },
      severityBadge(check.severity),
      el('span', { class: 'strong', text: check.title }),
      el('span', { class: 'muted', text: clean ? 'clean' : intFmt(check.count) + (check.id === 'duplicate_accounts' ? ' account(s)' : check.id === 'source_distribution' ? ' deals' : ' deal(s)') }),
      el('span', { class: 'grow' }),
      el('span', { class: 'muted', text: clean ? '' : '▾' }));
    const body = el('div', { class: 'check-body hidden' });
    body.append(el('p', { class: 'check-plain', text: check.plain_english }));

    const rows = Array.isArray(check.rows) ? check.rows : [];
    if (rows.length) {
      // column set = union of row keys minus ids, in first-seen order
      const cols = [];
      for (const r of rows) for (const k of Object.keys(r)) {
        if (k === 'id' || k === 'user_id') continue;
        if (!cols.includes(k)) cols.push(k);
      }
      const grouped = groupByUser
        ? [...rows.reduce((m, r) => { const k = r.user_id || '—'; (m.get(k) || m.set(k, []).get(k)).push(r); return m; }, new Map())]
        : [[null, rows]];
      for (const [uid, groupRows] of grouped) {
        if (groupByUser) body.append(el('p', { class: 'small strong', style: 'margin:10px 0 6px', text: emailById.get(uid) || uid }));
        body.append(buildTable(
          cols.map((c) => ({ label: humanize(c), cls: typeof groupRows[0][c] === 'number' ? 'num' : null })),
          groupRows.map((r) => ({
            rowClass: 'clickable',
            onclick: () => nav('deal/' + r.id),
            cells: cols.map((c) => {
              const v = r[c];
              if (v === null || v === undefined) return '—';
              if (typeof v === 'boolean') return v ? 'Yes' : 'No';
              if (/amount|volume|price|expected/.test(c)) return money(v);
              if (/date/.test(c)) return fmtISODate(v);
              return String(v);
            }),
          }))));
      }
      if (check.count > rows.length && check.id !== 'source_distribution') {
        body.append(el('p', { class: 'muted small', style: 'margin-top:6px', text: 'Showing the first ' + rows.length + ' — ' + intFmt(check.count) + ' total.' }));
      }
    } else if (!clean && check.id !== 'source_distribution') {
      body.append(el('p', { class: 'muted small', text: 'No row detail returned.' }));
    }
    if (clean) head.style.opacity = '0.6';
    head.addEventListener('click', () => body.classList.toggle('hidden'));
    root.append(el('div', { class: 'check-card' }, head, body));
  }
  return root;
}

const GB = 1024 * 1024 * 1024;

function toolsStorage() {
  const root = el('div', {});
  root.append(el('p', { class: 'muted small', style: 'margin-bottom:12px;max-width:70ch' },
    'What the scanned-image bucket holds, per user, and which files no longer belong to any deal (orphans — usually scans whose batch was never confirmed). The 1 GB bar is the Supabase free-tier storage allowance.'));
  const runBtn = el('button', { class: 'btn btn-primary', disabled: C.storageRunning }, C.storageRunning ? 'Scanning bucket…' : '⟳ Run storage report');
  runBtn.addEventListener('click', runStorageReport);
  root.append(el('div', { class: 'row', style: 'margin-bottom:14px' }, runBtn));
  if (C.storageErr) root.append(el('p', { class: 'msg msg-err', text: C.storageErr }));
  if (C.storageRunning) { root.append(skeletonRows(5, 24)); return root; }
  if (!C.storage) {
    root.append(emptyState('Not run yet', 'Click “Run storage report” to inventory the image bucket. Takes a few seconds.'));
    return root;
  }
  const s = C.storage;

  const bucketCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Bucket total' })),
    el('p', { class: 'strong', text: fmtBytes(s.bucket.total_bytes) + ' across ' + intFmt(s.bucket.object_count) + ' images' }),
    el('div', { class: 'progress' + (s.bucket.total_bytes / GB >= 0.8 ? ' warn' : ''), style: 'margin-top:8px' },
      el('span', { style: 'width:' + Math.min(100, (s.bucket.total_bytes / GB) * 100).toFixed(2) + '%' })),
    el('p', { class: 'muted small', style: 'margin-top:5px', text: ((s.bucket.total_bytes / GB) * 100).toFixed(1) + '% of the 1 GB free-tier allowance' }));
  root.append(bucketCard);

  const perUserCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Per user' }),
      tip('Each user’s share of the bucket, against the same 1 GB allowance.')));
  for (const u of (s.per_user || [])) {
    perUserCard.append(el('div', { class: 'user-bar-row' },
      el('span', { text: u.email || u.user_id, style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }),
      el('div', { class: 'progress' }, el('span', { style: 'width:' + Math.min(100, (u.total_bytes / GB) * 100).toFixed(2) + '%' })),
      el('span', { class: 'muted small', text: fmtBytes(u.total_bytes) + ' · ' + intFmt(u.object_count) })));
  }
  if (!(s.per_user || []).length) perUserCard.append(emptyState('Bucket is empty', 'Nothing has been uploaded yet.'));
  root.append(perUserCard);

  const orphans = s.orphans || [];
  const selected = s._selected || (s._selected = new Set());
  const oCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Orphaned images (' + intFmt(orphans.length) + ')' }),
      tip('Files in the bucket that no live deal points at. They usually come from scans whose batch was never confirmed. A very recent orphan can be a scan in progress RIGHT NOW — leave anything newer than a day alone.')));
  if (!orphans.length) {
    oCard.append(emptyState('No orphans', 'Every stored image belongs to a live deal.'));
  } else {
    const delBtn = el('button', { class: 'btn btn-danger-outline btn-small', disabled: selected.size === 0 },
      'Delete selected (' + selected.size + ')…');
    const syncDel = () => {
      delBtn.disabled = selected.size === 0;
      delBtn.textContent = 'Delete selected (' + selected.size + ')…';
    };
    oCard.append(buildTable(
      [{ label: '' }, { label: 'Preview' }, { label: 'Path' }, { label: 'Owner' }, { label: 'Size', cls: 'num' }, { label: 'Uploaded' }],
      orphans.map((o) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = selected.has(o.path);
        cb.addEventListener('change', () => { if (cb.checked) selected.add(o.path); else selected.delete(o.path); syncDel(); });
        const img = o.signed_url
          ? el('img', { class: 'orphan-thumb', src: o.signed_url, alt: '', title: 'Click to view', style: 'cursor:zoom-in' })
          : el('span', { class: 'muted small', text: 'no preview' });
        if (o.signed_url) img.addEventListener('click', () => openLightbox(o.signed_url));
        const fresh = o.created_at && (Date.now() - Date.parse(o.created_at)) < 24 * 3600 * 1000;
        return {
          cells: [cb, img,
            el('span', { class: 'mono-sm', text: truncate(o.path, 46), title: o.path }),
            o.email || o.owner_folder,
            fmtBytes(o.size),
            el('span', {}, relTimeEl(o.created_at), fresh ? el('span', { class: 'badge badge-warning', text: 'recent' }) : null)],
        };
      }), { noCollapse: true }));
    delBtn.addEventListener('click', () => {
      const paths = [...selected].slice(0, 100);
      confirmModal({
        title: 'Delete ' + paths.length + ' orphaned image(s)?',
        danger: true,
        typed: 'DELETE',
        confirmLabel: 'Delete images',
        body: el('div', {},
          el('p', { text: 'Permanently removes these files from storage. They belong to no deal, so no deal loses its image — but if one is a scan happening right now (uploaded within the last day, marked “recent”), that rep’s “View Original” will be broken for the deal they’re about to save.' }),
          el('p', { text: 'The server re-checks every path at execution time and refuses any that a deal references. This cannot be undone.' })),
        onConfirm: async () => {
          const resp = await adminApi('delete_orphans', { paths, confirm: 'DELETE' });
          toast('ok', 'Deleted ' + intFmt(resp.deleted) + ' file(s)' + ((resp.skipped || []).length ? ' · ' + resp.skipped.length + ' skipped (now referenced)' : '') + '.');
          runStorageReport();
        },
      });
    });
    oCard.append(el('div', { class: 'btn-row' }, delBtn));
  }
  root.append(oCard);
  return root;
}

function toolsData() {
  const root = el('div', {});
  root.append(el('p', { class: 'muted small', style: 'margin-bottom:12px;max-width:70ch' },
    'Database table sizes, and pruning for the two tables that grow forever (scan telemetry and audit history).'));
  const refresh = el('button', { class: 'btn btn-small', onclick: () => loadTables(true) }, '↻ Refresh');
  root.append(el('div', { class: 'row', style: 'margin-bottom:12px' }, refresh));
  if (C.tablesErr) root.append(el('p', { class: 'msg msg-err', text: C.tablesErr }));
  if (C.tables === null) { root.append(skeletonRows(6, 18)); return root; }

  const tCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Table sizes' }),
      tip('Row counts and on-disk size (including indexes) for every app table.')));
  tCard.append(buildTable(
    [{ label: 'Table' }, { label: 'Rows', cls: 'num' }, { label: 'On disk', cls: 'num' }],
    (C.tables || []).map((t) => ({
      cells: [el('span', { class: 'mono-sm', text: t.table_name }), intFmt(t.row_count), fmtBytes(t.total_bytes)],
    }))));
  root.append(tCard);

  const pruneCard = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Prune history' }),
      tip('Deletes rows older than the cutoff. Both tables are history, not live data — the app never reads them. Minimum age: 3 months.')));
  const mkPrune = (table, label, extraWarning) => {
    const months = el('input', { type: 'number', min: '3', step: '1', value: '12', class: 'input-small' });
    const btn = el('button', { class: 'btn btn-danger-outline btn-small' }, 'Prune…');
    btn.addEventListener('click', () => {
      const m = Number(months.value);
      if (!Number.isInteger(m) || m < 3) { toast('err', 'Months must be a whole number of at least 3.'); return; }
      confirmModal({
        title: 'Prune ' + label + ' older than ' + m + ' months?',
        danger: true,
        typed: 'PRUNE',
        confirmLabel: 'Prune rows',
        body: el('div', {},
          el('p', { text: 'Permanently deletes every ' + label + ' row older than ' + m + ' months. This cannot be undone.' }),
          extraWarning ? el('p', { class: 'strong', text: extraWarning }) : null),
        onConfirm: async () => {
          const resp = await adminApi('prune_table', { table, older_than_months: m, confirm: 'PRUNE' });
          toast('ok', 'Pruned ' + intFmt(resp.deleted) + ' row(s) from ' + table + '.');
          loadTables(true);
        },
      });
    });
    return el('div', { class: 'setting-row' },
      el('div', { class: 'setting-main' },
        el('span', { class: 'strong', text: label }),
        el('span', { class: 'field-hint', text: table === 'audit_log'
          ? 'Row-change history for deals and settings. WARNING: pruning audit history destroys the restore snapshots for deals deleted before the cutoff — those deals become permanently unrestorable.'
          : 'Per-scan telemetry (results, tokens, timings). Pruning old rows only shortens the Stats history; nothing in the app depends on them.' })),
      el('div', { class: 'row' }, 'older than', months, 'months', btn));
  };
  pruneCard.append(mkPrune('scan_events', 'scan telemetry'));
  pruneCard.append(mkPrune('audit_log', 'audit history', 'Restore snapshots older than the cutoff are destroyed with it — deleted deals from before the cutoff can never be restored again.'));
  root.append(pruneCard);
  return root;
}

// ---------------------------------------------------------------------------
// LOG
// ---------------------------------------------------------------------------
function paramsCompact(p) {
  if (!p || typeof p !== 'object') return '—';
  const entries = Object.entries(p);
  if (!entries.length) return '—';
  return entries.map(([k, v]) =>
    k + '=' + (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v))).join('  ');
}

function viewLog() {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'page-head' },
    el('h1', { text: 'Log' }),
    el('button', { class: 'btn btn-small', onclick: () => loadLog(false) }, '↻ Refresh')));
  wrap.append(purpose('Every change an admin has made through this panel, newest first. Params carry field names and counts — the values themselves live in each deal’s history.'));
  if (C.logErr) wrap.append(el('p', { class: 'msg msg-err', text: C.logErr }));
  if (C.log === null) { wrap.append(skeletonRows(8, 20)); return wrap; }
  const rows = C.log.rows;
  if (!rows.length) {
    wrap.append(emptyState('No admin actions recorded yet', 'Every mutation made through this panel lands here with who did it and when.'));
    return wrap;
  }
  wrap.append(buildTable(
    [{ label: 'When' }, { label: 'Admin' }, { label: 'Action' }, { label: 'Target' }, { label: 'Params' }],
    rows.map((r) => {
      const target = r.target_email
        || (r.target_user_id ? truncate(r.target_user_id, 13) : null)
        || r.target_id || '—';
      const compact = paramsCompact(r.params);
      return {
        rowClass: r.target_user_id ? 'clickable' : null,
        onclick: r.target_user_id ? () => nav('user/' + r.target_user_id + '/overview') : null,
        cells: [
          relTimeEl(r.created_at),
          r.admin_email || truncate(r.admin_user_id || '—', 13),
          el('span', { class: 'badge badge-neutral', text: r.action }),
          el('span', { text: target, title: r.target_user_id || null }),
          el('span', { class: 'params-cell', text: truncate(compact, 160), title: compact === '—' ? null : compact }),
        ],
      };
    })));
  if (C.log.nextBefore) {
    wrap.append(el('div', { class: 'pager' },
      el('button', { class: 'btn btn-small', onclick: () => loadLog(true) }, 'Load older')));
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// SETTINGS (Scanning · App · Admins)
// ---------------------------------------------------------------------------
function viewSettings() {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'page-head' }, el('h1', { text: 'Settings' })));
  wrap.append(purpose('App-wide controls: scanning and its cost ceilings, what users see in the app, and who can use this panel.'));
  if (C.configErr) wrap.append(el('p', { class: 'msg msg-err', text: C.configErr }));
  wrap.append(settingsScanning());
  wrap.append(settingsApp());
  wrap.append(settingsAdmins());
  return wrap;
}

function settingsScanning() {
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Scanning' })));
  const cfg = C.config;
  if (!cfg) { card.append(skeletonRows(3, 20)); return card; }

  // -- kill switch --
  // unknown ≠ default: scanning_enabled === undefined means the backend did
  // not return the key — explicit unknown state, control disabled, never a
  // fallback OFF (or ON).
  const toggle = el('input', { type: 'checkbox' });
  const hint = el('p', { class: 'field-hint' });
  const syncToggle = () => {
    const v = C.config.scanning_enabled;
    toggle.checked = v === true;
    toggle.disabled = typeof v !== 'boolean';
    if (typeof v !== 'boolean') {
      hint.className = 'msg msg-err';
      hint.textContent = 'Unknown — the backend did not return scanning_enabled. Control disabled.';
    } else if (v) {
      hint.className = 'field-hint';
      hint.textContent = 'Scanning is on. Flipping this off makes every scan fail, for every user, until it’s re-enabled.';
    } else {
      hint.className = 'msg msg-err';
      hint.textContent = 'Scanning is currently DISABLED — every scan fails until re-enabled.';
    }
  };
  syncToggle();
  toggle.addEventListener('change', () => {
    syncToggle(); // revert; only the confirm applies the change
    if (typeof C.config.scanning_enabled !== 'boolean') return;
    const disabling = C.config.scanning_enabled;
    confirmModal({
      title: disabling ? 'Disable scanning for ALL users?' : 'Re-enable scanning?',
      danger: disabling,
      confirmLabel: disabling ? 'Disable scanning' : 'Enable scanning',
      body: disabling
        ? 'Every scan attempt, by every user, will fail with a “temporarily unavailable” message until this is turned back on. Use it for cost emergencies or a bad model day.'
        : 'Scanning resumes immediately for all users (their daily caps still apply).',
      onConfirm: async () => {
        await adminApi('set_config', { key: 'scanning_enabled', value: !disabling });
        const resp = await adminApi('get_config');
        C.config = normalizeConfig(resp);
        toast('ok', C.config.scanning_enabled === true ? 'Scanning enabled.' : 'Scanning disabled.');
        C.dashboard = null; // overview callouts are stale now
        render();
      },
    });
  });
  card.append(el('div', { class: 'setting-row' },
    el('label', { class: 'switch' }, toggle, el('span', { class: 'slider' })),
    el('div', { class: 'setting-main' },
      el('span', { class: 'strong' }, 'Scanning enabled ', tip('The kill switch. OFF = extract-deal refuses every request app-wide. Cost controls fail open, but this switch is checked first on every scan.')),
      hint)));

  // -- default cap --
  const capKnown = typeof cfg.default_daily_scan_cap === 'number';
  const capInput = el('input', { type: 'number', min: '0', step: '1', class: 'input-small', value: capKnown ? String(cfg.default_daily_scan_cap) : '', placeholder: capKnown ? null : 'unknown', disabled: !capKnown });
  const capMsg = el('span', { class: 'msg' });
  const capSave = el('button', { class: 'btn btn-primary btn-small', disabled: !capKnown }, 'Save');
  capSave.addEventListener('click', async () => {
    const raw = capInput.value.trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 0) { setMsg(capMsg, 'err', 'Enter a non-negative whole number.'); return; }
    capSave.disabled = true;
    setMsg(capMsg, 'info', 'Saving…');
    try {
      await adminApi('set_config', { key: 'default_daily_scan_cap', value: n });
      const resp = await adminApi('get_config');
      C.config = normalizeConfig(resp);
      capInput.value = typeof C.config.default_daily_scan_cap === 'number' ? String(C.config.default_daily_scan_cap) : '';
      setMsg(capMsg, 'ok', 'Saved.');
    } catch (e) {
      if (!e.handled) setMsg(capMsg, 'err', e.message);
    }
    capSave.disabled = false;
  });
  card.append(el('div', { class: 'setting-row' },
    el('div', { class: 'setting-main' },
      el('span', { class: 'strong' }, 'Default daily scan cap ', tip('How many scans a user may run per rolling 24 hours unless they have a personal override (set on their user page). Blocked attempts don’t count against it.')),
      el('span', { class: capKnown ? 'field-hint' : 'msg msg-err', text: capKnown ? 'Applies to every user without a per-user override.' : 'Unknown — the backend did not return default_daily_scan_cap. Control disabled.' }),
      el('div', { class: 'row' }, capInput, capSave, capMsg))));

  // -- monthly budget --
  const budKnown = typeof cfg.monthly_budget_usd === 'number';
  const budInput = el('input', { type: 'number', min: '0', step: '1', class: 'input-small', value: budKnown ? String(cfg.monthly_budget_usd) : '', placeholder: budKnown ? null : 'unknown', disabled: !budKnown });
  const budMsg = el('span', { class: 'msg' });
  const budSave = el('button', { class: 'btn btn-primary btn-small', disabled: !budKnown }, 'Save');
  budSave.addEventListener('click', async () => {
    const raw = budInput.value.trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n < 0) { setMsg(budMsg, 'err', 'Enter a non-negative dollar amount.'); return; }
    budSave.disabled = true;
    setMsg(budMsg, 'info', 'Saving…');
    try {
      await adminApi('set_config', { key: 'monthly_budget_usd', value: n });
      const resp = await adminApi('get_config');
      C.config = normalizeConfig(resp);
      budInput.value = typeof C.config.monthly_budget_usd === 'number' ? String(C.config.monthly_budget_usd) : '';
      setMsg(budMsg, 'ok', 'Saved.');
      C.dashboard = null;
    } catch (e) {
      if (!e.handled) setMsg(budMsg, 'err', e.message);
    }
    budSave.disabled = false;
  });
  card.append(el('div', { class: 'setting-row' },
    el('div', { class: 'setting-main' },
      el('span', { class: 'strong' }, 'Monthly budget (USD) ', tip('The automatic cost stop. When the month’s estimated Claude spend reaches this number, scanning is blocked for everyone until the calendar month rolls over (UTC) or you raise the ceiling. Users see the same “temporarily unavailable” message as the kill switch.')),
      el('span', { class: budKnown ? 'field-hint' : 'msg msg-err', text: budKnown
        ? 'What happens when it’s exceeded: every scan is refused with a “temporarily unavailable” message — no data is lost, and scanning resumes automatically next month or when the budget is raised.'
        : 'Unknown — the backend did not return monthly_budget_usd. Control disabled.' }),
      el('div', { class: 'row' }, '$', budInput, budSave, budMsg))));
  return card;
}

// client_config parsers — unknown ≠ default: an unparseable key renders an
// explicit unknown state with its composer disabled.
function ccBroadcast() {
  const v = C.clientConfig ? C.clientConfig.broadcast : undefined;
  if (!v || typeof v !== 'object') return undefined;
  if (typeof v.active !== 'boolean' || !Number.isInteger(v.id) || typeof v.message !== 'string' || typeof v.severity !== 'string') return undefined;
  return v;
}
function ccMinBuild() {
  const v = C.clientConfig ? C.clientConfig.min_build : undefined;
  if (!v || typeof v !== 'object') return undefined;
  if (!Number.isInteger(v.nag) || !Number.isInteger(v.blocking) || typeof v.update_url !== 'string') return undefined;
  return v;
}
function ccWhatsNew() {
  const v = C.clientConfig ? C.clientConfig.whats_new : undefined;
  if (!v || typeof v !== 'object') return undefined;
  if (!Number.isInteger(v.build) || !Array.isArray(v.items)) return undefined;
  return v;
}

function settingsApp() {
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'App' }),
      tip('What users see inside the app: an announcement banner, forced/suggested update gates, and the “What’s new” popup. The app refreshes these on every launch and foreground.')));
  if (C.clientConfigErr) card.append(el('p', { class: 'msg msg-err', text: C.clientConfigErr }));
  if (!C.clientConfig) { card.append(skeletonRows(4, 20)); return card; }

  // ---- broadcast composer ----
  const bc = ccBroadcast();
  const bcWrap = el('div', { class: 'setting-row' });
  const bcMain = el('div', { class: 'setting-main' },
    el('span', { class: 'strong' }, 'Broadcast banner ', tip('A banner shown at the top of the app for every user — for announcements or incident notices. Users can dismiss it; publishing again re-shows it to everyone, including those who dismissed the previous one.')));
  if (!bc) {
    bcMain.append(el('span', { class: 'msg msg-err', text: 'Unknown — the backend value for “broadcast” is missing or malformed. Composer disabled.' }));
  } else {
    const statusLine = el('span', { class: 'field-hint', text: bc.active
      ? 'LIVE now (id ' + bc.id + ', ' + bc.severity + '): “' + truncate(bc.message, 80) + '”'
      : 'No banner is live. Last id: ' + bc.id + '.' });
    const msgInput = el('textarea', { rows: '2', style: 'width:100%', placeholder: 'Announcement text — one or two short sentences.' });
    msgInput.value = bc.message || '';
    const sevSel = el('select', {},
      el('option', { value: 'info', text: 'info — blue, general announcement' }),
      el('option', { value: 'warning', text: 'warning — amber, heads-up' }),
      el('option', { value: 'critical', text: 'critical — red, incident' }));
    sevSel.value = ['info', 'warning', 'critical'].includes(bc.severity) ? bc.severity : 'info';
    const preview = el('div', { class: 'bc-preview bc-info' });
    const syncPreview = () => {
      preview.className = 'bc-preview bc-' + sevSel.value;
      preview.textContent = '';
      preview.append(
        el('span', { text: sevSel.value === 'critical' ? '⛔' : sevSel.value === 'warning' ? '⚠' : 'ℹ' }),
        el('span', { text: msgInput.value.trim() || '(banner text)' }),
        el('span', { style: 'margin-left:auto;opacity:.6', text: '✕' }));
    };
    syncPreview();
    msgInput.addEventListener('input', syncPreview);
    sevSel.addEventListener('change', syncPreview);
    const bcMsg = el('p', { class: 'msg' });
    const publishBtn = el('button', { class: 'btn btn-primary btn-small' }, 'Publish banner');
    const offBtn = el('button', { class: 'btn btn-small', disabled: !bc.active }, 'Take down');
    publishBtn.addEventListener('click', () => {
      const text = msgInput.value.trim();
      if (!text) { setMsg(bcMsg, 'err', 'Write the banner text first.'); return; }
      confirmModal({
        title: 'Publish this banner to every user?',
        confirmLabel: 'Publish',
        body: 'It appears at the top of the app for everyone on their next launch or foreground. Publishing bumps the banner id (' + bc.id + ' → ' + (bc.id + 1) + '), so even users who dismissed a previous banner see this one.',
        onConfirm: async () => {
          await adminApi('set_client_config', {
            key: 'broadcast',
            value: { active: true, id: bc.id + 1, message: text, severity: sevSel.value },
          });
          toast('ok', 'Banner published.');
          loadClientConfig(true);
        },
      });
    });
    offBtn.addEventListener('click', () => {
      confirmModal({
        title: 'Take the banner down?',
        confirmLabel: 'Take down',
        body: 'The banner disappears from the app on each user’s next launch or foreground. The message is kept in the composer.',
        onConfirm: async () => {
          await adminApi('set_client_config', {
            key: 'broadcast',
            value: { active: false, id: bc.id, message: msgInput.value.trim(), severity: sevSel.value },
          });
          toast('ok', 'Banner taken down.');
          loadClientConfig(true);
        },
      });
    });
    bcMain.append(statusLine, msgInput, el('div', { class: 'row' }, sevSel, publishBtn, offBtn),
      el('span', { class: 'field-hint', text: 'Live preview (roughly how the app renders it):' }), preview, bcMsg);
  }
  bcWrap.append(bcMain);
  card.append(bcWrap);

  // ---- version gates ----
  const mb = ccMinBuild();
  const mbWrap = el('div', { class: 'setting-row' });
  const mbMain = el('div', { class: 'setting-main' },
    el('span', { class: 'strong' }, 'Version gates ', tip('Compare against the app’s native build number. Below “nag”: a dismissible “update available” banner. Below “blocking”: a full-screen “Update required” wall — the app is unusable until updated. 0 disables a gate.')));
  if (!mb) {
    mbMain.append(el('span', { class: 'msg msg-err', text: 'Unknown — the backend value for “min_build” is missing or malformed. Controls disabled.' }));
  } else {
    const nagIn = el('input', { type: 'number', min: '0', step: '1', class: 'input-small', value: String(mb.nag) });
    const blockIn = el('input', { type: 'number', min: '0', step: '1', class: 'input-small', value: String(mb.blocking) });
    const urlIn = el('input', { type: 'url', style: 'width:100%', placeholder: 'https://testflight.apple.com/join/…', value: mb.update_url || '' });
    const mbMsg = el('p', { class: 'msg' });
    const mbSave = el('button', { class: 'btn btn-primary btn-small' }, 'Save gates');
    mbSave.addEventListener('click', () => {
      const nag = Number(nagIn.value); const blocking = Number(blockIn.value);
      if (!Number.isInteger(nag) || nag < 0 || !Number.isInteger(blocking) || blocking < 0) {
        setMsg(mbMsg, 'err', 'Both gates must be non-negative whole build numbers.');
        return;
      }
      confirmModal({
        title: 'Save version gates?',
        confirmLabel: 'Save gates',
        body: blocking > 0
          ? 'Every install with a build number below ' + blocking + ' becomes UNUSABLE until updated (full-screen wall). Builds below ' + nag + ' see a dismissible update banner. Double-check the numbers against TestFlight before saving.'
          : 'Builds below ' + nag + ' see a dismissible update banner. No blocking wall is set.',
        onConfirm: async () => {
          await adminApi('set_client_config', { key: 'min_build', value: { nag, blocking, update_url: urlIn.value.trim() } });
          toast('ok', 'Version gates saved.');
          loadClientConfig(true);
        },
      });
    });
    mbMain.append(
      el('span', { class: 'field-hint', text: 'The current build number is in App Store Connect → TestFlight → the newest build’s “Build” column. The app fails open: a dev build with no build number is never gated.' }),
      el('div', { class: 'row' },
        el('span', { class: 'small', text: 'Nag below' }), nagIn,
        el('span', { class: 'small', text: 'Block below' }), blockIn,
        mbSave),
      el('label', { class: 'field' }, 'Update URL (the TestFlight link the Update button opens)', urlIn),
      mbMsg);
  }
  mbWrap.append(mbMain);
  card.append(mbWrap);

  // ---- what's-new composer ----
  const wn = ccWhatsNew();
  const wnWrap = el('div', { class: 'setting-row' });
  const wnMain = el('div', { class: 'setting-main' },
    el('span', { class: 'strong' }, 'What’s new ', tip('A one-time “What’s new” popup shown to users running EXACTLY this build number — write it when you ship a build. Each user sees it once.')));
  if (!wn) {
    wnMain.append(el('span', { class: 'msg msg-err', text: 'Unknown — the backend value for “whats_new” is missing or malformed. Composer disabled.' }));
  } else {
    const buildIn = el('input', { type: 'number', min: '0', step: '1', class: 'input-small', value: String(wn.build) });
    const itemsIn = el('textarea', { rows: '4', style: 'width:100%', placeholder: 'One bullet per line' });
    itemsIn.value = (wn.items || []).join('\n');
    const wnMsg = el('p', { class: 'msg' });
    const wnSave = el('button', { class: 'btn btn-primary btn-small' }, 'Save what’s-new');
    wnSave.addEventListener('click', async () => {
      const build = Number(buildIn.value);
      if (!Number.isInteger(build) || build < 0) { setMsg(wnMsg, 'err', 'Build must be a non-negative whole number.'); return; }
      const items = itemsIn.value.split('\n').map((s) => s.trim()).filter(Boolean);
      wnSave.disabled = true;
      setMsg(wnMsg, 'info', 'Saving…');
      try {
        await adminApi('set_client_config', { key: 'whats_new', value: { build, items } });
        setMsg(wnMsg, 'ok', 'Saved — users on build ' + build + ' see ' + items.length + ' bullet(s), once each.');
        loadClientConfig(true);
      } catch (e) {
        if (!e.handled) setMsg(wnMsg, 'err', e.message);
      }
      wnSave.disabled = false;
    });
    wnMain.append(
      el('div', { class: 'row' }, el('span', { class: 'small', text: 'For build' }), buildIn, wnSave),
      itemsIn, wnMsg);
  }
  wnWrap.append(wnMain);
  card.append(wnWrap);
  return card;
}

function settingsAdmins() {
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('h2', { text: 'Admins' }),
      tip('Who can sign in to this panel. Admin accounts can read and edit EVERY user’s data, delete accounts, and change every setting on this page.')));
  if (C.adminsErr) card.append(el('p', { class: 'msg msg-err', text: C.adminsErr }));
  if (C.admins === null) { card.append(skeletonRows(3, 20)); return card; }

  card.append(buildTable(
    [{ label: 'Email' }, { label: 'Added' }, { label: 'Note' }, { label: '' }],
    (C.admins || []).map((aRow) => {
      const isSelf = aRow.user_id === state.sessionUserId;
      const removeBtn = el('button', {
        class: 'btn btn-danger-outline btn-small',
        disabled: isSelf,
        title: isSelf ? 'You cannot remove your own admin access — another admin must do it.' : null,
      }, 'Remove…');
      removeBtn.addEventListener('click', () => {
        confirmModal({
          title: 'Remove admin access for ' + (aRow.email || aRow.user_id) + '?',
          danger: true,
          confirmLabel: 'Remove admin',
          body: 'They immediately lose access to this panel and every privileged action. Their normal app account is untouched.',
          onConfirm: async () => {
            await adminApi('remove_admin', { user_id: aRow.user_id });
            toast('ok', 'Admin removed.');
            loadAdmins(true);
            if (C.users) loadUsers(true);
          },
        });
      });
      return {
        cells: [
          el('span', {}, aRow.email || el('span', { class: 'mono-sm', text: aRow.user_id }), isSelf ? el('span', { class: 'badge badge-accent', text: 'you' }) : null),
          relTimeEl(aRow.created_at),
          aRow.note || '—',
          removeBtn,
        ],
      };
    })));

  const emailIn = el('input', { type: 'email', placeholder: 'user@example.com', style: 'min-width:220px' });
  const addBtn = el('button', { class: 'btn btn-primary btn-small' }, 'Add admin…');
  const addMsg = el('p', { class: 'msg' });
  addBtn.addEventListener('click', () => {
    const email = emailIn.value.trim();
    if (!email) { setMsg(addMsg, 'err', 'Enter the email of an existing app account.'); return; }
    confirmModal({
      title: 'Grant admin access to ' + email + '?',
      danger: true,
      confirmLabel: 'Grant admin access',
      body: 'Admin access is TOTAL: this person will be able to read and edit every user’s deals and personal data, delete accounts permanently, disable scanning app-wide, and add or remove other admins. Only grant it to someone you trust with everything.',
      onConfirm: async () => {
        try {
          await adminApi('add_admin', { email });
          toast('ok', email + ' is now an admin.');
          emailIn.value = '';
          loadAdmins(true);
          if (C.users) loadUsers(true);
        } catch (e) {
          const msgs = {
            user_not_found: 'No app account exists with that email — they must sign up in the app first.',
            already_admin: 'That user is already an admin.',
          };
          throw new Error(msgs[e.code] || e.message);
        }
      },
    });
  });
  card.append(el('div', { class: 'row', style: 'margin-top:14px' }, emailIn, addBtn), addMsg);
  return card;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.DT.init();
})();
