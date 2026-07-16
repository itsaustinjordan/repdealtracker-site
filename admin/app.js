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
  tab: 'users',          // users | stats | settings
  signinMsg: '',
  config: null,          // { scanning_enabled, default_daily_scan_cap }
  configError: '',
  users: null,           // null = loading, [] = loaded
  usersError: '',
  detail: null,          // { row, data, error, deleted }
  stats: null,           // null = loading, [] = loaded (zero-filled 30 days)
  statsError: '',
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
  state.detail = null;
  state.stats = null;
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

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString();
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
    events: d.scan_events || d.events || [],
    settings: d.user_settings || d.settings || null,
    cap: d.cap || d.scan_cap || d.cap_row || null,
  };
}

function openDetail(row) {
  state.detail = { row, data: null, error: '', deleted: null };
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
    [['users', 'Users'], ['stats', 'Stats'], ['settings', 'Settings']].map(([id, label]) =>
      el('button', {
        class: 'tab' + (state.tab === id ? ' active' : ''),
        onclick: () => switchTab(id),
      }, label)));
  const content = el('div', { class: 'tab-content' });
  if (state.tab === 'users') content.append(state.detail ? viewUserDetail() : viewUsers());
  else if (state.tab === 'stats') content.append(viewStats());
  else content.append(viewSettings());
  return el('div', {}, tabs, content);
}

function switchTab(id) {
  state.tab = id;
  if (id === 'users') state.detail = null; // Users tab click also acts as "back to list"
  render();
  if (id === 'users' && state.users === null) loadUsers();
  if (id === 'stats' && state.stats === null) loadStats();
  if (id === 'settings') refreshConfig();
}

// ---------------------------------------------------------------------------
// Users tab
// ---------------------------------------------------------------------------
function badges(u) {
  const out = [];
  if (u.is_admin) out.push(el('span', { class: 'badge badge-admin', text: 'ADMIN' }));
  if (u.banned) out.push(el('span', { class: 'badge badge-banned', text: 'BANNED' }));
  return out;
}

function capOf(u) {
  const defCap = state.config ? state.config.default_daily_scan_cap : null;
  const cap = u.daily_cap != null ? u.daily_cap : defCap;
  return cap != null ? String(cap) : '—';
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
  const tbl = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', { text: 'Email' }),
      el('th', { text: 'Joined' }),
      el('th', { text: 'Last active' }),
      el('th', { class: 'num', text: 'Deals' }),
      el('th', { class: 'num', text: 'Volume' }),
      el('th', { class: 'num', text: 'Scans 30d' }),
      el('th', { class: 'num', text: 'Scans 24h' }))),
    el('tbody', {}, state.users.map((u) =>
      el('tr', { class: 'clickable', onclick: () => openDetail(u) },
        el('td', {}, u.email || '—', badges(u)),
        el('td', { text: fmtDate(u.created_at) }),
        el('td', { text: fmtDateTime(lastActive(u)) }),
        el('td', { class: 'num', text: intFmt(u.deal_count) }),
        el('td', { class: 'num', text: money(u.volume_sum) }),
        el('td', { class: 'num', text: intFmt(u.scans_30d) }),
        el('td', { class: 'num', text: intFmt(u.scans_24h == null ? 0 : u.scans_24h) + ' / ' + capOf(u) })))));
  wrap.append(el('div', { class: 'table-wrap' }, tbl));
  return wrap;
}

// ---------------------------------------------------------------------------
// User detail
// ---------------------------------------------------------------------------
function viewUserDetail() {
  const d = state.detail;
  const row = d.row;
  const isAdmin = !!row.is_admin;
  const adminTip = 'Admin accounts cannot be banned or deleted';

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
  const refreshBadges = () => { badgeSlot.textContent = ''; badges(row).forEach((b) => badgeSlot.append(b)); };

  if (d.error) root.append(el('p', { class: 'msg msg-err', text: 'Could not load details: ' + d.error }));

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

  // -- scan cap editor --
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

  async function applyCap(value) {
    capSave.disabled = capClear.disabled = true;
    setMsg(capMsg, 'info', 'Saving…');
    try {
      const params = { user_id: row.user_id, daily_cap: value };
      const noteVal = capNote.value.trim();
      if (noteVal) params.note = noteVal;
      await adminApi('set_scan_cap', params);
      row.daily_cap = value;
      currentCap = value;
      currentLabel.textContent = value != null ? String(value) : defLabel;
      capInput.value = value != null ? String(value) : '';
      setMsg(capMsg, 'ok', value != null ? 'Cap saved.' : 'Override cleared — using the default cap.');
    } catch (e) {
      if (!e.handled) setMsg(capMsg, 'err', e.message);
    }
    capSave.disabled = capClear.disabled = false;
  }

  capSave.addEventListener('click', () => {
    const raw = capInput.value.trim();
    if (raw === '') { setMsg(capMsg, 'err', 'Enter a cap, or use “Clear to default”.'); return; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) { setMsg(capMsg, 'err', 'The cap must be a non-negative whole number.'); return; }
    applyCap(n);
  });
  capClear.addEventListener('click', () => applyCap(null));

  root.append(el('p', { class: 'hint' }, 'Current: ', currentLabel));
  root.append(el('div', { class: 'cap-row' }, capInput, capNote, capSave, capClear));
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
        d.deleted = (resp && resp.deleted) || {};
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

function statusClass(s) {
  if (s === 'success') return 'st st-success';
  if (s === 'parse_fail' || s === 'api_fail') return 'st st-fail';
  if (typeof s === 'string' && s.indexOf('blocked') === 0) return 'st st-blocked';
  return 'st st-other';
}

// ---------------------------------------------------------------------------
// Stats tab
// ---------------------------------------------------------------------------
function viewStats() {
  const wrap = el('div', {},
    el('div', { class: 'section-head' },
      el('h2', { text: 'Scan stats — last 30 days' }),
      el('button', { class: 'btn btn-small', onclick: () => loadStats() }, 'Refresh')),
    el('p', { class: 'hint', text: 'Days in UTC.' }));
  if (state.statsError) wrap.append(el('p', { class: 'msg msg-err', text: state.statsError }));
  if (state.stats === null) {
    wrap.append(el('p', { class: 'msg-info', text: 'Loading stats…' }));
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
init();
})();
