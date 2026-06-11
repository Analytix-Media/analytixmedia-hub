/* ═══════════════════════════════════════════
   ANALYTIX HUB — app.js

   Auth is SERVER-SIDE. The password hash is NOT in this file — it lives in the
   Netlify env var HUB_PASSWORD_HASH. Login POSTs the password to the hub-auth
   function, which verifies it and returns a signed, expiring token. The hub-data
   function rejects any request without a valid token. This keeps the hash off
   the public web and gates all Neon reads/writes.

   To rotate the password: set HUB_PASSWORD_HASH (and HUB_TOKEN_SECRET) in the
   Netlify site env. Generate a hash in the browser console with:
     crypto.subtle.digest('SHA-256', new TextEncoder().encode('yourpassword'))
       .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
═══════════════════════════════════════════ */

const CONFIG = {
  SESSION_DAYS: 30,
  AUTH_API:               '/.netlify/functions/hub-auth',
  STORAGE_KEY_AUTH:        'hub_auth',
  STORAGE_KEY_TOKEN:       'hub_token', // signed token from hub-auth, gates Neon calls
  STORAGE_KEY_APPS:        'hub_apps',
  STORAGE_KEY_NOTES:       'hub_notes',
  STORAGE_KEY_QUICKLINKS:  'hub_quicklinks',
  STORAGE_KEY_DATA_VER:    'hub_data_version', // publishedAt of last loaded data.json
};

// ─── Stage definitions ───────────────────────────────────────────────────────
const DEFAULT_STAGES = {
  idea:      { label: 'Idea',             bg: '#F8FAFC', fg: '#64748B' },
  scoping:   { label: 'Scoping',          bg: '#EFF6FF', fg: '#1E40AF' },
  concept:   { label: 'Concept',          bg: '#F3F4F6', fg: '#6B7280' },
  designing: { label: 'Designing',        bg: '#EDE9FE', fg: '#6D28D9' },
  building:  { label: 'Building',         bg: '#FEF3C7', fg: '#92400E' },
  review:    { label: 'Review',           bg: '#EEF2FF', fg: '#4338CA' },
  testing:   { label: 'Testing',          bg: '#FFF7ED', fg: '#C2410C' },
  beta:      { label: 'Beta',             bg: '#CFFAFE', fg: '#0E7490' },
  ready:     { label: 'Ready to Launch',  bg: '#F0FDF4', fg: '#166534' },
  paused:    { label: 'Paused',           bg: '#FEF9C3', fg: '#854D0E' },
  blocked:   { label: 'Blocked',          bg: '#FEF2F2', fg: '#B91C1C' },
};
let STAGES = JSON.parse(JSON.stringify(DEFAULT_STAGES));

function stageBadgeHtml(stage) {
  if (!stage || !STAGES[stage]) return '';
  const s = STAGES[stage];
  return `<span class="stage-badge" style="background:${s.bg};color:${s.fg}">${s.label}</span>`;
}

// ─── Categories ──────────────────────────────────────────────────────────────
// Categories live inside each app's `category` field — no separate list to manage.
// Type a new name in the tool modal to create one; it appears in the filter
// dropdown and the datalist automatically. No Neon schema change needed.

// Derive a stable pastel color from the category name (no manual color picking)
function categoryColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return { bg: `hsl(${h} 68% 94%)`, fg: `hsl(${h} 55% 34%)` };
}

function categoryBadgeHtml(cat) {
  if (!cat || !cat.trim()) return '';
  const c = categoryColor(cat.trim());
  return `<span class="cat-badge" style="background:${c.bg};color:${c.fg}">${escHtml(cat.trim())}</span>`;
}

// Distinct categories used by apps in one section (for the filter dropdown)
function allCategories(section) {
  const set = new Set();
  state.apps.forEach(a => {
    if (a.section === section && a.category && a.category.trim()) set.add(a.category.trim());
  });
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Distinct categories across every section (for the modal datalist)
function allCategoriesGlobal() {
  const set = new Set();
  state.apps.forEach(a => { if (a.category && a.category.trim()) set.add(a.category.trim()); });
  return [...set].sort((a, b) => a.localeCompare(b));
}

function populateCategoryFilter() {
  const sel = document.getElementById('category-filter');
  if (!sel) return;
  const cats = allCategories(state.section);
  let cur = state.categoryFilter || '';
  if (cur && !cats.includes(cur)) { state.categoryFilter = null; cur = ''; } // filtered category no longer exists
  sel.innerHTML = `<option value="">All categories</option>` +
    cats.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
  sel.value = cur;
  sel.style.display = cats.length ? '' : 'none';
}

function populateCategoryDatalist() {
  const dl = document.getElementById('category-options');
  if (!dl) return;
  dl.innerHTML = allCategoriesGlobal().map(c => `<option value="${escHtml(c)}">`).join('');
}

function setCategoryFilter(cat) {
  state.categoryFilter = cat || null;
  renderApps();
}

// ─── Default seed data ───────────────────────────────────────────────────────
const SEED_APPS = [
  // Live
  { id: 'intake-hub',        name: 'Intake Hub',           desc: 'Client intake workspace — plans, research, tasks.',          icon: '📋', url: '#', section: 'live',    access: 'protected', stage: '', category: 'Client Ops', notes: '', favicon: null },
  { id: 'client-dashboard',  name: 'Client Dashboard',     desc: 'Campaign performance reports for clients.',                  icon: '📊', url: '#', section: 'live',    access: 'protected', stage: '', category: 'Reporting', notes: '', favicon: null },
  { id: 'email-builder',     name: 'Email Builder',        desc: 'Drag-drop email template generator.',                        icon: '✉️',  url: '#', section: 'live',    access: 'public',    stage: '', category: 'Marketing', notes: '', favicon: null },
  { id: 'brand-kit',         name: 'Brand Kit',            desc: 'Logos, colors, tokens — single source of truth.',            icon: '🎨', url: '#', section: 'live',    access: 'protected', stage: '', category: 'Marketing', notes: '', favicon: null },
  { id: 'seo-auditor',       name: 'SEO Auditor',          desc: 'Quick site audits with exportable reports.',                 icon: '🔍', url: '#', section: 'live',    access: 'protected', stage: '', category: 'SEO', notes: '', favicon: null },
  // Beta
  { id: 'ai-reports',        name: 'AI Report Generator',  desc: 'Auto-pull GA4 data → monthly client report drafts via Claude.', icon: '🤖', url: '#', section: 'beta', access: 'protected', stage: 'building',  notes: '<ul><li>Connect GA4 API for traffic + conversion pulls</li><li>Template per client type (ecom / lead-gen / local)</li><li>Export to branded PDF</li></ul>', favicon: null },
  { id: 'client-portal-v2',  name: 'Client Portal v2',     desc: 'White-label client portal with SSO and custom domain.',      icon: '🏠', url: '#', section: 'beta',    access: 'protected', stage: 'designing', notes: '<ul><li>White-label subdomain support</li><li>Google SSO for client login</li><li>Embed existing dashboard + reports</li></ul>', favicon: null },
  { id: 'proposal-builder',  name: 'Proposal Builder',     desc: 'AI-assisted proposal generator from a discovery call brief.', icon: '📝', url: '#', section: 'beta',   access: 'protected', stage: 'concept',   notes: '<p>Paste discovery notes → AI drafts scope, pricing, timeline. Export to branded PDF or Notion.</p>', favicon: null },
  { id: 'competitor-tracker',name: 'Competitor Tracker',   desc: 'Weekly automated competitor analysis — SEO, ads, content.',  icon: '📈', url: '#', section: 'beta',    access: 'protected', stage: 'testing',   notes: '', favicon: null },
  { id: 'link-monitor',      name: 'Link Monitor',         desc: 'Broken link + redirect checker with weekly email digest.',   icon: '🔗', url: '#', section: 'beta',    access: 'protected', stage: 'beta',      notes: '', favicon: null },
  // Archive
  { id: 'legacy-email',      name: 'Legacy Email Tool',    desc: 'Old email builder — replaced by Email Builder.',             icon: '📧', url: '#', section: 'archive', access: 'protected', stage: '', notes: '', favicon: null },
  { id: 'manual-analytics',  name: 'Manual Analytics Sheet', desc: 'Google Sheet reporting — replaced by Client Dashboard.',  icon: '📉', url: '#', section: 'archive', access: 'protected', stage: '', notes: '', favicon: null },
];

const SEED_NOTES = [
  { id: 'note-1', title: 'AI report generator idea',   body: 'Auto-pull GA4 data and generate monthly client report draft with Claude.\n\n- Connect GA4 API for traffic + conversions\n- Template per client type (ecom / lead-gen / local)\n- Export to branded PDF', created: Date.now() - 864e5 * 1, updated: Date.now() - 864e5 * 0.5 },
  { id: 'note-2', title: 'Client portal v2 features',  body: 'White-label option for agencies reselling our services.\n\n- Custom subdomain\n- Google SSO\n- Embedded dashboard', created: Date.now() - 864e5 * 3, updated: Date.now() - 864e5 * 1 },
  { id: 'note-3', title: 'Pricing page experiments',   body: 'Three-tier vs usage-based pricing.\n\nTest with Hotjar heatmaps. Run for 30 days then decide.', created: Date.now() - 864e5 * 8, updated: Date.now() - 864e5 * 3 },
  { id: 'note-4', title: 'Automation wishlist',        body: 'Make.com scenarios we want to build:\n\n- New client → create ClickUp project + Notion brief\n- Weekly SEO digest → Slack\n- Invoice paid → update client status', created: Date.now() - 864e5 * 14, updated: Date.now() - 864e5 * 5 },
  { id: 'note-5', title: 'SEO content brief tool',     body: 'Input: target keyword + competitor URLs\nOutput: content brief with headings, word count, internal link suggestions\n\nCould use Claude + Serper API.', created: Date.now() - 864e5 * 20, updated: Date.now() - 864e5 * 7 },
];

const SEED_QUICKLINKS = [
  { id: 'ql-1', label: '🌐 analytixmedia.com', url: 'https://analytixmedia.com' },
  { id: 'ql-2', label: '📁 Google Drive',       url: 'https://drive.google.com' },
  { id: 'ql-3', label: '📋 ClickUp',            url: 'https://app.clickup.com' },
];

// ─── State ───────────────────────────────────────────────────────────────────
let state = {
  section: 'live',
  apps: [],
  notes: [],
  quickLinks: [],
  savedViews: [],
  activeNoteId: null,
  editingAppId: null,
  editingQuickLinkId: null,
  searchQuery: '',
  expandedRows: new Set(),
  betaStageFilter: null,
  categoryFilter: null,
  sortOrder: 'manual',
  arrangeMode: false,
};

// ═══════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════

function isAuthenticated() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY_AUTH);
    if (!raw) return false;
    const { expiry } = JSON.parse(raw);
    return Date.now() < expiry;
  } catch { return false; }
}

function saveSession() {
  const expiry = Date.now() + CONFIG.SESSION_DAYS * 864e5;
  localStorage.setItem(CONFIG.STORAGE_KEY_AUTH, JSON.stringify({ expiry }));
}

function clearSession() {
  localStorage.removeItem(CONFIG.STORAGE_KEY_AUTH);
}

// ─── Neon API token (issued by hub-auth) ─────────────────────────────────────
function getHubToken() {
  try {
    const { token, expiry } = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY_TOKEN) || 'null') || {};
    if (!token || Date.now() >= expiry) return null;
    return token;
  } catch { return null; }
}

function setHubToken(token, expiry) {
  localStorage.setItem(CONFIG.STORAGE_KEY_TOKEN, JSON.stringify({ token, expiry }));
}

function clearHubToken() {
  localStorage.removeItem(CONFIG.STORAGE_KEY_TOKEN);
}

function authHeaders() {
  const t = getHubToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// Server rejected our token (expired / invalid) — drop session and re-prompt.
function handleAuthExpired() {
  clearSession();
  clearHubToken();
  if (!document.getElementById('app').classList.contains('hidden')) showLogin();
}

function isLocalHost() {
  return ['localhost', '127.0.0.1', ''].includes(location.hostname);
}

// ═══════════════════════════════════════════
// DATA — localStorage
// ═══════════════════════════════════════════

function loadApps() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY_APPS);
    state.apps = raw ? JSON.parse(raw) : [...SEED_APPS];
  } catch { state.apps = [...SEED_APPS]; }
}

// ─── Neon sync ───────────────────────────────────────────────────────────────
// All state syncs through /.netlify/functions/hub-data (runs on Netlify only).
// During local dev (npx serve), the endpoint isn't available — app falls back
// to localStorage silently. Everything still works offline / locally.

const NEON_API = '/.netlify/functions/hub-data';
let _neonSyncTimer = null;
let _neonSyncing = false;

function scheduleSyncToNeon() {
  clearTimeout(_neonSyncTimer);
  _neonSyncTimer = setTimeout(syncToNeon, 1500);
}

async function syncToNeon() {
  _neonSyncing = true;
  updateNeonStatus('syncing');
  try {
    const res = await fetch(NEON_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        apps:       state.apps,
        notes:      state.notes,
        quickLinks: state.quickLinks,
        stages:     STAGES,
        savedViews: state.savedViews,
      }),
    });
    if (res.ok)              updateNeonStatus('ok');
    else if (res.status === 401) { updateNeonStatus('error'); handleAuthExpired(); }
    else                    updateNeonStatus('error');
  } catch {
    updateNeonStatus('offline'); // local dev or offline — silent
  }
  _neonSyncing = false;
}

async function loadFromNeon() {
  try {
    const res = await fetch(NEON_API, { headers: authHeaders() });
    if (res.status === 401) { handleAuthExpired(); return; }
    if (!res.ok) return;
    const data = await res.json();
    if (!data || data.empty || data.error) return;

    let changed = false;
    if (Array.isArray(data.apps))       { state.apps = data.apps;             safeSetItem(CONFIG.STORAGE_KEY_APPS,       JSON.stringify(state.apps));       changed = true; }
    if (Array.isArray(data.notes))      { state.notes = data.notes;           safeSetItem(CONFIG.STORAGE_KEY_NOTES,      JSON.stringify(state.notes));      changed = true; }
    if (Array.isArray(data.quickLinks)) { state.quickLinks = data.quickLinks; safeSetItem(CONFIG.STORAGE_KEY_QUICKLINKS, JSON.stringify(state.quickLinks)); changed = true; }
    if (data.stages) {
      Object.keys(data.stages).forEach(k => { if (STAGES[k]) STAGES[k] = { ...STAGES[k], ...data.stages[k] }; });
      safeSetItem('hub_settings', JSON.stringify({ stages: STAGES }));
      changed = true;
    }
    if (Array.isArray(data.savedViews)) { state.savedViews = data.savedViews; safeSetItem('hub_views', JSON.stringify(state.savedViews)); changed = true; }

    if (changed) {
      updateBadges();
      renderApps();
      renderQuickLinks();
      renderViewsBar();
      updateSidebarStorageMeter();
      if (state.section === 'settings') renderSettings();
    }
  } catch { /* offline / local dev */ }
}

function updateNeonStatus(status) {
  const el = document.getElementById('neon-status');
  if (!el) return;
  const map = { ok: '● Synced', syncing: '↻ Syncing…', error: '⚠ Sync error', offline: '' };
  el.textContent = map[status] || '';
  el.className = `neon-status ${status}`;
}

// localStorage is capped (~5 MB). Base64 images in notes can hit it — fail loudly, not silently.
function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    alert('Storage is full — this change was NOT saved.\n\nFree up space by removing large images from notes, then try again. Export a backup from Settings first if needed.');
    return false;
  }
}

function saveApps() {
  safeSetItem(CONFIG.STORAGE_KEY_APPS, JSON.stringify(state.apps));
  updateSidebarStorageMeter();
  scheduleSyncToNeon();
}

function loadNotes() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY_NOTES);
    state.notes = raw ? JSON.parse(raw) : [...SEED_NOTES];
  } catch { state.notes = [...SEED_NOTES]; }
}

function saveNotes() {
  safeSetItem(CONFIG.STORAGE_KEY_NOTES, JSON.stringify(state.notes));
  updateSidebarStorageMeter();
  scheduleSyncToNeon();
}

function loadQuickLinks() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY_QUICKLINKS);
    state.quickLinks = raw ? JSON.parse(raw) : [...SEED_QUICKLINKS];
  } catch { state.quickLinks = [...SEED_QUICKLINKS]; }
}

function saveQuickLinks() {
  safeSetItem(CONFIG.STORAGE_KEY_QUICKLINKS, JSON.stringify(state.quickLinks));
  scheduleSyncToNeon();
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('hub_settings');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.stages) {
      Object.keys(s.stages).forEach(k => {
        if (STAGES[k]) STAGES[k] = { ...STAGES[k], ...s.stages[k] };
      });
    }
  } catch {}
}

function saveSettings() {
  safeSetItem('hub_settings', JSON.stringify({ stages: STAGES }));
  scheduleSyncToNeon();
}

function loadSavedViews() {
  try {
    const raw = localStorage.getItem('hub_views');
    state.savedViews = raw ? JSON.parse(raw) : [];
  } catch { state.savedViews = []; }
}

function saveSavedViews() {
  safeSetItem('hub_views', JSON.stringify(state.savedViews));
  scheduleSyncToNeon();
}

function renderQuickLinks() {
  const list = document.getElementById('quick-links-list');
  if (!list) return;
  list.innerHTML = state.quickLinks.map(ql => `
    <div class="quick-link-item">
      <a href="${escHtml(ql.url)}" target="_blank" rel="noopener" class="quick-link" style="flex:1;min-width:0">${escHtml(ql.label)}</a>
      <button class="quick-link-remove" onclick="editQuickLink('${ql.id}')" title="Edit">✎</button>
      <button class="quick-link-remove" onclick="removeQuickLink('${ql.id}')" title="Remove">✕</button>
    </div>
  `).join('');
}

function getSortedApps(apps) {
  if (state.sortOrder === 'manual') return apps;
  const s = [...apps];
  if (state.sortOrder === 'name-asc')  s.sort((a, b) => a.name.localeCompare(b.name));
  if (state.sortOrder === 'name-desc') s.sort((a, b) => b.name.localeCompare(a.name));
  return s;
}

function setSortOrder(order) {
  state.sortOrder = order;
  document.querySelectorAll('.sort-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.sort === order));
  // Can't arrange when not on manual order
  if (order !== 'manual' && state.arrangeMode) setArrangeMode(false);
  renderApps();
}

function setArrangeMode(on) {
  if (on && state.sortOrder !== 'manual') setSortOrder('manual');
  state.arrangeMode = on;
  const btn = document.getElementById('arrange-btn');
  if (btn) {
    btn.textContent = on ? '✓ Done' : '⠿ Arrange';
    btn.classList.toggle('active', on);
  }
  renderApps();
}

function renderViewsBar() {
  const bar = document.getElementById('views-bar');
  const chips = document.getElementById('views-chips');
  if (!bar || !chips) return;

  if (state.section === 'ideas' || state.section === 'settings') {
    bar.classList.add('hidden'); return;
  }
  bar.classList.remove('hidden');

  const sectionViews = state.savedViews.filter(v => v.section === state.section);
  chips.innerHTML = sectionViews.map(v => `
    <div class="view-chip" onclick="applyView('${v.id}')">
      ${escHtml(v.name)}
      <span class="view-chip-delete" onclick="event.stopPropagation();deleteView('${v.id}')">✕</span>
    </div>
  `).join('');
}

function applyView(id) {
  const v = state.savedViews.find(x => x.id === id);
  if (!v) return;
  state.sortOrder = v.sortOrder || 'manual';
  state.betaStageFilter = v.stageFilter || null;
  state.categoryFilter = v.categoryFilter || null;
  document.querySelectorAll('.sort-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.sort === state.sortOrder));
  renderApps();
}

function deleteView(id) {
  state.savedViews = state.savedViews.filter(v => v.id !== id);
  saveSavedViews();
  renderViewsBar();
}

function saveCurrentView() {
  const name = prompt('Name this view:');
  if (!name || !name.trim()) return;
  state.savedViews.push({
    id: uid(),
    name: name.trim(),
    section: state.section,
    sortOrder: state.sortOrder,
    stageFilter: state.betaStageFilter,
    categoryFilter: state.categoryFilter,
  });
  saveSavedViews();
  renderViewsBar();
}

function removeQuickLink(id) {
  state.quickLinks = state.quickLinks.filter(q => q.id !== id);
  saveQuickLinks();
  renderQuickLinks();
}

function editQuickLink(id) {
  const ql = state.quickLinks.find(q => q.id === id);
  if (!ql) return;
  state.editingQuickLinkId = id;
  document.getElementById('ql-modal-title').textContent = 'Edit quick link';
  document.getElementById('ql-label').value = ql.label;
  document.getElementById('ql-url').value   = ql.url;
  document.getElementById('ql-delete').classList.remove('hidden');
  document.getElementById('ql-modal-overlay').classList.remove('hidden');
  document.getElementById('ql-label').focus();
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ═══════════════════════════════════════════
// RENDER — APPS
// ═══════════════════════════════════════════

function filteredApps(section) {
  return state.apps.filter(a => {
    if (a.section !== section) return false;
    if (state.categoryFilter && (a.category || '').trim() !== state.categoryFilter) return false;
    if (!state.searchQuery) return true;
    const q = state.searchQuery.toLowerCase();
    return a.name.toLowerCase().includes(q)
      || a.desc.toLowerCase().includes(q)
      || (a.category || '').toLowerCase().includes(q);
  });
}

function statusLabel(section) {
  const map = { live: 'Live', beta: 'Beta', archive: 'Archive' };
  return map[section] || section;
}

function statusClass(section) {
  return `status-${section}`;
}

function cardIconHtml(app) {
  if (app.favicon) return `<img src="${escHtml(app.favicon)}" alt="">`;
  return escHtml(app.icon || '🔧');
}

function renderApps() {
  populateCategoryFilter();
  const apps = filteredApps(state.section);
  const isEmpty = apps.length === 0 && state.searchQuery;

  if (state.section === 'beta') {
    renderBetaRows(apps, isEmpty);
  } else {
    renderCardGrid(apps, isEmpty);
  }
}

function renderCardGrid(apps, isEmpty) {
  const container = document.getElementById('tools-grid');
  container.className = 'tools-grid' + (state.arrangeMode ? ' arrange-mode' : '');

  if (isEmpty) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><p>No tools match "<strong>${escHtml(state.searchQuery)}</strong>"</p></div>`;
    return;
  }

  const sorted = getSortedApps(apps);
  const pinned = sorted.filter(a => a.favorite);
  const rest = sorted.filter(a => !a.favorite);

  const makeCard = app => `
    <div class="tool-card" data-id="${app.id}"
      ${state.arrangeMode ? 'draggable="true"' : ''}
      onclick="${state.arrangeMode ? '' : `openTool('${app.id}')`}">
      <div class="card-top">
        ${state.arrangeMode ? '<span class="drag-handle">⠿</span>' : ''}
        <div class="card-icon">${cardIconHtml(app)}</div>
        <div style="display:flex;align-items:center;gap:4px">
          <span class="card-status ${statusClass(app.section)}">● ${statusLabel(app.section)}</span>
          <button class="card-star-btn ${app.favorite ? 'active' : ''}" onclick="event.stopPropagation();toggleFavorite('${app.id}')" title="${app.favorite ? 'Unpin' : 'Pin'}">${app.favorite ? '★' : '☆'}</button>
          <button class="card-edit-btn" onclick="event.stopPropagation();openEditModal('${app.id}')">✎</button>
        </div>
      </div>
      <div class="card-name">${escHtml(app.name)}</div>
      <div class="card-desc">${escHtml(app.desc)}</div>
      ${app.category && app.category.trim() ? `<div class="card-cats">${categoryBadgeHtml(app.category)}</div>` : ''}
      <div class="card-footer">
        <span class="card-access">${app.access === 'protected' ? '🔑 protected' : '🌐 public'}</span>
        <span class="card-open">Open →</span>
      </div>
    </div>
  `;

  let html = '';
  if (pinned.length > 0 && !state.arrangeMode) {
    html += `<div class="grid-pinned-header grid-full-row">★ Pinned</div>`;
    html += pinned.map(makeCard).join('');
    html += `<div class="grid-divider grid-full-row"></div>`;
  } else {
    html += pinned.map(makeCard).join('');
  }
  html += rest.map(makeCard).join('');

  const addCard = state.arrangeMode ? '' : `
    <button class="tool-card-add" onclick="openAddModal()">
      <span class="tool-card-add-icon">+</span>
      <span class="tool-card-add-label">Add tool</span>
    </button>`;

  container.innerHTML = html + addCard;
  if (state.arrangeMode) setupDragOnContainer(container, 'card');
}

function setBetaFilter(stage) {
  state.betaStageFilter = stage;
  renderApps();
}

function toggleFavorite(id) {
  const app = state.apps.find(a => a.id === id);
  if (!app) return;
  app.favorite = !app.favorite;
  saveApps();
  renderApps();
}

function toggleRow(id) {
  if (state.expandedRows.has(id)) {
    state.expandedRows.delete(id);
  } else {
    state.expandedRows.add(id);
  }
  renderBetaRows(filteredApps('beta'), false);
}

function renderBetaRows(apps, isEmpty) {
  const container = document.getElementById('tools-grid');
  container.className = 'tools-list';

  if (isEmpty) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🔍</div><p>No tools match "<strong>${escHtml(state.searchQuery)}</strong>"</p></div>`;
    return;
  }

  // Build filter pills for all 11 stages (always visible, count shown per stage)
  const allBeta = state.apps.filter(a => a.section === 'beta');
  const stageOrder = ['idea', 'scoping', 'concept', 'designing', 'building', 'review', 'testing', 'beta', 'ready', 'paused', 'blocked'];

  const filterPills = stageOrder.map(s => {
    const st = STAGES[s];
    const count = allBeta.filter(a => a.stage === s).length;
    const active = state.betaStageFilter === s;
    return `<button class="beta-filter-pill ${active ? 'active' : ''} ${count === 0 ? 'empty' : ''}" onclick="setBetaFilter('${s}')"
      style="${active ? `background:${st.bg};color:${st.fg};border-color:${st.fg}40` : ''}"
    >${st.label}${count > 0 ? ` <span class="beta-filter-count">${count}</span>` : ''}</button>`;
  }).join('');

  const allActive = !state.betaStageFilter;
  const filterBar = `<div class="beta-filter-bar">
    <button class="beta-filter-pill ${allActive ? 'active' : ''}" onclick="setBetaFilter(null)">All <span class="beta-filter-count">${allBeta.length}</span></button>
    ${filterPills}
  </div>`;

  // Apply stage filter then sort
  const filtered = state.betaStageFilter
    ? apps.filter(a => a.stage === state.betaStageFilter)
    : apps;
  const sorted = getSortedApps(filtered);

  const pinnedRows = sorted.filter(a => a.favorite);
  const restRows = sorted.filter(a => !a.favorite);

  const makeRow = app => {
    const expanded = state.expandedRows.has(app.id);
    const stageBadge = stageBadgeHtml(app.stage) || '<span class="stage-badge" style="background:#F3F4F6;color:#9CA3AF">No stage</span>';
    const urlChip = app.url && app.url !== '#'
      ? `<span class="meta-chip">🔗 <a href="${escHtml(app.url)}" target="_blank" rel="noopener">${escHtml(app.url)}</a></span>`
      : '';
    const accessChip = `<span class="meta-chip">${app.access === 'protected' ? '🔑 Password protected' : '🌐 Public'}</span>`;
    const stageChip = app.stage && STAGES[app.stage]
      ? `<span class="meta-chip" style="background:${STAGES[app.stage].bg};color:${STAGES[app.stage].fg};border-color:transparent">${STAGES[app.stage].label}</span>`
      : '';
    const catChip = app.category && app.category.trim()
      ? `<span class="meta-chip">🏷 ${escHtml(app.category.trim())}</span>`
      : '';
    const notesContent = app.notes && app.notes.trim()
      ? `<div class="tool-row-notes-body">${app.notes}</div>`
      : `<div class="tool-row-notes-empty">No notes yet — click Edit to add context, links, or progress updates.</div>`;
    return `
    <div class="tool-row ${expanded ? 'expanded' : ''}" id="row-${app.id}" data-id="${app.id}"
      ${state.arrangeMode ? 'draggable="true"' : ''}>
      <div class="tool-row-header" onclick="${state.arrangeMode ? '' : `toggleRow('${app.id}')`}">
        ${state.arrangeMode ? '<span class="drag-handle" style="opacity:0.6">⠿</span>' : ''}
        <div class="tool-row-badges">${stageBadge}${app.category && app.category.trim() ? categoryBadgeHtml(app.category) : ''}</div>
        <div class="tool-row-icon">${cardIconHtml(app)}</div>
        <div class="tool-row-info">
          <span class="tool-row-name">${escHtml(app.name)}</span>
          <span class="tool-row-desc">${escHtml(app.desc)}</span>
        </div>
        <span class="tool-row-access">${app.access === 'protected' ? '🔑' : '🌐'}</span>
        <button class="tool-row-btn" onclick="event.stopPropagation();openEditModal('${app.id}')">✎ Edit</button>
        <button class="tool-row-btn open" onclick="event.stopPropagation();openTool('${app.id}')">Open →</button>
        <button class="row-star-btn ${app.favorite ? 'active' : ''}" onclick="event.stopPropagation();toggleFavorite('${app.id}')" title="${app.favorite ? 'Unpin' : 'Pin'}">${app.favorite ? '★' : '☆'}</button>
        <span class="tool-row-chevron">▼</span>
      </div>
      <div class="tool-row-body">
        <div class="tool-row-detail">
          <div class="tool-row-meta">
            ${stageChip}${catChip}${accessChip}${urlChip}
          </div>
          <div class="tool-row-notes">
            <div class="tool-row-notes-label">Notes</div>
            ${notesContent}
          </div>
          <div class="tool-row-detail-actions">
            <button class="btn btn-ghost btn-sm" onclick="openEditModal('${app.id}')">✎ Edit details</button>
            ${app.url && app.url !== '#' ? `<button class="btn btn-primary btn-sm" onclick="openTool('${app.id}')">Open →</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  };

  let rows = '';
  if (pinnedRows.length > 0 && !state.arrangeMode) {
    rows += `<div class="rows-pinned-header">★ Pinned</div>`;
    rows += pinnedRows.map(makeRow).join('');
    rows += `<div class="rows-pinned-divider"></div>`;
    rows += restRows.map(makeRow).join('');
  } else {
    rows = sorted.map(makeRow).join('');
  }

  const addRow = state.arrangeMode ? '' : `
    <button class="tool-row-add" onclick="openAddModal()">
      <span>+</span> Add beta tool
    </button>`;

  container.innerHTML = filterBar + rows + addRow;
  if (state.arrangeMode) setupDragOnContainer(container, 'row');
}

function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || '';
}

function openTool(id) {
  const app = state.apps.find(a => a.id === id);
  if (!app || !app.url || app.url === '#') return;
  window.open(app.url, '_blank', 'noopener');
}

function updateBadges() {
  ['live', 'beta', 'archive'].forEach(s => {
    const el = document.getElementById(`badge-${s}`);
    if (el) el.textContent = state.apps.filter(a => a.section === s).length;
  });
  const notesBadge = document.getElementById('badge-ideas');
  if (notesBadge) notesBadge.textContent = state.notes.length;
}

// ═══════════════════════════════════════════
// RENDER — NOTES
// ═══════════════════════════════════════════

function renderNotesList() {
  const list = document.getElementById('notes-list');
  const count = document.getElementById('notes-count');
  count.textContent = `Notes (${state.notes.length})`;

  if (state.notes.length === 0) {
    list.innerHTML = `<div style="padding:1rem;text-align:center;color:var(--muted-2);font-size:0.83rem;">No notes yet. Hit + New to start.</div>`;
    return;
  }

  list.innerHTML = state.notes
    .slice()
    .sort((a, b) => b.updated - a.updated)
    .map(n => `
      <div class="note-row ${n.id === state.activeNoteId ? 'active' : ''}" onclick="selectNote('${n.id}')">
        <div class="note-row-title">${escHtml(n.title || 'Untitled')}</div>
        <div class="note-row-preview">${formatNoteDate(n.updated)} · ${escHtml(stripHtml(n.body || '').slice(0, 40))}…</div>
      </div>
    `).join('');
}

function selectNote(id) {
  // Flush pending edits on the outgoing note before switching —
  // otherwise the 300 ms autosave debounce can drop keystrokes
  if (state.activeNoteId && state.activeNoteId !== id) saveCurrentNote();
  state.activeNoteId = id;
  const note = state.notes.find(n => n.id === id);
  if (!note) return;

  renderNotesList();

  document.getElementById('note-placeholder').classList.add('hidden');
  const editor = document.getElementById('note-editor');
  editor.classList.remove('hidden');

  document.getElementById('note-meta').textContent =
    `Edited ${formatNoteDate(note.updated)}`;
  document.getElementById('note-title').value = note.title || '';
  // body stored as HTML; legacy plain-text notes: convert newlines
  const body = note.body || '';
  document.getElementById('note-body').innerHTML =
    body.includes('<') ? body : body.replace(/\n/g, '<br>');
}

function newNote() {
  const note = { id: uid(), title: '', body: '', created: Date.now(), updated: Date.now() };
  state.notes.unshift(note);
  saveNotes();
  updateBadges();
  renderNotesList();
  selectNote(note.id);
  document.getElementById('note-title').focus();
}

function saveCurrentNote() {
  if (!state.activeNoteId) return;
  const note = state.notes.find(n => n.id === state.activeNoteId);
  if (!note) return;
  const title = document.getElementById('note-title').value;
  const body  = document.getElementById('note-body').innerHTML;
  if (title === note.title && body === note.body) return; // nothing changed — don't bump `updated`
  note.title = title;
  note.body  = body;
  note.updated = Date.now();
  saveNotes();
  updateBadges();
  renderNotesList();
  showSaveStatus();
}

function deleteCurrentNote() {
  if (!state.activeNoteId) return;
  if (!confirm('Delete this note?')) return;
  state.notes = state.notes.filter(n => n.id !== state.activeNoteId);
  state.activeNoteId = null;
  saveNotes();
  updateBadges();
  renderNotesList();
  document.getElementById('note-placeholder').classList.remove('hidden');
  document.getElementById('note-editor').classList.add('hidden');
}

function formatNoteDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 864e5);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════

function switchSection(section) {
  // Exit arrange mode on section change
  if (state.arrangeMode) setArrangeMode(false);
  state.section = section;
  state.betaStageFilter = null;
  state.categoryFilter = null;

  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.section === section));
  document.getElementById('settings-nav-btn')?.classList.toggle('active', section === 'settings');

  const appsPane     = document.getElementById('section-apps');
  const ideasPane    = document.getElementById('section-ideas-pane');
  const settingsPane = document.getElementById('section-settings');
  const sortPills    = document.getElementById('sort-pills');
  const arrangeBtn   = document.getElementById('arrange-btn');

  appsPane.classList.add('hidden');
  ideasPane.classList.add('hidden');
  settingsPane.classList.add('hidden');

  if (section === 'ideas') {
    ideasPane.classList.remove('hidden');
    if (sortPills) sortPills.style.display = 'none';
    if (arrangeBtn) arrangeBtn.style.display = 'none';
    renderNotesList();
  } else if (section === 'settings') {
    settingsPane.classList.remove('hidden');
    if (sortPills) sortPills.style.display = 'none';
    if (arrangeBtn) arrangeBtn.style.display = 'none';
    renderSettings();
  } else {
    appsPane.classList.remove('hidden');
    if (sortPills) sortPills.style.display = '';
    if (arrangeBtn) arrangeBtn.style.display = '';
    const titles = { live: '⚡ Live tools', beta: '🧪 Beta', archive: '🗄 Archive' };
    document.getElementById('section-title').textContent = titles[section] || section;
    renderApps();
    renderViewsBar();
  }
}

// ═══════════════════════════════════════════
// MODAL — Add / Edit tool
// ═══════════════════════════════════════════

let _pendingFavicon = null; // base64 string or null

function setIconPreview(favicon, emoji) {
  const preview = document.getElementById('icon-preview');
  const clearBtn = document.getElementById('favicon-clear-btn');
  if (favicon) {
    preview.innerHTML = `<img src="${escHtml(favicon)}" alt="">`;
    clearBtn.classList.remove('hidden');
  } else {
    preview.textContent = emoji || '🔧';
    clearBtn.classList.add('hidden');
  }
}

function openAddModal() {
  state.editingAppId = null;
  _pendingFavicon = null;
  document.getElementById('modal-title').textContent = 'Add tool';
  document.getElementById('tool-name').value    = '';
  document.getElementById('tool-desc').value    = '';
  document.getElementById('tool-url').value     = '';
  document.getElementById('tool-icon').value    = '';
  document.getElementById('tool-favicon').value = '';
  document.getElementById('tool-section').value = state.section === 'ideas' ? 'live' : state.section;
  document.getElementById('tool-access').value  = 'protected';
  document.getElementById('tool-stage').value   = state.section === 'beta' ? 'concept' : '';
  document.getElementById('tool-category').value = '';
  populateCategoryDatalist();
  document.getElementById('tool-notes').innerHTML = '';
  document.getElementById('modal-delete').classList.add('hidden');
  setIconPreview(null, '🔧');
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('tool-name').focus();
}

function openEditModal(id) {
  const app = state.apps.find(a => a.id === id);
  if (!app) return;
  state.editingAppId = id;
  _pendingFavicon = app.favicon || null;
  document.getElementById('modal-title').textContent = 'Edit tool';
  document.getElementById('tool-name').value    = app.name;
  document.getElementById('tool-desc').value    = app.desc;
  document.getElementById('tool-url').value     = app.url;
  document.getElementById('tool-icon').value    = app.icon || '';
  document.getElementById('tool-favicon').value = '';
  document.getElementById('tool-section').value = app.section;
  document.getElementById('tool-access').value  = app.access;
  document.getElementById('tool-stage').value   = app.stage || '';
  document.getElementById('tool-category').value = app.category || '';
  populateCategoryDatalist();
  document.getElementById('tool-notes').innerHTML = app.notes || '';
  document.getElementById('modal-delete').classList.remove('hidden');
  setIconPreview(app.favicon, app.icon);
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('tool-name').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  state.editingAppId = null;
}

function saveTool() {
  const name    = document.getElementById('tool-name').value.trim();
  const desc    = document.getElementById('tool-desc').value.trim();
  const url     = document.getElementById('tool-url').value.trim();
  const icon    = document.getElementById('tool-icon').value.trim() || '🔧';
  const section = document.getElementById('tool-section').value;
  const access  = document.getElementById('tool-access').value;
  const favicon = _pendingFavicon || null;
  const stage   = document.getElementById('tool-stage').value;
  const category = document.getElementById('tool-category').value.trim();
  const notes   = document.getElementById('tool-notes').innerHTML.trim();

  if (!name) { document.getElementById('tool-name').focus(); return; }

  if (state.editingAppId) {
    const app = state.apps.find(a => a.id === state.editingAppId);
    if (app) Object.assign(app, { name, desc, url, icon, favicon, section, access, stage, category, notes });
  } else {
    state.apps.push({ id: uid(), name, desc, url, icon, favicon, section, access, stage, category, notes });
  }

  saveApps();
  updateBadges();
  renderApps();
  closeModal();
}

function deleteTool() {
  if (!state.editingAppId) return;
  const app = state.apps.find(a => a.id === state.editingAppId);
  if (!app) return;
  if (!confirm(`Delete "${app.name}"?`)) return;
  state.apps = state.apps.filter(a => a.id !== state.editingAppId);
  saveApps();
  updateBadges();
  renderApps();
  closeModal();
}

// ═══════════════════════════════════════════
// QUICK LINKS MODAL
// ═══════════════════════════════════════════

function closeQlModal() {
  document.getElementById('ql-modal-overlay').classList.add('hidden');
  state.editingQuickLinkId = null;
}

function saveQuickLink() {
  const label = document.getElementById('ql-label').value.trim();
  const url   = document.getElementById('ql-url').value.trim();
  if (!label || !url) return;

  if (state.editingQuickLinkId) {
    const ql = state.quickLinks.find(q => q.id === state.editingQuickLinkId);
    if (ql) Object.assign(ql, { label, url });
  } else {
    state.quickLinks.push({ id: uid(), label, url });
  }
  saveQuickLinks();
  renderQuickLinks();
  closeQlModal();
}

// ═══════════════════════════════════════════
// DRAG & DROP reorder
// ═══════════════════════════════════════════

let _dragSrcId = null;

function setupDragOnContainer(container, type) {
  // Container element persists across renders — bind once or handlers stack
  if (container._dragBound) return;
  container._dragBound = true;

  container.addEventListener('dragstart', e => {
    const el = e.target.closest('[data-id]');
    if (!el) return;
    _dragSrcId = el.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => el.classList.add('dragging'), 0);
  });

  container.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const el = e.target.closest('[data-id]');
    container.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target'));
    if (el && el.dataset.id !== _dragSrcId) el.classList.add('drop-target');
  });

  container.addEventListener('dragleave', e => {
    if (!container.contains(e.relatedTarget)) {
      container.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target'));
    }
  });

  container.addEventListener('drop', e => {
    e.preventDefault();
    const tgtEl = e.target.closest('[data-id]');
    const tgtId = tgtEl?.dataset.id;
    container.querySelectorAll('.dragging, .drop-target').forEach(x => {
      x.classList.remove('dragging', 'drop-target');
    });
    if (!_dragSrcId || !tgtId || _dragSrcId === tgtId) { _dragSrcId = null; return; }
    const srcIdx = state.apps.findIndex(a => a.id === _dragSrcId);
    const tgtIdx = state.apps.findIndex(a => a.id === tgtId);
    if (srcIdx === -1 || tgtIdx === -1) { _dragSrcId = null; return; }
    const [moved] = state.apps.splice(srcIdx, 1);
    state.apps.splice(tgtIdx, 0, moved);
    saveApps();
    renderApps();
    _dragSrcId = null;
  });

  container.addEventListener('dragend', () => {
    container.querySelectorAll('.dragging, .drop-target').forEach(x => {
      x.classList.remove('dragging', 'drop-target');
    });
    _dragSrcId = null;
  });
}

// ═══════════════════════════════════════════
// SETTINGS SECTION
// ═══════════════════════════════════════════

function renderSettings() {
  const el = document.getElementById('section-settings');
  if (!el) return;

  const rows = Object.entries(STAGES).map(([key, s]) => `
    <div class="settings-stage-row">
      <span class="settings-stage-preview" id="preview-${key}" style="background:${s.bg};color:${s.fg}">${escHtml(s.label)}</span>
      <div class="settings-color-group">
        <span class="settings-color-label">Background</span>
        <input type="color" class="stage-color-input" data-stage="${key}" data-field="bg" value="${s.bg}"
          title="Background color">
      </div>
      <div class="settings-color-group">
        <span class="settings-color-label">Text</span>
        <input type="color" class="stage-color-input" data-stage="${key}" data-field="fg" value="${s.fg}"
          title="Text color">
      </div>
      <button class="settings-reset-btn" onclick="resetStageColor('${key}')">Reset</button>
    </div>
  `).join('');

  const usedKB = storageUsageKB();
  const usedPct = Math.min(100, Math.round(usedKB / 5120 * 100));

  el.innerHTML = `
    <div class="settings-header"><h2>⚙ Settings</h2></div>
    <div class="settings-section-block">
      <div class="settings-block-title">Stage colors</div>
      <div class="settings-stages-grid">${rows}</div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="settings-reset-btn" onclick="resetAllStageColors()">Reset all to defaults</button>
      </div>
    </div>
    <div class="settings-section-block">
      <div class="settings-block-title">Data &amp; backup</div>
      <p class="settings-block-desc">
        All hub data lives in this browser's local storage — it does not sync between devices,
        and clearing browser data erases it. Export a backup regularly.
      </p>
      <div class="settings-storage-meter">
        <div class="settings-storage-bar"><div class="settings-storage-fill" style="width:${usedPct}%"></div></div>
        <span class="settings-storage-label">~${usedKB < 1024 ? usedKB + ' KB' : (usedKB / 1024).toFixed(1) + ' MB'} of ~5 MB used</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="syncToNeon()">↻ Sync now</button>
        <button class="btn btn-ghost btn-sm" onclick="exportData()">↓ Backup</button>
        <button class="btn btn-ghost btn-sm" id="import-backup-btn">↑ Restore backup</button>
        <input type="file" id="import-file-input" accept=".json,application/json" style="display:none">
      </div>
      <p class="settings-block-desc" style="margin-top:8px;font-size:0.78rem">
        All changes auto-sync to Neon within ~1.5 s. Team members see updates on their next page load or within 30 s (auto-poll).<br>
        <strong>Backup</strong> → full JSON export for archival/restore.
      </p>
    </div>
  `;

  // Bind import controls (recreated on each render)
  el.querySelector('#import-backup-btn').addEventListener('click', () =>
    el.querySelector('#import-file-input').click());
  el.querySelector('#import-file-input').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  // Bind live-preview on color inputs
  el.querySelectorAll('.stage-color-input').forEach(input => {
    input.addEventListener('input', () => {
      const { stage, field } = input.dataset;
      STAGES[stage][field] = input.value;
      const preview = document.getElementById(`preview-${stage}`);
      if (preview) {
        preview.style.background = STAGES[stage].bg;
        preview.style.color      = STAGES[stage].fg;
      }
    });
    input.addEventListener('change', () => {
      saveSettings();
      // Re-render apps so badges reflect new colors
      if (state.section !== 'settings' && state.section !== 'ideas') renderApps();
    });
  });
}

function updateSidebarStorageMeter() {
  const fill  = document.getElementById('sidebar-storage-fill');
  const label = document.getElementById('sidebar-storage-label');
  if (!fill || !label) return;
  const kb = storageUsageKB();
  const pct = Math.min(100, Math.round(kb / 5120 * 100));
  fill.style.width = `${pct}%`;
  fill.className = 'sidebar-storage-fill' + (pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '');
  label.textContent = kb < 1024 ? `${kb} KB / 5 MB` : `${(kb / 1024).toFixed(1)} MB / 5 MB`;
}

function storageUsageKB() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    total += k.length + (localStorage.getItem(k)?.length || 0);
  }
  return Math.round(total * 2 / 1024); // strings are UTF-16: 2 bytes per char
}

function exportData() {
  const data = {
    hubBackup: 1,
    exportedAt: new Date().toISOString(),
    apps: state.apps,
    notes: state.notes,
    quickLinks: state.quickLinks,
    savedViews: state.savedViews,
    stages: STAGES,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `analytix-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Publish shared data for the team: exports data.json which you commit to
// the repo. Netlify deploys it → all team members get the update on next refresh.
// Only includes apps + quickLinks (notes are personal, never shared).
function publishToTeam() {
  const data = {
    hubData: 1,
    publishedAt: new Date().toISOString(),
    apps: state.apps,
    quickLinks: state.quickLinks,
    notes: state.notes,
    stages: STAGES,
    savedViews: state.savedViews,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'data.json';
  a.click();
  URL.revokeObjectURL(a.href);
  alert('data.json downloaded.\n\nReplace tools/hub/data.json in your repo → commit + push to GitHub → Netlify deploys → team sees everything on next refresh.');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    let data;
    try {
      data = JSON.parse(ev.target.result);
    } catch { alert('Could not import — file is not valid JSON.'); return; }
    if (!data || (!Array.isArray(data.apps) && !Array.isArray(data.notes))) {
      alert('Could not import — file is not a hub backup.'); return;
    }
    if (!confirm('Importing replaces ALL current apps, notes, quick links, saved views, and stage colors with the backup. Continue?')) return;
    if (Array.isArray(data.apps))       { state.apps = data.apps;             saveApps(); }
    if (Array.isArray(data.notes))      { state.notes = data.notes;           saveNotes(); }
    if (Array.isArray(data.quickLinks)) { state.quickLinks = data.quickLinks; saveQuickLinks(); }
    if (Array.isArray(data.savedViews)) { state.savedViews = data.savedViews; saveSavedViews(); }
    if (data.stages) {
      Object.keys(data.stages).forEach(k => { if (STAGES[k]) STAGES[k] = { ...STAGES[k], ...data.stages[k] }; });
      saveSettings();
    }
    state.activeNoteId = null;
    state.expandedRows.clear();
    updateBadges();
    renderQuickLinks();
    renderViewsBar();
    renderSettings();
    alert('Backup imported ✓');
  };
  reader.readAsText(file);
}

function resetStageColor(key) {
  STAGES[key] = { ...DEFAULT_STAGES[key] };
  saveSettings();
  renderSettings();
  if (state.section !== 'settings' && state.section !== 'ideas') renderApps();
}

function resetAllStageColors() {
  STAGES = JSON.parse(JSON.stringify(DEFAULT_STAGES));
  saveSettings();
  renderSettings();
  if (state.section !== 'settings' && state.section !== 'ideas') renderApps();
}

// ═══════════════════════════════════════════
// NOTES — RTE helpers
// ═══════════════════════════════════════════

let _noteSavedRange = null;
let _selectedImg = null;
let _saveStatusTimer = null;

function showSaveStatus() {
  const el = document.getElementById('note-save-status');
  if (!el) return;
  el.textContent = 'Autosaved ✓';
  el.classList.add('visible');
  clearTimeout(_saveStatusTimer);
  _saveStatusTimer = setTimeout(() => el.classList.remove('visible'), 2000);
}

function showImgToolbar(img) {
  if (_selectedImg && _selectedImg !== img) _selectedImg.classList.remove('selected');
  _selectedImg = img;
  img.classList.add('selected');
  const toolbar = document.getElementById('note-img-toolbar');
  const rect = img.getBoundingClientRect();
  toolbar.style.left = `${rect.left + rect.width / 2}px`;
  toolbar.style.top  = `${Math.max(8, rect.top - 44)}px`;
  toolbar.classList.remove('hidden');
}

function hideImgToolbar() {
  if (_selectedImg) { _selectedImg.classList.remove('selected'); _selectedImg = null; }
  document.getElementById('note-img-toolbar').classList.add('hidden');
}

function imgWidthPct(img) {
  return parseInt(img.style.width) || 100;
}

function setImgWidth(pct) {
  if (!_selectedImg) return;
  _selectedImg.style.width = `${Math.min(100, Math.max(10, pct))}%`;
  _selectedImg.style.maxWidth = '100%';
  showImgToolbar(_selectedImg);
  saveCurrentNote();
}

function saveNoteRange() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    _noteSavedRange = sel.getRangeAt(0).cloneRange();
  }
}

function restoreNoteRange() {
  const editor = document.getElementById('note-body');
  if (!editor) return;
  editor.focus();
  const sel = window.getSelection();
  if (_noteSavedRange && sel) {
    sel.removeAllRanges();
    sel.addRange(_noteSavedRange);
  }
}

function insertNoteImage(dataUrl) {
  restoreNoteRange();
  const img = document.createElement('img');
  img.src = dataUrl;
  img.className = 'note-inline-img';
  _insertNodeAtCursor(img);
  // place a br after so cursor lands below the image
  _insertNodeAtCursor(document.createElement('br'));
  saveCurrentNote();
}

function insertNoteFile(name, dataUrl) {
  restoreNoteRange();
  const chip = document.createElement('a');
  chip.href = dataUrl;
  chip.download = name;
  chip.className = 'note-file-chip';
  chip.textContent = `📎 ${name}`;
  _insertNodeAtCursor(chip);
  _insertNodeAtCursor(document.createElement('br'));
  saveCurrentNote();
}

function _insertNodeAtCursor(node) {
  const editor = document.getElementById('note-body');
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    range.collapse(false);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    editor.appendChild(node);
  }
}

function readFilesIntoNote(files) {
  const MAX = 8 * 1024 * 1024; // 8 MB
  [...files].forEach(file => {
    if (file.size > MAX) {
      alert(`"${file.name}" is too large (max 8 MB).`);
      return;
    }
    const reader = new FileReader();
    if (file.type.startsWith('image/')) {
      reader.onload = ev => insertNoteImage(ev.target.result);
    } else {
      reader.onload = ev => insertNoteFile(file.name, ev.target.result);
    }
    reader.readAsDataURL(file);
  });
}

// ═══════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════

// Downscale uploaded favicons so base64 payloads stay tiny in localStorage
function downscaleImage(src, maxSize, cb) {
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    cb(canvas.toDataURL('image/png'));
  };
  img.onerror = () => cb(src); // some .ico files won't decode — keep original
  img.src = src;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════

async function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  loadSettings();
  loadApps();       // render immediately from localStorage cache
  loadNotes();
  loadQuickLinks();
  loadSavedViews();
  updateBadges();
  renderApps();
  renderQuickLinks();
  renderViewsBar();
  updateSidebarStorageMeter();
  // Fetch latest from Neon in background — re-renders if data changed
  loadFromNeon();
  // Poll every 30 s so team updates appear without manual refresh
  setInterval(loadFromNeon, 30000);
}

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function bindEvents() {
  // Login
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const pw = document.getElementById('password-input').value;
    const errEl = document.getElementById('login-error');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    const fail = () => {
      errEl.classList.remove('hidden');
      document.getElementById('password-input').select();
      if (submitBtn) submitBtn.disabled = false;
    };

    try {
      const res = await fetch(CONFIG.AUTH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        const { token, expiry } = await res.json();
        setHubToken(token, expiry);
        saveSession();
        errEl.classList.add('hidden');
        if (submitBtn) submitBtn.disabled = false;
        showApp();
        return;
      }
      if (res.status === 401) { fail(); return; }       // wrong password
      throw new Error('auth unavailable');               // 500/misconfig → try dev fallback
    } catch {
      // hub-auth unreachable (local `npx serve` has no functions). Allow entry on
      // localhost only so local dev keeps working; real hosts must authenticate.
      if (isLocalHost()) {
        saveSession();
        errEl.classList.add('hidden');
        if (submitBtn) submitBtn.disabled = false;
        showApp();
        return;
      }
      fail();
    }
  });

  // Lock
  document.getElementById('lock-btn').addEventListener('click', () => {
    clearSession();
    showLogin();
  });

  // Sidebar nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => switchSection(el.dataset.section));
  });

  // Search
  document.getElementById('search-input').addEventListener('input', e => {
    state.searchQuery = e.target.value;
    renderApps();
  });

  // Sort pills
  document.querySelectorAll('.sort-pill').forEach(btn => {
    btn.addEventListener('click', () => setSortOrder(btn.dataset.sort));
  });

  // Category filter dropdown
  document.getElementById('category-filter').addEventListener('change', e =>
    setCategoryFilter(e.target.value));

  // Arrange mode toggle
  document.getElementById('arrange-btn').addEventListener('click', () =>
    setArrangeMode(!state.arrangeMode));

  // Save view
  document.getElementById('save-view-btn').addEventListener('click', saveCurrentView);

  // Settings nav button
  document.getElementById('settings-nav-btn').addEventListener('click', () =>
    switchSection('settings'));

  // Add tool button (topbar)
  document.getElementById('add-tool-btn').addEventListener('click', openAddModal);

  // Quick links
  document.getElementById('add-quicklink-btn').addEventListener('click', () => {
    state.editingQuickLinkId = null;
    document.getElementById('ql-modal-title').textContent = 'Add quick link';
    document.getElementById('ql-label').value = '';
    document.getElementById('ql-url').value   = '';
    document.getElementById('ql-delete').classList.add('hidden');
    document.getElementById('ql-modal-overlay').classList.remove('hidden');
    document.getElementById('ql-label').focus();
  });
  document.getElementById('ql-modal-close').addEventListener('click', closeQlModal);
  document.getElementById('ql-cancel').addEventListener('click', closeQlModal);
  document.getElementById('ql-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeQlModal();
  });
  document.getElementById('ql-save').addEventListener('click', saveQuickLink);
  document.getElementById('ql-delete').addEventListener('click', () => {
    if (!state.editingQuickLinkId) return;
    state.quickLinks = state.quickLinks.filter(q => q.id !== state.editingQuickLinkId);
    saveQuickLinks();
    renderQuickLinks();
    closeQlModal();
  });

  // Rich text toolbar
  document.querySelectorAll('.rte-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault(); // keep editor focus
      const cmd = btn.dataset.cmd;
      document.getElementById('tool-notes').focus();
      document.execCommand(cmd, false, null);
    });
  });

  // Favicon upload
  document.getElementById('favicon-upload-btn').addEventListener('click', () => {
    document.getElementById('tool-favicon').click();
  });
  document.getElementById('tool-favicon').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      downscaleImage(ev.target.result, 64, dataUrl => {
        _pendingFavicon = dataUrl;
        setIconPreview(_pendingFavicon, document.getElementById('tool-icon').value);
      });
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('favicon-clear-btn').addEventListener('click', () => {
    _pendingFavicon = null;
    document.getElementById('tool-favicon').value = '';
    setIconPreview(null, document.getElementById('tool-icon').value || '🔧');
  });
  // Emoji input live preview (when no favicon)
  document.getElementById('tool-icon').addEventListener('input', e => {
    if (!_pendingFavicon) setIconPreview(null, e.target.value || '🔧');
  });

  // Modal
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', saveTool);
  document.getElementById('modal-delete').addEventListener('click', deleteTool);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Notes actions
  document.getElementById('new-note-btn').addEventListener('click', newNote);
  document.getElementById('save-note-btn').addEventListener('click', saveCurrentNote);
  document.getElementById('delete-note-btn').addEventListener('click', deleteCurrentNote);

  // Autosave on typing (300 ms debounce — feels instant)
  let noteTimer;
  const autoSave = () => { clearTimeout(noteTimer); noteTimer = setTimeout(saveCurrentNote, 300); };
  document.getElementById('note-title').addEventListener('input', autoSave);
  document.getElementById('note-body').addEventListener('input', autoSave);

  // Note RTE toolbar
  document.querySelectorAll('.note-rte-btn[data-cmd]').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      saveNoteRange();
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.val || null;
      document.getElementById('note-body').focus();
      document.execCommand(cmd, false, val);
    });
  });

  // Link button — prompt for URL
  document.getElementById('note-link-btn').addEventListener('mousedown', e => {
    e.preventDefault();
    saveNoteRange();
    const url = prompt('Enter URL:');
    if (url) {
      restoreNoteRange();
      document.execCommand('createLink', false, url);
    }
  });

  // Image upload button
  document.getElementById('note-img-btn').addEventListener('mousedown', e => {
    e.preventDefault();
    saveNoteRange();
    document.getElementById('note-img-input').click();
  });
  document.getElementById('note-img-input').addEventListener('change', e => {
    readFilesIntoNote(e.target.files);
    e.target.value = '';
  });

  // File attach button
  document.getElementById('note-file-btn').addEventListener('mousedown', e => {
    e.preventDefault();
    saveNoteRange();
    document.getElementById('note-file-input').click();
  });
  document.getElementById('note-file-input').addEventListener('change', e => {
    readFilesIntoNote(e.target.files);
    e.target.value = '';
  });

  // Drag & drop onto note body
  const noteBody = document.getElementById('note-body');
  noteBody.addEventListener('dragover', e => {
    e.preventDefault();
    noteBody.classList.add('drag-over');
  });
  noteBody.addEventListener('dragleave', () => noteBody.classList.remove('drag-over'));
  noteBody.addEventListener('drop', e => {
    e.preventDefault();
    noteBody.classList.remove('drag-over');
    if (e.dataTransfer.files.length) {
      readFilesIntoNote(e.dataTransfer.files);
    }
  });

  // Paste — intercept images; strip HTML from text paste
  noteBody.addEventListener('paste', e => {
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find(i => i.type.startsWith('image/'));
    if (imageItem) {
      e.preventDefault();
      saveNoteRange();
      const file = imageItem.getAsFile();
      const reader = new FileReader();
      reader.onload = ev => insertNoteImage(ev.target.result);
      reader.readAsDataURL(file);
    } else {
      // Paste as plain text to avoid imported styles
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      if (text) document.execCommand('insertText', false, text);
    }
  });

  // Image click in note body → show resize toolbar
  document.getElementById('note-body').addEventListener('click', e => {
    if (e.target.classList.contains('note-inline-img')) {
      showImgToolbar(e.target);
    } else if (!document.getElementById('note-img-toolbar').contains(e.target)) {
      hideImgToolbar();
    }
  });

  // Hide image toolbar on note body scroll
  document.getElementById('note-body').addEventListener('scroll', hideImgToolbar);

  // Image toolbar buttons
  document.getElementById('img-tb-shrink').addEventListener('mousedown', e => {
    e.preventDefault(); setImgWidth(imgWidthPct(_selectedImg) - 15);
  });
  document.getElementById('img-tb-grow').addEventListener('mousedown', e => {
    e.preventDefault(); setImgWidth(imgWidthPct(_selectedImg) + 15);
  });
  document.getElementById('img-tb-25').addEventListener('mousedown', e => {
    e.preventDefault(); setImgWidth(25);
  });
  document.getElementById('img-tb-50').addEventListener('mousedown', e => {
    e.preventDefault(); setImgWidth(50);
  });
  document.getElementById('img-tb-75').addEventListener('mousedown', e => {
    e.preventDefault(); setImgWidth(75);
  });
  document.getElementById('img-tb-full').addEventListener('mousedown', e => {
    e.preventDefault(); setImgWidth(100);
  });
  document.getElementById('img-tb-delete').addEventListener('mousedown', e => {
    e.preventDefault();
    const img = _selectedImg;
    hideImgToolbar();
    if (img) { img.remove(); saveCurrentNote(); }
  });

  // Dismiss image toolbar on outside click
  document.addEventListener('mousedown', e => {
    const toolbar = document.getElementById('note-img-toolbar');
    if (!toolbar.contains(e.target) && e.target !== _selectedImg) {
      hideImgToolbar();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal(); closeQlModal(); hideImgToolbar(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && state.section === 'ideas') {
      e.preventDefault();
      saveCurrentNote();
    }
    // Delete selected image with Backspace/Delete
    if ((e.key === 'Backspace' || e.key === 'Delete') && _selectedImg) {
      e.preventDefault();
      const img = _selectedImg;
      hideImgToolbar();
      img.remove();
      saveCurrentNote();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  if (isAuthenticated()) {
    showApp();
  } else {
    showLogin();
  }
});
