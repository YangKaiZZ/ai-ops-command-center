// AI Ops dashboard: reads the seller's orders, low stock, and agent decisions
// from the backend API. All data (including LLM output and customer names)
// goes into the page via textContent, never innerHTML.

const SESSION_KEY = 'aiops.session';
const REFRESH_MS = 30000;

const ACTIONS = {
  fulfill: { label: 'Fulfill', tone: 'good', icon: 'check' },
  hold: { label: 'Hold', tone: 'warning', icon: 'pause' },
  low_stock_alert: { label: 'Restock', tone: 'serious', icon: 'alert' },
  unknown: { label: 'Unclear', tone: 'neutral', icon: 'help' },
};

// Static icon markup (no data in here).
const ICONS = {
  check: '<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  pause: '<rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor"/>',
  alert: '<path d="M8 2.2L1.8 13h12.4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6.5v3M8 11.3v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  empty: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 12L12 4" stroke="currentColor" stroke-width="2"/>',
  help: '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.2 6.2a1.9 1.9 0 113 1.5c-.7.4-1.2.8-1.2 1.6M8 11.5v.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};

const $ = (id) => document.getElementById(id);
let session = loadSession();
let refreshTimer = null;

// ---------- Session (browser storage can be unavailable; never rely on it) ----------

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}
function saveSession(value) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  } catch {
    /* session just won't survive a reload */
  }
}
function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing stored */
  }
}

// ---------- DOM helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) node.append(child); // strings become text nodes
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

function badge(label, tone, iconName) {
  return el('span', { class: `badge tone-${tone}` }, icon(iconName), label);
}

function timeAgo(date) {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const moneyFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function showBanner(text, isError = false) {
  const banner = $('banner');
  banner.textContent = text;
  banner.classList.toggle('is-error', isError);
  banner.hidden = !text;
}

// ---------- API ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${session.token}` },
  });
  if (res.status === 401) {
    logout('Your session expired. Sign in again.');
    throw new Error('Session expired');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ---------- Rendering ----------

// The agent's reply: line 1 is "VERDICT - headline", then bullets.
function renderReasoning(reasoning) {
  const lines = (reasoning || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const summary = (lines.shift() || '').replace(/^\**(FULFILL|HOLD|RESTOCK)\**\s*[-–—:]*\s*/, '');
  const body = el('div', { class: 'decision-body' });
  let list = null;
  for (const line of lines) {
    const bullet = line.match(/^[-*•]\s*(.*)$/);
    if (bullet) {
      if (!list) body.append((list = el('ul')));
      list.append(el('li', {}, bullet[1]));
    } else {
      list = null;
      body.append(el('p', {}, line));
    }
  }
  return [summary ? el('p', { class: 'decision-summary' }, summary) : null, body];
}

function renderDecisions(decisions) {
  const list = $('decisions');
  list.replaceChildren();
  if (!decisions.length) {
    list.append(
      el('li', { class: 'empty' }, 'No decisions yet. The agent adds one here whenever an order comes in or stock runs low.')
    );
    return;
  }
  for (const d of decisions) {
    const action = ACTIONS[d.action_taken] || ACTIONS.unknown;
    const created = new Date(d.created_at);
    list.append(
      el(
        'li',
        { class: 'decision' },
        el(
          'div',
          { class: 'decision-head' },
          badge(action.label, action.tone, action.icon),
          el('span', { class: 'decision-subject' }, d.order_number ? `Order ${d.order_number}` : 'Low-stock alert'),
          el('time', { class: 'note decision-time', datetime: created.toISOString(), title: created.toLocaleString() }, timeAgo(created))
        ),
        renderReasoning(d.reasoning)
      )
    );
  }
}

function renderLowStock(items) {
  const list = $('low-stock');
  list.replaceChildren();
  if (!items.length) {
    list.append(el('li', { class: 'empty' }, 'Everything is above its threshold.'));
    return;
  }
  for (const item of items) {
    const out = item.stock_quantity <= 0;
    const tone = out ? 'critical' : 'warning';
    const pct = Math.min(100, Math.max(0, (item.stock_quantity / Math.max(item.low_stock_threshold, 1)) * 100));
    list.append(
      el(
        'li',
        { class: 'stock-item' },
        el(
          'div',
          { class: 'stock-row' },
          el('span', { class: 'stock-name' }, item.item_name),
          el('span', { class: 'stock-count' }, `${item.stock_quantity} of ${item.low_stock_threshold}`)
        ),
        el(
          'div',
          {
            class: `meter tone-${tone}`,
            role: 'meter',
            'aria-label': `${item.item_name} stock`,
            'aria-valuemin': '0',
            'aria-valuemax': String(item.low_stock_threshold),
            'aria-valuenow': String(item.stock_quantity),
          },
          el('div', { class: 'meter-fill', style: `width:${pct}%` })
        ),
        el('div', {}, out ? badge('Out of stock', 'critical', 'empty') : badge('Low', 'warning', 'alert'))
      )
    );
  }
}

function renderOrders(orders, latestByOrder) {
  const body = $('orders-body');
  body.replaceChildren();
  if (!orders.length) {
    body.append(el('tr', {}, el('td', { colspan: '7', class: 'empty' }, 'No orders synced yet. Use "Sync from Shopify".')));
    return;
  }
  for (const o of orders) {
    const decision = latestByOrder.get(o.id);
    const action = decision && (ACTIONS[decision.action_taken] || ACTIONS.unknown);
    const placed = o.order_placed_at ? new Date(o.order_placed_at) : null;
    body.append(
      el(
        'tr',
        {},
        el('td', {}, el('strong', {}, o.order_number || '—')),
        el('td', {}, o.buyer_name || 'Guest'),
        el('td', { class: 'num' }, o.total_amount != null ? moneyFormat.format(Number(o.total_amount)) : '—'),
        el('td', {}, el('span', { class: 'chip' }, o.status || '—')),
        el('td', {}, el('span', { class: 'chip' }, o.financial_status || '—')),
        el('td', { title: placed ? placed.toLocaleString() : null }, placed ? placed.toLocaleDateString() : '—'),
        el('td', {}, action ? badge(action.label, action.tone, action.icon) : el('span', { class: 'note' }, 'No decision'))
      )
    );
  }
}

async function loadDashboard() {
  try {
    const [{ orders }, { pending_orders: pending }, { low_stock_items: lowStock }, { decisions }] = await Promise.all([
      api('/api/orders'),
      api('/api/orders/pending'),
      api('/api/inventory/low-stock'),
      api('/api/decisions?limit=200'),
    ]);

    // Decisions arrive newest first, so the first one seen per order is its latest.
    const latestByOrder = new Map();
    for (const d of decisions) if (d.order_id != null && !latestByOrder.has(d.order_id)) latestByOrder.set(d.order_id, d);

    $('kpi-pending').textContent = pending.length;
    $('kpi-hold').textContent = pending.filter((o) => latestByOrder.get(o.id)?.action_taken === 'hold').length;
    $('kpi-low').textContent = lowStock.length;

    renderDecisions(decisions.slice(0, 50));
    renderLowStock(lowStock);
    renderOrders(orders, latestByOrder);
    $('updated-at').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    if ($('banner').classList.contains('is-error')) showBanner('');
  } catch (err) {
    if (session) showBanner(`Couldn't load the dashboard: ${err.message}`, true);
  }
}

// ---------- Views & actions ----------

function showApp() {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('store-name').textContent = session.business_name || '';
  loadDashboard();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(loadDashboard, REFRESH_MS);
}

function logout(message = '') {
  clearInterval(refreshTimer);
  clearSession();
  session = null;
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  const error = $('login-error');
  error.textContent = message;
  error.hidden = !message;
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const error = $('login-error');
  error.hidden = true;
  button.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: form.email.value.trim(), password: form.password.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Sign-in failed');
    session = { token: body.token, business_name: body.business_name };
    saveSession(session);
    form.reset();
    showApp();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

$('logout-btn').addEventListener('click', () => logout());

$('sync-btn').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Syncing…';
  try {
    const [orders, inventory] = await Promise.all([
      api('/api/orders/sync', { method: 'POST' }),
      api('/api/inventory/sync', { method: 'POST' }),
    ]);
    showBanner(`${orders.message}. ${inventory.message}.`);
    await loadDashboard();
  } catch (err) {
    if (session) showBanner(`Sync failed: ${err.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Sync from Shopify';
  }
});

if (session?.token) showApp();
else logout();
