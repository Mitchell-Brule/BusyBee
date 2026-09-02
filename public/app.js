const API_BASE = 'http://localhost:3000';
const IS_EXTENSION = typeof chrome !== 'undefined' && !!chrome.storage;

const STATUS_COLORS = {
    'Available': 'var(--available-dot)',
    'Available Soon': 'var(--soon-dot)',
    'Busy': 'var(--busy-dot)',
    'DND': 'var(--dnd-dot)'
};

const CATEGORY_PRESETS = {
    work: { before: 10, after: 10 },
    meal: { before: 0, after: 15 },
    sleep: { before: 30, after: 0 },
    activity: { before: 0, after: 20 },
    commute: { before: 5, after: 5 },
    custom: { before: null, after: null }
};

const AVATAR_PALETTE = ['#0891b2', '#7c3aed', '#c026d3', '#b45309', '#15803d', '#1d4ed8', '#be185d'];
const DAY_CODES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let currentUser = null;
let pollTimer = null;
let reminderTimer = null;
let currentNavDate = new Date();
let importedEventsCache = [];
let armedReminders = new Set();
let selectedDays = new Set();

// ---------------------------------------------------------------- storage
// The extension persists the session token via chrome.storage.local; the
// plain web app (same page, served from Express) uses localStorage. Same
// app.js runs unmodified in both.
const Storage = {
    async get(key) {
        if (IS_EXTENSION) return (await chrome.storage.local.get(key))[key] || null;
        return localStorage.getItem(key);
    },
    async set(key, value) {
        if (IS_EXTENSION) return chrome.storage.local.set({ [key]: value });
        localStorage.setItem(key, value);
    },
    async remove(key) {
        if (IS_EXTENSION) return chrome.storage.local.remove(key);
        localStorage.removeItem(key);
    }
};

async function getToken() { return Storage.get('bb_token'); }
async function setToken(t) { return Storage.set('bb_token', t); }
async function clearToken() { return Storage.remove('bb_token'); }

async function apiFetch(path, options = {}) {
    const token = await getToken();
    const headers = Object.assign({}, options.headers);
    if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res;
    try {
        res = await fetch(API_BASE + path, Object.assign({}, options, { headers }));
    } catch (err) {
        throw new Error('Can\'t reach the BusyBee server. Is it running on localhost:3000?');
    }

    if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/signup') {
        await clearToken();
        showAuth();
        throw new Error('Session expired. Please log in again.');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

function avatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}
function initials(name) {
    return (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function formatTime(iso, timezone) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
}
function isFreeStatus(status) { return status === 'Available' || status === 'Available Soon'; }

// ---------------------------------------------------------------- boot
document.addEventListener('DOMContentLoaded', init);

async function init() {
    if (!IS_EXTENSION) document.body.classList.add('is-webapp');

    populateTimezones();
    wireAuthForm();

    const token = await getToken();
    if (!token) return showAuth();

    try {
        const { user } = await apiFetch('/api/auth/me');
        currentUser = user;
        showApp();
    } catch (err) {
        showAuth();
    }
}

function showAuth() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
    document.getElementById('app-screen').hidden = true;
    document.getElementById('auth-screen').hidden = false;
}

async function showApp() {
    document.getElementById('auth-screen').hidden = true;
    document.getElementById('app-screen').hidden = false;

    document.getElementById('myAvatar').innerText = initials(currentUser.name);

    wireAppChrome();
    renderDayPicker();
    fillAccountForm();
    refreshMyStatus();
    await refreshReminderState();
    refreshFriends();
    fetchImportedEvents();
    renderCalendarSources();
    renderBlocks();

    if (!IS_EXTENSION && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { refreshMyStatus(); refreshFriends(); }, 20000);

    if (reminderTimer) clearInterval(reminderTimer);
    reminderTimer = setInterval(checkReminders, 30000);
    checkReminders();
}

function populateTimezones() {
    let zones;
    try { zones = Intl.supportedValuesOf('timeZone'); }
    catch (e) { zones = ['America/Vancouver', 'America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney']; }

    ['authTimezone', 'acctTimezone'].forEach(id => {
        const select = document.getElementById(id);
        const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
        zones.forEach(z => {
            const opt = document.createElement('option');
            opt.value = z; opt.innerText = z.replace(/_/g, ' ');
            if (z === guess) opt.selected = true;
            select.appendChild(opt);
        });
    });
}

// ---------------------------------------------------------------- auth
function wireAuthForm() {
    let mode = 'login';

    document.getElementById('tab-login').onclick = () => setMode('login');
    document.getElementById('tab-signup').onclick = () => setMode('signup');

    function setMode(next) {
        mode = next;
        document.getElementById('tab-login').classList.toggle('active', mode === 'login');
        document.getElementById('tab-signup').classList.toggle('active', mode === 'signup');
        document.getElementById('signup-fields').hidden = mode !== 'signup';
        document.getElementById('authSubmit').innerText = mode === 'login' ? 'Log in' : 'Create account';
        document.getElementById('authPassword').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
        hideAuthError();
    }

    document.getElementById('auth-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAuthError();

        const email = document.getElementById('authEmail').value.trim();
        const password = document.getElementById('authPassword').value;
        const submitBtn = document.getElementById('authSubmit');
        submitBtn.disabled = true;

        try {
            let data;
            if (mode === 'login') {
                data = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
            } else {
                const name = document.getElementById('authName').value.trim();
                const timezone = document.getElementById('authTimezone').value;
                if (!name) throw new Error('Enter your name.');
                data = await apiFetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, name, timezone }) });
            }
            await setToken(data.token);
            currentUser = data.user;
            showApp();
        } catch (err) {
            showAuthError(err.message);
        } finally {
            submitBtn.disabled = false;
        }
    });
}

function showAuthError(msg) { const el = document.getElementById('auth-error'); el.innerText = msg; el.hidden = false; }
function hideAuthError() { document.getElementById('auth-error').hidden = true; }

// ---------------------------------------------------------------- chrome (app shell)
function wireAppChrome() {
    document.getElementById('signOutBtn').onclick = async () => {
        await clearToken();
        currentUser = null;
        document.getElementById('auth-form').reset();
        showAuth();
    };

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('view-' + btn.dataset.view).classList.add('active');
        };
    });

    document.getElementById('dndSwitch').onclick = toggleDnd;

    document.getElementById('addFriendBtn').onclick = addFriend;
    document.getElementById('addFriendEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFriend(); });

    document.getElementById('importContactsBtn').onclick = importContacts;
    document.getElementById('contactsFile').addEventListener('change', (e) => {
        const label = document.querySelector('label[for="contactsFile"]');
        if (e.target.files.length) label.innerText = e.target.files[0].name;
    });

    document.getElementById('uploadBtn').onclick = uploadCalendar;
    document.getElementById('calendarFile').addEventListener('change', (e) => {
        const label = document.querySelector('label[for="calendarFile"]');
        if (e.target.files.length) label.innerText = e.target.files[0].name;
    });
    document.getElementById('prevMonth').onclick = () => { currentNavDate.setMonth(currentNavDate.getMonth() - 1); renderCalendarGrid(); };
    document.getElementById('nextMonth').onclick = () => { currentNavDate.setMonth(currentNavDate.getMonth() + 1); renderCalendarGrid(); };
    document.getElementById('addEventBtn').onclick = addManualEvent;

    document.getElementById('bufferBefore').oninput = (e) => document.getElementById('beforeVal').innerText = e.target.value;
    document.getElementById('bufferAfter').oninput = (e) => document.getElementById('afterVal').innerText = e.target.value;
    document.getElementById('saveBuffersBtn').onclick = saveBuffers;
    document.getElementById('saveAccountBtn').onclick = saveAccount;

    document.getElementById('addBlockBtn').onclick = addBlock;
}

// ---------------------------------------------------------------- status
async function refreshMyStatus() {
    try {
        const data = await apiFetch('/api/me/status');
        const color = STATUS_COLORS[data.availability.status] || 'var(--gray-300)';

        document.getElementById('myName').innerText = data.name;
        document.getElementById('myDot').style.background = color;
        document.getElementById('myStatusLabel').innerText = data.availability.status;

        let detail = `${data.localTime} · ${data.timezone}`;
        if (data.availability.validUntil) {
            detail = `${data.availability.reason} until ${formatTime(data.availability.validUntil, data.timezone)} · ${detail}`;
        }
        document.getElementById('myStatusDetail').innerText = detail;
        document.getElementById('dndSwitch').classList.toggle('on', data.dnd);

        document.getElementById('bufferBefore').value = data.bufferBefore;
        document.getElementById('beforeVal').innerText = data.bufferBefore;
        document.getElementById('bufferAfter').value = data.bufferAfter;
        document.getElementById('afterVal').innerText = data.bufferAfter;
    } catch (err) { /* transient - next poll retries */ }
}

async function toggleDnd() {
    const sw = document.getElementById('dndSwitch');
    const next = !sw.classList.contains('on');
    sw.classList.toggle('on', next);
    try { await apiFetch('/api/dnd', { method: 'POST', body: JSON.stringify({ dnd: next }) }); } catch (err) { /* ignore */ }
    refreshMyStatus();
}

// ---------------------------------------------------------------- reminders
async function refreshReminderState() {
    try {
        const data = await apiFetch('/api/reminders');
        armedReminders = new Set(data.targetIds);
    } catch (err) { /* ignore */ }
}

async function toggleReminder(targetId) {
    try {
        if (armedReminders.has(targetId)) {
            await apiFetch('/api/reminders/' + encodeURIComponent(targetId), { method: 'DELETE' });
            armedReminders.delete(targetId);
        } else {
            await apiFetch('/api/reminders', { method: 'POST', body: JSON.stringify({ targetId }) });
            armedReminders.add(targetId);
        }
        refreshFriends();
    } catch (err) { /* ignore */ }
}

async function checkReminders() {
    let data;
    try { data = await apiFetch('/api/reminders/check'); } catch (err) { return; }
    if (!data.ready || !data.ready.length) return;

    data.ready.forEach(r => {
        armedReminders.delete(r.targetId);
        notify(`${r.name} is free`, `Now showing: ${r.status}`);
    });
    refreshFriends();
}

function notify(title, body) {
    if (IS_EXTENSION && chrome.notifications) {
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message: body });
    } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body });
    }
}

// ---------------------------------------------------------------- friends
async function refreshFriends() {
    const list = document.getElementById('friendsList');
    try {
        const data = await apiFetch('/api/friends');
        if (!data.friends.length) {
            list.innerHTML = '<div class="empty-state">No contacts yet — add someone by email above.</div>';
            return;
        }
        list.innerHTML = data.friends.map(f => {
            const color = STATUS_COLORS[f.availability.status] || 'var(--gray-300)';
            let statusText = f.availability.status;
            if (f.availability.validUntil) statusText += ` · ${formatTime(f.availability.validUntil, f.timezone)}${f.availability.reason ? ' (' + f.availability.reason + ')' : ''}`;

            const armed = armedReminders.has(f.id);
            const free = isFreeStatus(f.availability.status);
            const callBtn = (free && f.phone)
                ? `<a class="call-link" href="tel:${f.phone}" title="Call ${f.name}"><svg class="icon" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.902.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.908.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg></a>`
                : '';
            const bellBtn = !free
                ? `<button class="bell-btn ${armed ? 'active' : ''}" title="${armed ? 'Cancel reminder' : 'Remind me when free'}" data-remind="${f.id}"><svg class="icon" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></button>`
                : '';

            return `
            <div class="row">
                <div class="avatar" style="background:${avatarColor(f.name)}">${initials(f.name)}</div>
                <div class="row-info">
                    <div class="row-name"><span class="dot" style="background:${color}"></span>${f.name}</div>
                    <div class="row-meta">${statusText}</div>
                    <div class="row-time">${f.localTime} · ${f.timezone}</div>
                </div>
                <div class="row-actions">
                    ${callBtn}${bellBtn}
                    <button class="remove-btn" title="Remove" data-id="${f.id}">
                        <svg class="icon" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
            </div>`;
        }).join('');
        list.querySelectorAll('.remove-btn').forEach(btn => btn.onclick = () => removeFriend(btn.dataset.id));
        list.querySelectorAll('[data-remind]').forEach(btn => btn.onclick = () => toggleReminder(btn.dataset.remind));
    } catch (err) {
        list.innerHTML = `<div class="empty-state">${err.message}</div>`;
    }
}

async function addFriend() {
    const input = document.getElementById('addFriendEmail');
    const msg = document.getElementById('addFriendMsg');
    const query = input.value.trim();
    if (!query) return;

    msg.hidden = false; msg.className = 'inline-msg'; msg.innerText = 'Adding…';
    try {
        const data = await apiFetch('/api/friends', { method: 'POST', body: JSON.stringify({ query }) });
        msg.className = 'inline-msg success'; msg.innerText = data.message;
        input.value = '';
        refreshFriends();
    } catch (err) {
        msg.className = 'inline-msg error'; msg.innerText = err.message;
    }
}

async function importContacts() {
    const msg = document.getElementById('importMsg');
    const results = document.getElementById('importResults');
    const fileInput = document.getElementById('contactsFile');
    if (!fileInput.files.length) return;

    msg.hidden = false; msg.className = 'inline-msg'; msg.innerText = 'Reading…';
    results.innerHTML = '';

    const formData = new FormData();
    formData.append('contacts', fileInput.files[0]);

    try {
        const data = await apiFetch('/api/contacts/import', { method: 'POST', body: formData });

        if (!data.matched.length) {
            msg.className = 'inline-msg'; msg.innerText = `Read ${data.totalParsed} contact${data.totalParsed === 1 ? '' : 's'} - none are on BusyBee yet.`;
            return;
        }
        msg.className = 'inline-msg success';
        msg.innerText = `${data.matched.length} of your contacts ${data.matched.length === 1 ? 'is' : 'are'} on BusyBee` + (data.unmatchedCount ? ` (${data.unmatchedCount} more aren't yet).` : '.');

        results.innerHTML = data.matched.map(m => `
            <div class="row">
                <div class="avatar" style="background:${avatarColor(m.name)}">${initials(m.name)}</div>
                <div class="row-info">
                    <div class="row-name">${m.name}</div>
                    <div class="row-meta">${m.email}</div>
                </div>
                <button class="btn-sm ${m.alreadyFriend ? 'ghost' : ''}" data-import-add="${m.id}" data-email="${m.email}" ${m.alreadyFriend ? 'disabled' : ''}>
                    ${m.alreadyFriend ? 'Added' : 'Add'}
                </button>
            </div>`).join('');

        results.querySelectorAll('[data-import-add]:not([disabled])').forEach(btn => {
            btn.onclick = async () => {
                btn.disabled = true; btn.innerText = 'Adding…';
                try {
                    await apiFetch('/api/friends', { method: 'POST', body: JSON.stringify({ email: btn.dataset.email }) });
                    btn.innerText = 'Added'; btn.classList.add('ghost');
                    refreshFriends();
                } catch (err) {
                    btn.disabled = false; btn.innerText = 'Add';
                }
            };
        });
    } catch (err) {
        msg.className = 'inline-msg error'; msg.innerText = err.message;
    }
}

async function removeFriend(id) {
    try { await apiFetch('/api/friends/' + encodeURIComponent(id), { method: 'DELETE' }); refreshFriends(); }
    catch (err) { /* ignore */ }
}

// ---------------------------------------------------------------- calendar
async function fetchImportedEvents() {
    try {
        const data = await apiFetch('/api/my-events');
        importedEventsCache = data.events || [];
        renderCalendarGrid();
    } catch (err) { /* ignore */ }
}

async function uploadCalendar() {
    const msg = document.getElementById('uploadMsg');
    const fileInput = document.getElementById('calendarFile');
    if (!fileInput.files.length) return;

    msg.hidden = false; msg.className = 'inline-msg'; msg.innerText = 'Processing…';
    const formData = new FormData();
    formData.append('calendar', fileInput.files[0]);

    try {
        const data = await apiFetch('/api/upload-ics', { method: 'POST', body: formData });
        msg.className = 'inline-msg success'; msg.innerText = data.message;
        await fetchImportedEvents();
        renderCalendarSources();
        refreshMyStatus();
    } catch (err) {
        msg.className = 'inline-msg error'; msg.innerText = err.message;
    }
}

async function renderCalendarSources() {
    const box = document.getElementById('sourceList');
    try {
        const data = await apiFetch('/api/calendar-sources');
        if (!data.sources.length) { box.innerHTML = '<div class="empty-state">No calendars uploaded yet.</div>'; return; }
        box.innerHTML = data.sources.map(s => `
            <span class="source-chip">${s.source} · ${s.count}
                <button class="remove-btn" style="width:18px;height:18px;" data-source="${s.source}">
                    <svg class="icon" style="width:11px;height:11px;" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </span>`).join('');
        box.querySelectorAll('[data-source]').forEach(btn => {
            btn.onclick = async () => {
                await apiFetch('/api/calendar-sources/' + encodeURIComponent(btn.dataset.source), { method: 'DELETE' });
                await fetchImportedEvents();
                renderCalendarSources();
                refreshMyStatus();
            };
        });
    } catch (err) { /* ignore */ }
}

async function addManualEvent() {
    const msg = document.getElementById('eventMsg');
    const title = document.getElementById('eventTitle').value.trim();
    const start = document.getElementById('eventStart').value;
    const end = document.getElementById('eventEnd').value;

    msg.hidden = false;
    if (!title || !start || !end) { msg.className = 'inline-msg error'; msg.innerText = 'Fill in title, start, and end.'; return; }

    msg.className = 'inline-msg'; msg.innerText = 'Adding…';
    try {
        const data = await apiFetch('/api/events', {
            method: 'POST',
            body: JSON.stringify({ summary: title, startISO: new Date(start).toISOString(), endISO: new Date(end).toISOString() })
        });
        msg.className = 'inline-msg success'; msg.innerText = data.message;
        document.getElementById('eventTitle').value = '';
        document.getElementById('eventStart').value = '';
        document.getElementById('eventEnd').value = '';
        await fetchImportedEvents();
        renderCalendarSources();
        refreshMyStatus();
    } catch (err) {
        msg.className = 'inline-msg error'; msg.innerText = err.message;
    }
}

function renderCalendarGrid() {
    const grid = document.getElementById('calDays');
    document.getElementById('calMonthYear').innerText = currentNavDate.toLocaleString('default', { month: 'long', year: 'numeric' });
    grid.innerHTML = '';

    const year = currentNavDate.getFullYear(), month = currentNavDate.getMonth();
    const firstDayIndex = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDayIndex; i++) {
        const spacer = document.createElement('div'); spacer.className = 'day empty'; grid.appendChild(spacer);
    }
    for (let day = 1; day <= totalDays; day++) {
        const cell = document.createElement('div'); cell.className = 'day'; cell.innerText = day;
        const targetDateStr = new Date(year, month, day).toDateString();
        const dayEvents = importedEventsCache.filter(ev => new Date(ev.startISO).toDateString() === targetDateStr);
        if (dayEvents.length) cell.classList.add('has-events');
        cell.onclick = () => {
            grid.querySelectorAll('.day').forEach(d => d.classList.remove('selected'));
            cell.classList.add('selected');
            showDayDetail(targetDateStr, dayEvents);
        };
        grid.appendChild(cell);
    }
}

function showDayDetail(dateString, events) {
    const box = document.getElementById('calDetail');
    const label = new Date(dateString).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (!events.length) { box.innerHTML = `<strong>${label}</strong><div class="row-meta">No events.</div>`; return; }
    box.innerHTML = `<strong>${label}</strong>` + events.map(ev => {
        const start = new Date(ev.startISO).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const end = new Date(ev.endISO).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const del = ev.source === 'manual' ? `<button class="remove-btn" style="width:18px;height:18px;flex-shrink:0;" data-del-event="${ev.id}"><svg class="icon" style="width:11px;height:11px;" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` : '';
        return `<div class="cal-event"><span>${ev.summary} <span class="cal-event-source">— ${ev.source}</span></span><span class="row-meta">${start}–${end}</span>${del}</div>`;
    }).join('');
    box.querySelectorAll('[data-del-event]').forEach(btn => {
        btn.onclick = async () => {
            await apiFetch('/api/events/' + btn.dataset.delEvent, { method: 'DELETE' });
            await fetchImportedEvents();
            renderCalendarSources();
            refreshMyStatus();
            showDayDetail(dateString, importedEventsCache.filter(ev => new Date(ev.startISO).toDateString() === dateString));
        };
    });
}

// ---------------------------------------------------------------- settings
function fillAccountForm() {
    document.getElementById('acctEmail').innerText = currentUser.email;
    document.getElementById('acctName').value = currentUser.name || '';
    document.getElementById('acctTimezone').value = currentUser.timezone || '';
    document.getElementById('acctPhone').value = currentUser.phone || '';
}

async function saveAccount() {
    const msg = document.getElementById('acctMsg');
    msg.hidden = false; msg.className = 'inline-msg'; msg.innerText = 'Saving…';
    try {
        const data = await apiFetch('/api/account', {
            method: 'PATCH',
            body: JSON.stringify({
                name: document.getElementById('acctName').value,
                timezone: document.getElementById('acctTimezone').value,
                phone: document.getElementById('acctPhone').value
            })
        });
        msg.className = 'inline-msg success'; msg.innerText = data.message;
        currentUser.name = document.getElementById('acctName').value;
        currentUser.timezone = document.getElementById('acctTimezone').value;
        currentUser.phone = document.getElementById('acctPhone').value;
        document.getElementById('myAvatar').innerText = initials(currentUser.name);
        refreshMyStatus(); refreshFriends();
    } catch (err) {
        msg.className = 'inline-msg error'; msg.innerText = err.message;
    }
}

async function saveBuffers() {
    const msg = document.getElementById('bufferMsg');
    msg.hidden = false; msg.className = 'inline-msg'; msg.innerText = 'Saving…';
    try {
        const data = await apiFetch('/api/update-buffers', {
            method: 'POST',
            body: JSON.stringify({
                bufferBefore: parseInt(document.getElementById('bufferBefore').value, 10),
                bufferAfter: parseInt(document.getElementById('bufferAfter').value, 10)
            })
        });
        msg.className = 'inline-msg success'; msg.innerText = data.message;
        refreshMyStatus(); refreshFriends();
    } catch (err) {
        msg.className = 'inline-msg error'; msg.innerText = err.message;
    }
}

function renderDayPicker() {
    const picker = document.getElementById('dayPicker');
    picker.innerHTML = '';
    DAY_CODES.forEach(day => {
        const chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'day-chip'; chip.innerText = day;
        chip.onclick = () => {
            if (selectedDays.has(day)) { selectedDays.delete(day); chip.classList.remove('selected'); }
            else { selectedDays.add(day); chip.classList.add('selected'); }
        };
        picker.appendChild(chip);
    });
}

document.addEventListener('change', (e) => {
    if (e.target.id === 'blockCategory') {
        const preset = CATEGORY_PRESETS[e.target.value];
        document.getElementById('blockBufferBefore').value = preset.before ?? '';
        document.getElementById('blockBufferAfter').value = preset.after ?? '';
    }
});

function timeToMinutes(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function minutesToTime(m) { return `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`; }

async function addBlock() {
    const msg = document.getElementById('blockMsg');
    msg.hidden = false;

    const label = document.getElementById('blockLabel').value.trim();
    if (!label) { msg.className = 'inline-msg error'; msg.innerText = 'Give it a label.'; return; }
    if (!selectedDays.size) { msg.className = 'inline-msg error'; msg.innerText = 'Pick at least one day.'; return; }

    msg.className = 'inline-msg'; msg.innerText = 'Saving…';
    try {
        const data = await apiFetch('/api/blocks', {
            method: 'POST',
            body: JSON.stringify({
                label,
                type: document.getElementById('blockCategory').value,
                startMinutes: timeToMinutes(document.getElementById('blockStart').value),
                endMinutes: timeToMinutes(document.getElementById('blockEnd').value),
                days: Array.from(selectedDays),
                bufferBeforeMinutes: document.getElementById('blockBufferBefore').value,
                bufferAfterMinutes: document.getElementById('blockBufferAfter').value
            })
        });
        msg.className = 'inline-msg success'; msg.innerText = data.message;
        document.getElementById('blockLabel').value = '';
        selectedDays.clear();
        document.querySelectorAll('.day-chip').forEach(c => c.classList.remove('selected'));
        renderBlocks(); refreshMyStatus(); refreshFriends();
    } catch (err) {
        msg.className = 'inline-msg error'; msg.innerText = err.message;
    }
}

async function toggleBlock(id, enabled) {
    try { await apiFetch('/api/blocks/' + id, { method: 'PATCH', body: JSON.stringify({ enabled }) }); renderBlocks(); refreshMyStatus(); refreshFriends(); }
    catch (err) { /* ignore */ }
}
async function deleteBlock(id) {
    try { await apiFetch('/api/blocks/' + id, { method: 'DELETE' }); renderBlocks(); refreshMyStatus(); refreshFriends(); }
    catch (err) { /* ignore */ }
}

async function renderBlocks() {
    const list = document.getElementById('blockList');
    try {
        const data = await apiFetch('/api/blocks');
        if (!data.blocks.length) { list.innerHTML = '<div class="empty-state">No routine blocks yet.</div>'; return; }
        list.innerHTML = data.blocks.map(b => {
            const before = b.bufferBeforeMinutes != null ? `${b.bufferBeforeMinutes}m` : 'default';
            const after = b.bufferAfterMinutes != null ? `${b.bufferAfterMinutes}m` : 'default';
            return `
            <div class="block-item ${b.enabled ? '' : 'disabled'}">
                <div class="block-item-info">
                    <div class="block-item-label">${b.label}</div>
                    <div class="block-item-meta">${minutesToTime(b.startMinutes)}–${minutesToTime(b.endMinutes)} · ${b.days.join(' ')}</div>
                    <div class="block-item-meta">grace ${before} before / ${after} after</div>
                </div>
                <div class="block-item-actions">
                    <span class="switch ${b.enabled ? 'on' : ''}" data-id="${b.id}" data-enabled="${b.enabled}"></span>
                    <button class="remove-btn" data-del="${b.id}"><svg class="icon" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </div>
            </div>`;
        }).join('');
        list.querySelectorAll('.switch[data-id]').forEach(sw => sw.onclick = () => toggleBlock(sw.dataset.id, sw.dataset.enabled !== 'true'));
        list.querySelectorAll('[data-del]').forEach(btn => btn.onclick = () => deleteBlock(btn.dataset.del));
    } catch (err) {
        list.innerHTML = `<div class="empty-state">${err.message}</div>`;
    }
}
