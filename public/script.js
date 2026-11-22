/* ================= GLOBAL STATE ================= */
let currentUser = null;
let appointments = [];
let reports = [];
let advisories = [];
let users = [];
let services = [];
let categories = [];
let currentCoords = { lat: 14.6507, lng: 120.9841 };
let leafletMap = null;
let leafletMarker = null;
let currentTileLayer = null;
let isSatelliteView = false;
let watchId = null;
let pendingIncidentDraft = null;
let currentPhotoFile = null;
let pendingDeleteAction = null;

const CARTO_KEY = 'cb1_58w1_1_efbe66c1479a1ebcc0b40495';
const CARTO_STREET_URL = `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${CARTO_KEY}`;
const philippinesBounds = [[4.5, 116.8], [21.2, 126.8]];
const SPECIFY_SENTINEL = '__SPECIFY__';
const timeSlots = [
  '08:00 AM - 09:00 AM', '09:00 AM - 10:00 AM', '10:00 AM - 11:00 AM',
  '01:00 PM - 02:00 PM', '02:00 PM - 03:00 PM', '03:00 PM - 04:00 PM'
];

/* ================= API ================= */
const API = {
  token: localStorage.getItem('ugnay_token') || null,
  setToken(t) { this.token = t; localStorage.setItem('ugnay_token', t); },
  clear() { this.token = null; localStorage.removeItem('ugnay_token'); },
  async request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    let body = options.body;
    if (body && !(body instanceof FormData) && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch('/api' + path, { ...options, body, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { this.clear(); throw new Error(data.error || 'Unauthorized'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
};

/* ================= TOAST ================= */
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${message}</span>`;
  container.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 4200);
}

/* ================= PASSWORD TOGGLE ================= */
function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? '👁️' : '🙈';
  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  input.focus();
  const v = input.value;
  input.value = '';
  input.value = v;
}

/* ================= DELETE CONFIRM ================= */
function confirmDelete(message, action) {
  document.getElementById('confirmDeleteText').textContent = message;
  document.getElementById('confirmDeleteModal').classList.remove('hidden');
  pendingDeleteAction = action;
}
function closeConfirmDelete() {
  pendingDeleteAction = null;
  document.getElementById('confirmDeleteModal').classList.add('hidden');
}
document.addEventListener('click', function (e) {
  if (e.target && e.target.id === 'confirmDeleteBtn') {
    const act = pendingDeleteAction;
    pendingDeleteAction = null;
    document.getElementById('confirmDeleteModal').classList.add('hidden');
    if (act) act();
  }
});

async function deleteAppointment(id, ref) {
  confirmDelete(`Are you sure you want to delete appointment ${ref}? This action cannot be undone.`,
    async () => {
      try {
        await API.request(`/appointments/${id}`, { method: 'DELETE' });
        showToast(`Appointment ${ref} deleted`, 'success');
        await refreshAll();
      } catch (e) { showToast(e.message, 'error'); }
    });
}
async function deleteReport(id, ref) {
  confirmDelete(`Are you sure you want to delete incident report ${ref}? This action cannot be undone.`,
    async () => {
      try {
        await API.request(`/reports/${id}`, { method: 'DELETE' });
        showToast(`Report ${ref} deleted`, 'success');
        await refreshAll();
      } catch (e) { showToast(e.message, 'error'); }
    });
}
async function deleteUser(id, name) {
  confirmDelete(`Are you sure you want to delete the account "${name}"? This will also permanently delete all their appointments, incident reports, tasks, and custom services/categories. This action cannot be undone.`,
    async () => {
      try {
        await API.request(`/users/${id}`, { method: 'DELETE' });
        showToast(`Account "${name}" deleted`, 'success');
        await refreshAll();
        await renderAdminUsers();
      } catch (e) { showToast(e.message, 'error'); }
    });
}
async function deleteAdvisory(id, title) {
  confirmDelete(`Are you sure you want to delete advisory "${title}"? This action cannot be undone.`,
    async () => {
      try {
        await API.request(`/advisories/${id}`, { method: 'DELETE' });
        showToast('Advisory deleted', 'success');
        await refreshAll();
      } catch (e) { showToast(e.message, 'error'); }
    });
}

/* ================= DROPDOWN HANDLERS ================= */
function handleServiceSelectChange() {
  const sel = document.getElementById('apptService');
  const custom = document.getElementById('apptServiceCustom');
  if (!sel || !custom) return;
  if (sel.value === SPECIFY_SENTINEL) { custom.classList.remove('hidden'); setTimeout(() => custom.focus(), 50); }
  else custom.classList.add('hidden');
}
function handleCategorySelectChange() {
  const sel = document.getElementById('incCategory');
  const custom = document.getElementById('incCategoryCustom');
  if (!sel || !custom) return;
  if (sel.value === SPECIFY_SENTINEL) { custom.classList.remove('hidden'); setTimeout(() => custom.focus(), 50); }
  else custom.classList.add('hidden');
}

function rebuildServiceDropdown() {
  const sel = document.getElementById('apptService');
  if (!sel) return;
  const curr = sel.value;
  sel.innerHTML = '';
  services.forEach(s => {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = (s.created_by === currentUser.id) ? `${s.name} (custom)` : s.name;
    sel.appendChild(o);
  });
  const spec = document.createElement('option');
  spec.value = SPECIFY_SENTINEL;
  spec.textContent = '➕ If not listed, please specify…';
  sel.appendChild(spec);
  if (curr && [...sel.options].some(o => o.value === curr)) sel.value = curr;
  const custom = document.getElementById('apptServiceCustom');
  if (custom) { if (sel.value === SPECIFY_SENTINEL) custom.classList.remove('hidden'); else custom.classList.add('hidden'); }
}

function rebuildCategoryDropdown() {
  const sel = document.getElementById('incCategory');
  if (!sel) return;
  const curr = sel.value;
  sel.innerHTML = '';
  categories.forEach(c => {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = (c.created_by === currentUser.id) ? `${c.name} (custom)` : c.name;
    sel.appendChild(o);
  });
  const spec = document.createElement('option');
  spec.value = SPECIFY_SENTINEL;
  spec.textContent = '➕ If not listed, please specify…';
  sel.appendChild(spec);
  if (curr && [...sel.options].some(o => o.value === curr)) sel.value = curr;
  const custom = document.getElementById('incCategoryCustom');
  if (custom) { if (sel.value === SPECIFY_SENTINEL) custom.classList.remove('hidden'); else custom.classList.add('hidden'); }
}

function updateManageLinksVisibility() {
  if (!currentUser) return;
  const mySvc = services.filter(s => s.created_by === currentUser.id);
  const myCat = categories.filter(c => c.created_by === currentUser.id);
  const svcLink = document.getElementById('manageServicesLink');
  if (svcLink) svcLink.classList.toggle('hidden', mySvc.length === 0);
  const catLink = document.getElementById('manageCategoriesLink');
  if (catLink) catLink.classList.toggle('hidden', myCat.length === 0);
}

/* ================= CUSTOM MODALS ================= */
function openCustomServices() {
  document.getElementById('customServicesModal').classList.remove('hidden');
  renderCustomServicesList();
}
function closeCustomServices() { document.getElementById('customServicesModal').classList.add('hidden'); }
async function renderCustomServicesList() {
  const list = document.getElementById('customServicesList');
  list.innerHTML = '';
  const custom = services.filter(s => s.created_by === currentUser.id);
  if (custom.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted); font-size:0.82rem;">You have no saved custom services.</p>';
    return;
  }
  custom.forEach(s => {
    list.innerHTML += `
      <div class="record-item" style="padding:0.65rem;">
        <div class="record-top">
          <div><h4 style="color:var(--navy-blue); font-size:0.88rem; margin:0;">${s.name}</h4>
            ${s.description ? `<p style="font-size:0.75rem; color:var(--text-muted); margin-top:0.15rem;">${s.description}</p>` : ''}</div>
          <button class="btn btn-delete btn-sm" onclick="deleteCustomService(${s.id})">🗑 Delete</button>
        </div>
      </div>`;
  });
}
async function deleteCustomService(id) {
  confirmDelete('Are you sure you want to delete this custom service? Past appointments keep their history, but the service will no longer appear in your dropdown.',
    async () => {
      try {
        const r = await API.request(`/services/${id}`, { method: 'DELETE' });
        showToast(r.soft ? 'Service hidden (used in past appointments)' : 'Custom service deleted', 'success');
        await refreshAll();
        await renderCustomServicesList();
      } catch (e) { showToast(e.message, 'error'); }
    });
}

function openCustomCategories() {
  document.getElementById('customCategoriesModal').classList.remove('hidden');
  renderCustomCategoriesList();
}
function closeCustomCategories() { document.getElementById('customCategoriesModal').classList.add('hidden'); }
async function renderCustomCategoriesList() {
  const list = document.getElementById('customCategoriesList');
  list.innerHTML = '';
  const custom = categories.filter(c => c.created_by === currentUser.id);
  if (custom.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted); font-size:0.82rem;">You have no saved custom categories.</p>';
    return;
  }
  custom.forEach(c => {
    list.innerHTML += `
      <div class="record-item" style="padding:0.65rem;">
        <div class="record-top">
          <div><h4 style="color:var(--navy-blue); font-size:0.88rem; margin:0;">${c.name}</h4></div>
          <button class="btn btn-delete btn-sm" onclick="deleteCustomCategory(${c.id})">🗑 Delete</button>
        </div>
      </div>`;
  });
}
async function deleteCustomCategory(id) {
  confirmDelete('Are you sure you want to delete this custom category? Past reports keep their history, but the category will no longer appear in your dropdown.',
    async () => {
      try {
        const r = await API.request(`/categories/${id}`, { method: 'DELETE' });
        showToast(r.soft ? 'Category hidden (used in past reports)' : 'Custom category deleted', 'success');
        await refreshAll();
        await renderCustomCategoriesList();
      } catch (e) { showToast(e.message, 'error'); }
    });
}

/* ================= BOOT ================= */
window.onload = async function () {
  const dateInput = document.getElementById('apptDate');
  if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
  if (API.token) {
    try {
      const { user } = await API.request('/auth/me');
      currentUser = user;
      await enterDashboard();
    } catch { API.clear(); }
  }
};
function goHome() {
  if (!currentUser) {
    document.getElementById('dashboardView').classList.add('hidden');
    document.getElementById('authView').classList.remove('hidden');
    toggleAuthForm('login');
    return;
  }
  const home = { Resident: 'resTabOverview', Admin: 'admTabIncidents', Responder: 'rspTabTasks' }[currentUser.role];
  switchRoleTab(home);
}

/* ================= AUTH ================= */
function fillDemoLogin(email) {
  document.getElementById('loginEmail').value = email;
  document.getElementById('loginPassword').value = 'password123';
}
function toggleAuthForm(mode) {
  const l = document.getElementById('loginFormContainer');
  const r = document.getElementById('registerFormContainer');
  if (mode === 'register') { l.classList.add('hidden'); r.classList.remove('hidden'); }
  else { r.classList.add('hidden'); l.classList.remove('hidden'); }
}
function selectRegisterRole(role, el) {
  document.getElementById('selectedRole').value = role;
  document.querySelectorAll('.role-option').forEach(o => o.classList.remove('active'));
  el.classList.add('active');
}
async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  try {
    const data = await API.request('/auth/login', { method: 'POST', body: { email, password } });
    API.setToken(data.token);
    currentUser = data.user;
    showToast(`Welcome back, ${currentUser.name}!`, 'success');
    await enterDashboard();
  } catch (err) { showToast(err.message, 'error'); }
}
async function handleRegisterSubmit(e) {
  e.preventDefault();
  if (!document.getElementById('dpaConsent').checked) {
    showToast('You must consent to the Data Privacy Act (RA 10173).', 'error'); return;
  }
  const payload = {
    name: document.getElementById('regFullName').value.trim(),
    email: document.getElementById('regEmail').value.trim(),
    password: document.getElementById('regPassword').value,
    role: document.getElementById('selectedRole').value,
    dpaConsent: true,
    emailOptin: document.getElementById('emailAdvisory').checked
  };
  try {
    await API.request('/auth/register', { method: 'POST', body: payload });
    showToast('Account registered! You may now sign in.', 'success');
    document.getElementById('registerForm').reset();
    toggleAuthForm('login');
    document.getElementById('loginEmail').value = payload.email;
  } catch (err) { showToast(err.message, 'error'); }
}
function handleLogout() {
  currentUser = null; API.clear();
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  document.getElementById('dashboardView').classList.add('hidden');
  document.getElementById('headerUserControls').classList.add('hidden');
  document.getElementById('mobileBottomNav').classList.add('hidden');
  document.getElementById('authView').classList.remove('hidden');
  showToast('Signed out successfully', 'info');
}

/* ================= DASHBOARD ================= */
async function enterDashboard() {
  document.getElementById('authView').classList.add('hidden');
  document.getElementById('dashboardView').classList.remove('hidden');
  document.getElementById('headerUserControls').classList.remove('hidden');
  document.getElementById('mobileBottomNav').classList.remove('hidden');
  document.getElementById('headerRoleBadge').textContent = currentUser.role.toUpperCase();
  document.getElementById('userGreeting').textContent = `Logged in as ${currentUser.name} • Role: ${currentUser.role}`;
  document.getElementById('residentWorkspace').classList.add('hidden');
  document.getElementById('adminWorkspace').classList.add('hidden');
  document.getElementById('responderWorkspace').classList.add('hidden');

  if (currentUser.role === 'Resident') {
    document.getElementById('residentWorkspace').classList.remove('hidden');
    buildNavigation([
      { id: 'resTabOverview', icon: '📊', label: 'Dashboard' },
      { id: 'resTabBook', icon: '📅', label: 'Book Appt' },
      { id: 'resTabReport', icon: '🚨', label: 'Report' },
      { id: 'resTabAdvisories', icon: '📢', label: 'Advisories' }
    ]);
  } else if (currentUser.role === 'Admin') {
    document.getElementById('adminWorkspace').classList.remove('hidden');
    buildNavigation([
      { id: 'admTabIncidents', icon: '🛡️', label: 'Reports & AI' },
      { id: 'admTabAppointments', icon: '📋', label: 'Appointments' },
      { id: 'admTabAdvisories', icon: '📣', label: 'Advisories' },
      { id: 'admTabUsers', icon: '👥', label: 'Accounts' }
    ]);
  } else {
    document.getElementById('responderWorkspace').classList.remove('hidden');
    buildNavigation([{ id: 'rspTabTasks', icon: '🚑', label: 'My Tasks' }]);
  }
  await refreshAll();
}
function buildNavigation(tabs) {
  const d = document.getElementById('desktopNav');
  const m = document.getElementById('mobileBottomNavInner');
  d.innerHTML = ''; m.innerHTML = '';
  tabs.forEach((t, i) => {
    const db = document.createElement('button');
    db.className = `dash-nav-btn ${i === 0 ? 'active' : ''}`;
    db.dataset.tab = t.id;
    db.innerHTML = `<span>${t.icon}</span><span>${t.label}</span>`;
    db.onclick = () => switchRoleTab(t.id);
    d.appendChild(db);
    const mb = document.createElement('button');
    mb.className = `mob-nav-item ${i === 0 ? 'active' : ''}`;
    mb.dataset.tab = t.id;
    mb.innerHTML = `<span style="font-size:1.1rem;">${t.icon}</span><span>${t.label}</span>`;
    mb.onclick = () => switchRoleTab(t.id);
    m.appendChild(mb);
  });
  if (tabs.length) switchRoleTab(tabs[0].id);
}
async function switchRoleTab(tabId) {
  document.querySelectorAll('.role-tab').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById(tabId);
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('.dash-nav-btn, .mob-nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tabId));
  if (tabId === 'resTabReport') {
    setTimeout(() => { initIncidentMap(); if (leafletMap) leafletMap.invalidateSize(); }, 150);
  }
  if (tabId === 'resTabBook') await renderAvailableSlots();
  if (tabId === 'admTabUsers') await renderAdminUsers();
  await refreshAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ================= FETCH ================= */
async function refreshAll() {
  if (!currentUser) return;
  try {
    services = await API.request('/services');
    categories = await API.request('/categories');
    advisories = await API.request('/advisories');
    appointments = await API.request('/appointments');
    reports = await API.request('/reports');
    if (document.getElementById('apptService')) rebuildServiceDropdown();
    if (document.getElementById('incCategory')) rebuildCategoryDropdown();
    updateManageLinksVisibility();
    if (currentUser.role === 'Resident') renderResidentDashboard();
    if (currentUser.role === 'Admin') renderAdminDashboard();
    if (currentUser.role === 'Responder') renderResponderDashboard();
  } catch (e) { showToast(e.message, 'error'); }
}

/* ================= MAP ================= */
function initIncidentMap() {
  if (typeof L === 'undefined') return;
  if (!leafletMap) {
    leafletMap = L.map('incidentMap', {
      center: [12.8797, 121.7740], zoom: 6, minZoom: 5,
      maxBounds: philippinesBounds, maxBoundsViscosity: 0.8
    });
    currentTileLayer = L.tileLayer(CARTO_STREET_URL, {
      maxZoom: 19, attribution: '&copy; OSM &copy; CARTO | Philippines'
    }).addTo(leafletMap);
    leafletMarker = L.marker([currentCoords.lat, currentCoords.lng], {
      draggable: true, title: 'Drag to set incident location'
    }).addTo(leafletMap).bindPopup('Incident Location Pin');
    leafletMarker.on('dragend', e => {
      const p = e.target.getLatLng();
      updateMapCoordinates(p.lat, p.lng, null, true);
    });
    leafletMap.on('click', e => {
      leafletMarker.setLatLng(e.latlng);
      updateMapCoordinates(e.latlng.lat, e.latlng.lng, null, true);
    });
  } else leafletMap.invalidateSize();
}
function switchMapLayer() {
  if (!leafletMap) return;
  leafletMap.removeLayer(currentTileLayer);
  isSatelliteView = !isSatelliteView;
  currentTileLayer = isSatelliteView
    ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: '&copy; Esri' }).addTo(leafletMap)
    : L.tileLayer(CARTO_STREET_URL, { maxZoom: 19, attribution: '&copy; OSM &copy; CARTO' }).addTo(leafletMap);
  showToast(isSatelliteView ? 'Satellite view' : 'Street view', 'info');
}
function updateMapCoordinates(lat, lng, accuracy = null, fromUser = false) {
  currentCoords = { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
  document.getElementById('coordsDisplay').textContent = `Lat: ${currentCoords.lat}, Lng: ${currentCoords.lng}`;
  const pill = document.getElementById('boundaryStatusPill');
  if (!pill) return;
  if (accuracy !== null && Number.isFinite(accuracy)) { pill.className = 'boundary-pill'; pill.textContent = `✓ GPS lock (±${Math.round(accuracy)} m)`; }
  else if (fromUser) { pill.className = 'boundary-pill'; pill.textContent = '✓ Location pinned manually'; }
  else { pill.className = 'boundary-pill neutral'; pill.textContent = '📍 Tap the map, drag the pin, or use GPS'; }
}
function useRealGpsPin() {
  if (!navigator.geolocation) return showToast('Geolocation is not supported.', 'error');
  const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isSecure) return showToast('⚠️ GPS requires HTTPS. Open via https:// or localhost.', 'error');
  if (!leafletMap) { try { initIncidentMap(); } catch (e) {} }
  const btn = document.getElementById('gpsBtn');
  const orig = btn ? btn.textContent : '📍 Use My GPS';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Locating…'; }
  showToast('Acquiring GPS location…', 'info');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      if (leafletMap && leafletMarker) {
        leafletMap.setView([latitude, longitude], 18);
        leafletMarker.setLatLng([latitude, longitude]);
        leafletMarker.openPopup();
      }
      updateMapCoordinates(latitude, longitude, accuracy);
      document.getElementById('incAddress').value = `Lat ${latitude.toFixed(5)}, Lng ${longitude.toFixed(5)} — verify and edit the exact address`;
      showToast(`📍 GPS locked (±${Math.round(accuracy)} m)`, 'success');
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    },
    (err) => {
      let msg;
      switch (err.code) {
        case err.PERMISSION_DENIED: msg = '❌ GPS denied. Enable location permission for this site.'; break;
        case err.POSITION_UNAVAILABLE: msg = '❌ GPS unavailable. Turn on Windows/phone Location.'; break;
        case err.TIMEOUT: msg = '⏱ GPS timed out. Tap the map manually.'; break;
        default: msg = 'GPS error: ' + (err.message || 'unknown');
      }
      showToast(msg, 'error');
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}
function toggleLiveTracking() {
  const btn = document.getElementById('trackLiveBtn');
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (btn) btn.textContent = '🛰️ Track Live';
    showToast('Live tracking stopped.', 'info');
    return;
  }
  if (!navigator.geolocation) return showToast('Geolocation is not supported.', 'error');
  const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isSecure) return showToast('GPS requires HTTPS.', 'error');
  if (!leafletMap) initIncidentMap();
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      if (leafletMap && leafletMarker) {
        leafletMap.setView([latitude, longitude], 18);
        leafletMarker.setLatLng([latitude, longitude]);
      }
      updateMapCoordinates(latitude, longitude, accuracy);
    },
    (err) => {
      showToast('Tracking error: ' + (err.message || 'unknown'), 'error');
      watchId = null;
      if (btn) btn.textContent = '🛰️ Track Live';
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
  if (btn) btn.textContent = '⏹️ Stop Tracking';
  showToast('Live GPS tracking started.', 'success');
}

/* ================= RESIDENT ================= */
async function renderAvailableSlots() {
  const date = document.getElementById('apptDate').value;
  const slotGrid = document.getElementById('slotGrid');
  if (!slotGrid) return;
  slotGrid.innerHTML = '';
  if (!date) return;
  try {
    const { taken } = await API.request(`/appointments/slots?date=${encodeURIComponent(date)}`);
    let first = null;
    timeSlots.forEach(slot => {
      const isTaken = taken.includes(slot);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `slot-btn ${isTaken ? 'taken' : ''}`;
      b.textContent = isTaken ? `${slot} (Taken)` : slot;
      b.disabled = isTaken;
      if (!isTaken) {
        if (!first) first = slot;
        b.onclick = () => {
          document.querySelectorAll('.slot-btn').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          document.getElementById('selectedTimeSlot').value = slot;
        };
      }
      slotGrid.appendChild(b);
    });
    if (first) {
      document.getElementById('selectedTimeSlot').value = first;
      [...slotGrid.children].find(b => !b.disabled)?.classList.add('active');
    } else document.getElementById('selectedTimeSlot').value = '';
  } catch (e) { showToast(e.message, 'error'); }
}

async function resolveServiceId() {
  const v = document.getElementById('apptService').value;
  if (v === SPECIFY_SENTINEL) {
    const customName = document.getElementById('apptServiceCustom').value.trim();
    if (!customName) { showToast('Please type the name of the service you need.', 'error'); return null; }
    const existing = services.find(s => s.created_by === currentUser.id && s.name.toLowerCase() === customName.toLowerCase());
    if (existing) return existing.id;
    try {
      const created = await API.request('/services', { method: 'POST', body: { name: customName } });
      services = await API.request('/services');
      return created.id;
    } catch (err) { showToast(err.message, 'error'); return null; }
  }
  const found = services.find(s => s.name === v);
  if (!found) { showToast('Please select a valid service.', 'error'); return null; }
  return found.id;
}
async function resolveCategoryId() {
  const v = document.getElementById('incCategory').value;
  if (v === SPECIFY_SENTINEL) {
    const customName = document.getElementById('incCategoryCustom').value.trim();
    if (!customName) { showToast('Please type the incident category name.', 'error'); return null; }
    const existing = categories.find(c => c.created_by === currentUser.id && c.name.toLowerCase() === customName.toLowerCase());
    if (existing) return existing.id;
    try {
      const created = await API.request('/categories', { method: 'POST', body: { name: customName } });
      categories = await API.request('/categories');
      return created.id;
    } catch (err) { showToast(err.message, 'error'); return null; }
  }
  const found = categories.find(c => c.name === v);
  if (!found) { showToast('Please select a valid category.', 'error'); return null; }
  return found.id;
}

async function handleBookAppointment(e) {
  e.preventDefault();
  const serviceId = await resolveServiceId();
  if (!serviceId) return;
  const payload = {
    serviceId,
    appointmentDate: document.getElementById('apptDate').value,
    timeSlot: document.getElementById('selectedTimeSlot').value,
    purpose: document.getElementById('apptPurpose').value.trim()
  };
  if (!payload.timeSlot) return showToast('Select a time slot.', 'error');
  try {
    const r = await API.request('/appointments', { method: 'POST', body: payload });
    showToast(`Appointment booked! Ref: ${r.reference_no}`, 'success');
    document.getElementById('apptPurpose').value = '';
    const svcSel = document.getElementById('apptService');
    if (svcSel) { svcSel.selectedIndex = 0; document.getElementById('apptServiceCustom').value = ''; document.getElementById('apptServiceCustom').classList.add('hidden'); }
    await refreshAll();
    switchRoleTab('resTabOverview');
  } catch (err) { showToast(err.message, 'error'); }
}

function handlePhotoSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  currentPhotoFile = file;
  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById('photoPreviewImg').src = ev.target.result;
    document.getElementById('photoFileName').textContent = file.name;
    document.getElementById('photoPreviewContainer').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

async function handleSubmitIncident(e) {
  e.preventDefault();
  const categoryId = await resolveCategoryId();
  if (!categoryId) return;
  const address = document.getElementById('incAddress').value.trim();
  if (!address) { showToast('Please enter the exact address.', 'error'); return; }
  const payload = {
    categoryId,
    type: document.getElementById('incType').value,
    address,
    description: document.getElementById('incDescription').value.trim(),
    latitude: currentCoords.lat, longitude: currentCoords.lng
  };
  try {
    const nearby = await API.request(`/reports/nearby?categoryId=${categoryId}&lat=${payload.latitude}&lng=${payload.longitude}`);
    if (nearby.length > 0) {
      pendingIncidentDraft = { payload, existing: nearby[0] };
      const catName = categories.find(c => c.id === categoryId)?.name || 'category';
      document.getElementById('duplicateModalText').textContent =
        `An active "${catName}" report (${nearby[0].reference_no} at ${nearby[0].address}) was found within 100 meters. Is this the same problem?`;
      document.getElementById('duplicateModal').classList.remove('hidden');
      return;
    }
    await submitIncident(payload);
  } catch (err) { showToast(err.message, 'error'); }
}

async function resolveDuplicateChoice(append) {
  document.getElementById('duplicateModal').classList.add('hidden');
  if (!pendingIncidentDraft) return;
  const { payload, existing } = pendingIncidentDraft;
  pendingIncidentDraft = null;
  if (append) {
    try {
      const fd = new FormData();
      Object.entries({ ...payload, appendToId: existing.id }).forEach(([k, v]) => fd.append(k, v));
      await API.request('/reports', { method: 'POST', body: fd });
      showToast(`Appended update to ${existing.reference_no}`, 'info');
      resetIncidentForm(); await refreshAll(); switchRoleTab('resTabOverview');
    } catch (err) { showToast(err.message, 'error'); }
  } else await submitIncident(payload);
}

async function submitIncident(payload) {
  try {
    const fd = new FormData();
    Object.entries(payload).forEach(([k, v]) => fd.append(k, v));
    if (currentPhotoFile) fd.append('photo', currentPhotoFile);
    showToast('Submitting report and running AI screening…', 'info');
    const r = await API.request('/reports', { method: 'POST', body: fd });
    showToast(r.ai_flag_count > 0
      ? `Report submitted! Ref: ${r.reference_no} — AI flagged for review`
      : `Report submitted! Ref: ${r.reference_no}`,
      r.ai_flag_count > 0 ? 'info' : 'success');
    resetIncidentForm();
    await refreshAll();
    switchRoleTab('resTabOverview');
  } catch (err) { showToast(err.message, 'error'); }
}

function resetIncidentForm() {
  document.getElementById('incDescription').value = '';
  document.getElementById('incAddress').value = '';
  document.getElementById('incCategoryCustom').value = '';
  document.getElementById('photoPreviewContainer').classList.add('hidden');
  currentPhotoFile = null;
  const p = document.getElementById('incPhotoInput'); if (p) p.value = '';
  const catSel = document.getElementById('incCategory');
  if (catSel) { catSel.selectedIndex = 0; document.getElementById('incCategoryCustom').classList.add('hidden'); }
  const pill = document.getElementById('boundaryStatusPill');
  if (pill) { pill.className = 'boundary-pill neutral'; pill.textContent = '📍 Tap the map, drag the pin, or use GPS'; }
}

function renderResidentDashboard() {
  const myAppts = appointments, myReports = reports;
  document.getElementById('resKpiAppts').textContent = myAppts.length;
  document.getElementById('resKpiReports').textContent = myReports.length;
  document.getElementById('resKpiPending').textContent =
    myAppts.filter(a => a.status === 'PENDING').length + myReports.filter(r => r.status === 'PENDING').length;
  document.getElementById('resKpiAdvisories').textContent = advisories.length;

  const al = document.getElementById('resAppointmentsList');
  al.innerHTML = myAppts.length ? '' : '<p style="color:var(--text-muted); font-size:0.875rem;">No appointments yet.</p>';
  myAppts.forEach(a => {
    const bc = a.status === 'APPROVED' ? 'badge-approved' : a.status === 'REJECTED' ? 'badge-rejected' : 'badge-pending';
    const canDelete = ['PENDING', 'REJECTED'].includes(a.status);
    al.innerHTML += `
      <div class="record-item"><div class="record-top">
        <div><span class="ref-code">${a.reference_no}</span>
          <h4 style="margin-top:.35rem;color:var(--navy-blue);font-size:.98rem;">${a.service}</h4></div>
        <span class="badge ${bc}">${a.status}</span></div>
        <div class="record-meta"><span>📅 ${a.appointment_date}</span><span>⏰ ${a.time_slot}</span></div>
        <p style="font-size:.83rem;">Purpose: ${a.purpose}</p>
        <div class="record-actions">
          ${canDelete
            ? `<button class="btn btn-delete btn-sm" onclick="deleteAppointment(${a.id}, '${a.reference_no}')">🗑 Delete</button>`
            : `<span style="font-size:.72rem; color:var(--text-muted);">🔒 Cannot delete — appointment is ${a.status.toLowerCase()}. Contact the barangay hall to reschedule.</span>`}
        </div></div>`;
  });

  const rl = document.getElementById('resReportsList');
  rl.innerHTML = myReports.length ? '' : '<p style="color:var(--text-muted); font-size:.875rem;">No reports yet.</p>';
  myReports.forEach(r => {
    const bc = r.status === 'RESOLVED' ? 'badge-resolved' : r.status === 'DISPATCHED' ? 'badge-dispatched' : r.status === 'VERIFIED' ? 'badge-verified' : r.status === 'REJECTED' ? 'badge-rejected' : 'badge-pending';
    const canDelete = ['PENDING', 'REJECTED'].includes(r.status);
    rl.innerHTML += `
      <div class="record-item"><div class="record-top">
        <div><span class="ref-code">${r.reference_no}</span>
          <h4 style="margin-top:.35rem;color:var(--navy-blue);font-size:.98rem;">${r.category}</h4></div>
        <span class="badge ${bc}">${r.status}</span></div>
        <div class="record-meta"><span>📍 ${r.address}</span>${r.updates_count > 0 ? `<span>🔄 +${r.updates_count} update(s)</span>` : ''}</div>
        <p style="font-size:.83rem;">${r.description}</p>
        <div><span class="ai-tag ${r.ai_flag_count > 0 ? 'flagged' : 'clean'}">${r.ai_summary || 'No AI result'}</span></div>
        <div class="record-actions">
          ${canDelete
            ? `<button class="btn btn-delete btn-sm" onclick="deleteReport(${r.id}, '${r.reference_no}')">🗑 Delete</button>`
            : `<span style="font-size:.72rem; color:var(--text-muted);">🔒 Cannot delete — report is ${r.status.toLowerCase()} and being processed. Contact the barangay hall if you need to retract it.</span>`}
        </div></div>`;
  });

  const advList = document.getElementById('resAdvisoriesList');
  advList.innerHTML = '';
  advisories.forEach(adv => {
    const bc = adv.severity === 'EMERGENCY' ? 'badge-flagged' : adv.severity === 'WARNING' ? 'badge-pending' : 'badge-verified';
    advList.innerHTML += `
      <div class="record-item"><div class="record-top">
        <h4 style="color:var(--navy-blue);font-size:1rem;">${adv.title}</h4>
        <span class="badge ${bc}">${adv.severity}</span></div>
        <p style="font-size:.85rem;line-height:1.5;">${adv.body}</p>
        <div class="record-meta"><span>Posted: ${adv.created_at}</span></div></div>`;
  });
}

/* ================= ADMIN ================= */
function renderAdminDashboard() {
  document.getElementById('admKpiReports').textContent = reports.filter(r => r.status !== 'RESOLVED').length;
  document.getElementById('admKpiFlagged').textContent = reports.filter(r => r.ai_flag_count > 0).length;
  document.getElementById('admKpiAppts').textContent = appointments.filter(a => a.status === 'PENDING').length;
  document.getElementById('admKpiResolved').textContent = reports.filter(r => r.status === 'RESOLVED').length;

  const rl = document.getElementById('adminReportsList');
  rl.innerHTML = '';
  reports.forEach(r => {
    const bc = r.status === 'RESOLVED' ? 'badge-resolved' : r.status === 'DISPATCHED' ? 'badge-dispatched' : r.status === 'VERIFIED' ? 'badge-verified' : r.status === 'REJECTED' ? 'badge-rejected' : 'badge-pending';
    let actions = '';
    if (r.status === 'PENDING') actions = `
      <button class="btn btn-primary btn-sm" onclick="adminAction(${r.id},'verify')">✓ Verify</button>
      <button class="btn btn-danger btn-sm" onclick="adminAction(${r.id},'reject')">✕ Dismiss</button>`;
    else if (r.status === 'VERIFIED') actions = `
      <button class="btn btn-warning btn-sm" onclick="adminAction(${r.id},'assign')">🚑 Assign Responder</button>`;
    else if (r.status === 'DISPATCHED' && r.task_status === 'DONE') actions = `
      <button class="btn btn-success btn-sm" onclick="adminAction(${r.id},'resolve')">✅ Confirm Resolved</button>
      <button class="btn btn-outline btn-sm" onclick="adminAction(${r.id},'return')">↩ Return</button>`;
    rl.innerHTML += `
      <div class="record-item"><div class="record-top">
        <div><span class="ref-code">${r.reference_no}</span>
          <h4 style="margin-top:.35rem;color:var(--navy-blue);">${r.category} <span style="font-weight:500;font-size:.82rem;color:var(--text-muted);">by ${r.reporter_name}</span></h4></div>
        <span class="badge ${bc}">${r.status}${r.task_status === 'DONE' && r.status !== 'RESOLVED' ? ' (PROOF READY)' : ''}</span></div>
        <div class="record-meta"><span>📍 ${r.address} (${r.latitude}, ${r.longitude})</span>${r.responder_name ? `<span>👮 ${r.responder_name}</span>` : ''}</div>
        <p style="font-size:.85rem;">${r.description}</p>
        ${r.photo_path ? `<a href="${r.photo_path}" target="_blank" style="font-size:.78rem;">📷 View evidence photo</a>` : ''}
        <div><span class="ai-tag ${r.ai_flag_count > 0 ? 'flagged' : 'clean'}">${r.ai_summary || 'No AI result'}</span></div>
        ${r.task_proof ? `<div style="font-size:.8rem;color:#047857;background:#ecfdf5;padding:.45rem .65rem;border-radius:6px;">📎 Proof: ${r.task_proof}</div>` : ''}
        <div class="record-actions">${actions}<button class="btn btn-delete btn-sm" onclick="deleteReport(${r.id}, '${r.reference_no}')">🗑 Delete</button></div></div>`;
  });

  const al = document.getElementById('adminAppointmentsList');
  al.innerHTML = '';
  appointments.forEach(a => {
    const bc = a.status === 'APPROVED' ? 'badge-approved' : a.status === 'REJECTED' ? 'badge-rejected' : 'badge-pending';
    al.innerHTML += `
      <div class="record-item"><div class="record-top">
        <div><span class="ref-code">${a.reference_no}</span>
          <h4 style="margin-top:.35rem;color:var(--navy-blue);">${a.service} — ${a.resident_name}</h4></div>
        <span class="badge ${bc}">${a.status}</span></div>
        <div class="record-meta"><span>📅 ${a.appointment_date}</span><span>⏰ ${a.time_slot}</span></div>
        <p style="font-size:.84rem;">Purpose: ${a.purpose}</p>
        <div class="record-actions">
          ${a.status === 'PENDING' ? `
            <button class="btn btn-success btn-sm" onclick="adminUpdateAppt(${a.id},'APPROVED')">✓ Approve</button>
            <button class="btn btn-danger btn-sm" onclick="adminUpdateAppt(${a.id},'REJECTED')">✕ Reject</button>` : ''}
          <button class="btn btn-delete btn-sm" onclick="deleteAppointment(${a.id}, '${a.reference_no}')">🗑 Delete</button>
        </div></div>`;
  });

  const advl = document.getElementById('adminAdvisoriesList');
  advl.innerHTML = '';
  advisories.forEach(adv => {
    advl.innerHTML += `
      <div class="record-item"><div class="record-top">
        <h4 style="color:var(--navy-blue);font-size:.95rem;">${adv.title}</h4>
        <span class="badge badge-verified">${adv.severity}</span></div>
        <p style="font-size:.82rem;">${adv.body}</p>
        <div class="record-meta"><span>${adv.created_at}</span></div>
        <div class="record-actions">
          <button class="btn btn-delete btn-sm" onclick="deleteAdvisory(${adv.id}, '${(adv.title || '').replace(/'/g, "\\'")}')">🗑 Delete Advisory</button>
        </div></div>`;
  });
}

async function renderAdminUsers() {
  try {
    users = await API.request('/users');
    const c = document.getElementById('adminUsersList');
    c.innerHTML = '';
    if (users.length === 0) { c.innerHTML = '<p style="color:var(--text-muted);">No accounts.</p>'; return; }
    users.forEach(u => {
      const roleBadge = u.role === 'Admin' ? 'badge-verified' : u.role === 'Responder' ? 'badge-dispatched' : 'badge-pending';
      const statusClass = u.account_status === 'ACTIVE' ? 'active' : u.account_status === 'SUSPENDED' ? 'suspended' : 'disabled';
      const statusIcon = u.account_status === 'ACTIVE' ? '✅' : u.account_status === 'SUSPENDED' ? '⏸' : '🚫';
      const lastActive = formatLastActive(u.last_active_at);
      const isSelf = u.id === currentUser.id;
      const safeName = (u.name || '').replace(/'/g, "\\'");
      c.innerHTML += `
        <div class="record-item">
          <div class="record-top">
            <div>
              <span class="ref-code">#${u.id}</span>
              <h4 style="margin-top:.35rem;color:var(--navy-blue);">${u.name}${isSelf ? ' <span style="font-size:.75rem;color:var(--text-muted);">(you)</span>' : ''}</h4>
              <div class="record-meta" style="margin-top:.25rem;"><span>📧 ${u.email}</span></div>
            </div>
            <span class="badge ${roleBadge}">${u.role.toUpperCase()}</span>
          </div>
          <div class="record-meta">
            <span class="user-status-pill ${statusClass}">${statusIcon} ${u.account_status}</span>
            <span>🕐 Active ${lastActive}</span>
            <span>📅 Registered ${new Date(u.created_at).toLocaleDateString()}</span>
          </div>
          ${!isSelf ? `<div class="record-actions"><button class="btn btn-delete btn-sm" onclick="deleteUser(${u.id}, '${safeName}')">🗑 Delete Account</button></div>` : ''}
        </div>`;
    });
  } catch (e) { showToast(e.message, 'error'); }
}
function formatLastActive(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

async function adminAction(id, action) {
  try {
    await API.request(`/reports/${id}/${action}`, { method: 'PATCH', body: {} });
    showToast(`Report ${action}ed`, 'success');
    await refreshAll();
  } catch (e) { showToast(e.message, 'error'); }
}
async function adminUpdateAppt(id, status) {
  try {
    await API.request(`/appointments/${id}`, { method: 'PATCH', body: { status } });
    showToast(`Appointment ${status.toLowerCase()}`, 'success');
    await refreshAll();
  } catch (e) { showToast(e.message, 'error'); }
}
async function handlePublishAdvisory(e) {
  e.preventDefault();
  const payload = {
    title: document.getElementById('advTitle').value.trim(),
    severity: document.getElementById('advSeverity').value,
    body: document.getElementById('advBody').value.trim()
  };
  try {
    const r = await API.request('/advisories', { method: 'POST', body: payload });
    showToast(`Advisory published • ${r.queued_emails} email(s) queued`, 'success');
    document.getElementById('advTitle').value = '';
    document.getElementById('advBody').value = '';
    await refreshAll();
  } catch (e) { showToast(e.message, 'error'); }
}

/* ================= RESPONDER ================= */
function renderResponderDashboard() {
  const tasks = reports;
  document.getElementById('rspKpiAssigned').textContent = tasks.filter(t => t.task_status === 'ASSIGNED').length;
  document.getElementById('rspKpiProgress').textContent = tasks.filter(t => t.task_status === 'IN_PROGRESS').length;
  document.getElementById('rspKpiDone').textContent = tasks.filter(t => t.task_status === 'DONE' || t.status === 'RESOLVED').length;
  document.getElementById('rspKpiUrgent').textContent = tasks.filter(t => t.status !== 'RESOLVED').length;

  const l = document.getElementById('responderTasksList');
  l.innerHTML = tasks.length ? '' : '<p style="color:var(--text-muted);">No tasks assigned.</p>';
  tasks.forEach(t => {
    const bc = t.status === 'RESOLVED' ? 'badge-resolved' : t.task_status === 'DONE' ? 'badge-verified' : 'badge-dispatched';
    let controls = '';
    if (t.task_status === 'ASSIGNED') controls = `<button class="btn btn-primary btn-sm" onclick="responderStart(${t.id})">▶ Start Field Response</button>`;
    else if (t.task_status === 'IN_PROGRESS') controls = `
      <input type="text" id="proofNote_${t.id}" class="form-control" style="max-width:300px;min-height:38px;font-size:.82rem;" placeholder="Resolution note…" value="Clearing completed & area secured">
      <button class="btn btn-success btn-sm" onclick="responderDone(${t.id})">📸 Upload Proof & Mark Done</button>`;
    l.innerHTML += `
      <div class="record-item"><div class="record-top">
        <div><span class="ref-code">${t.reference_no}</span>
          <h4 style="margin-top:.35rem;color:var(--navy-blue);">${t.category}</h4></div>
        <span class="badge ${bc}">${t.status === 'RESOLVED' ? 'RESOLVED' : t.task_status}</span></div>
        <div class="record-meta"><span>📍 ${t.address} (${t.latitude}, ${t.longitude})</span><span>👤 ${t.reporter_name}</span></div>
        <p style="font-size:.85rem;">${t.description}</p>
        ${t.task_proof ? `<div style="font-size:.8rem;color:#047857;background:#ecfdf5;padding:.45rem .65rem;border-radius:6px;">📎 Proof: ${t.task_proof}</div>` : ''}
        ${controls ? `<div class="record-actions">${controls}</div>` : ''}</div>`;
  });
}
async function responderStart(id) {
  try { await API.request(`/reports/${id}/start`, { method: 'PATCH', body: {} }); showToast('Task started', 'info'); await refreshAll(); }
  catch (e) { showToast(e.message, 'error'); }
}
async function responderDone(id) {
  const note = document.getElementById(`proofNote_${id}`)?.value.trim() || 'Field photo proof uploaded';
  try {
    const fd = new FormData(); fd.append('proofNote', note);
    await API.request(`/reports/${id}/done`, { method: 'PATCH', body: fd });
    showToast('Proof uploaded • Awaiting admin confirmation', 'success');
    await refreshAll();
  } catch (e) { showToast(e.message, 'error'); }
}

/* ================= CSV ================= */
function withAuthDownload(event, url) {
  event.preventDefault();
  fetch(url, { headers: { 'Authorization': `Bearer ${API.token}` } })
    .then(r => r.blob())
    .then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = url.split('/').pop();
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch(() => showToast('Download failed', 'error'));
  return false;
}