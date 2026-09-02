require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const ical = require('node-ical');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('❌ Missing JWT_SECRET in .env - copy .env.example to .env and set one.');
    process.exit(1);
}

const upload = multer({ storage: multer.memoryStorage() });

// Extension pages call this API cross-origin (chrome-extension://... ->
// http://localhost:3000). Auth is a bearer token in the Authorization
// header, not a cookie, so a permissive CORS policy carries no
// credential-leak risk.
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const { computeStatus } = require('./availability');
const { User, OutlookBusyBlock, CustomBlock } = require('./models');
const db = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Phone numbers arrive in every format under the sun (spaces, dashes,
// parens, +country code or not). Store them digit-only (keeping a leading
// "+" if given) and match on the last 10 digits, so "+1 250-555-0123" and
// "2505550123" are recognized as the same number.
function normalizePhone(raw) {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length < 7) return null;
    return (trimmed.startsWith('+') ? '+' : '') + digits;
}
function phoneMatchKey(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    return digits.length >= 7 ? digits.slice(-10) : null;
}

function signToken(userId) {
    return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });
    try {
        req.userId = jwt.verify(token, JWT_SECRET).sub;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired session.' });
    }
}

function asyncRoute(handler) {
    return (req, res) => handler(req, res).catch(err => {
        console.error(err);
        res.status(500).json({ error: err.message });
    });
}

// Builds a fully-populated User model (recurring blocks + imported events)
// for the given id and runs it through the availability engine.
async function computeStatusFor(userId) {
    const userRow = await db.getAsync(`SELECT * FROM users WHERE id = ?`, [userId]);
    if (!userRow) return null;

    const user = new User({
        id: userRow.id,
        name: userRow.name,
        timezone: userRow.timezone,
        bufferBefore: userRow.bufferBefore,
        bufferAfter: userRow.bufferAfter,
        manualOverride: userRow.manualOverride
    });

    const blockRows = await db.allAsync(`SELECT * FROM custom_blocks WHERE user_id = ?`, [userId]);
    user.customBlocks = blockRows.map(row => new CustomBlock({
        type: row.type,
        label: row.label,
        startMinutes: row.startMinutes,
        endMinutes: row.endMinutes,
        days: JSON.parse(row.days),
        bufferBeforeMinutes: row.bufferBeforeMinutes,
        bufferAfterMinutes: row.bufferAfterMinutes,
        enabled: row.enabled === 1
    }));

    const eventRows = await db.allAsync(`SELECT * FROM imported_events WHERE user_id = ?`, [userId]);
    user.outlookBlocks = eventRows.map(row => new OutlookBusyBlock({
        summary: row.summary,
        startISO: row.startISO,
        endISO: row.endISO
    }));

    const availability = computeStatus(user, new Date());

    return {
        id: userRow.id,
        name: userRow.name,
        timezone: userRow.timezone,
        bufferBefore: userRow.bufferBefore,
        bufferAfter: userRow.bufferAfter,
        phone: userRow.phone || null,
        dnd: userRow.manualOverride === 'DND',
        localTime: new Date().toLocaleTimeString('en-US', { timeZone: userRow.timezone, hour: '2-digit', minute: '2-digit' }),
        availability
    };
}

// A person is reachable/free right now if their computed status isn't
// actively blocking them - used by both the "Call" button and the
// reminder-firing check below.
function isFree(availability) {
    return availability.status === 'Available' || availability.status === 'Available Soon';
}

// --- Landing page (the extension is the real client now) ----------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'BusyBee is running! 🐝', timestamp: new Date().toISOString() });
});

// --- Accounts ------------------------------------------------------------
app.post('/api/auth/signup', asyncRoute(async (req, res) => {
    const { email, password, name, timezone } = req.body;

    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
    if (!timezone) return res.status(400).json({ error: 'Timezone is required.' });

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await db.getAsync(`SELECT id FROM users WHERE lower(email) = ?`, [normalizedEmail]);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

    const passwordHash = bcrypt.hashSync(password, 10);

    // The app used to have one implicit local profile ("user-1") holding
    // real calendar/routine data, before accounts existed. The first real
    // signup adopts that row in place instead of orphaning its data.
    const legacy = await db.getAsync(`SELECT id FROM users WHERE id = 'user-1' AND email IS NULL`);

    let userId;
    if (legacy) {
        userId = 'user-1';
        await db.runAsync(`UPDATE users SET name = ?, email = ?, passwordHash = ?, timezone = ? WHERE id = ?`,
            [name.trim(), normalizedEmail, passwordHash, timezone, userId]);
    } else {
        userId = crypto.randomUUID();
        // Default grace period: no buffer before (you're free the instant
        // something starts), 30 minutes after - the "give me half an hour
        // after this ends before I'm really free" default.
        await db.runAsync(`INSERT INTO users (id, name, email, passwordHash, timezone, bufferBefore, bufferAfter) VALUES (?, ?, ?, ?, ?, 15, 30)`,
            [userId, name.trim(), normalizedEmail, passwordHash, timezone]);
    }

    res.json({ token: signToken(userId), user: { id: userId, name: name.trim(), email: normalizedEmail, timezone } });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const row = await db.getAsync(`SELECT * FROM users WHERE lower(email) = ?`, [String(email).trim().toLowerCase()]);
    if (!row || !row.passwordHash || !bcrypt.compareSync(password, row.passwordHash)) {
        return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    res.json({ token: signToken(row.id), user: { id: row.id, name: row.name, email: row.email, timezone: row.timezone } });
}));

app.get('/api/auth/me', requireAuth, asyncRoute(async (req, res) => {
    const row = await db.getAsync(`SELECT id, name, email, timezone, phone FROM users WHERE id = ?`, [req.userId]);
    if (!row) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: row });
}));

app.patch('/api/account', requireAuth, asyncRoute(async (req, res) => {
    const { name, timezone, phone } = req.body;
    if (name != null && !name.trim()) return res.status(400).json({ error: 'Name cannot be empty.' });

    const fields = [];
    const values = [];
    if (name != null) { fields.push('name = ?'); values.push(name.trim()); }
    if (timezone != null) { fields.push('timezone = ?'); values.push(timezone); }
    if (phone != null) {
        if (phone.trim() && !normalizePhone(phone)) return res.status(400).json({ error: "That doesn't look like a valid phone number." });
        fields.push('phone = ?'); values.push(normalizePhone(phone));
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

    values.push(req.userId);
    await db.runAsync(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
    res.json({ message: 'Account updated.' });
}));

// --- My presence -------------------------------------------------------
app.get('/api/me/status', requireAuth, asyncRoute(async (req, res) => {
    const status = await computeStatusFor(req.userId);
    if (!status) return res.status(404).json({ error: 'User not found.' });
    res.json(status);
}));

app.post('/api/dnd', requireAuth, asyncRoute(async (req, res) => {
    const dnd = Boolean(req.body.dnd);
    await db.runAsync(`UPDATE users SET manualOverride = ? WHERE id = ?`, [dnd ? 'DND' : null, req.userId]);
    res.json({ dnd });
}));

// --- Buffer settings -----------------------------------------------------
app.post('/api/update-buffers', requireAuth, asyncRoute(async (req, res) => {
    const bufferBefore = Number(req.body.bufferBefore);
    const bufferAfter = Number(req.body.bufferAfter);

    if (!Number.isFinite(bufferBefore) || !Number.isFinite(bufferAfter) || bufferBefore < 0 || bufferAfter < 0) {
        return res.status(400).json({ error: 'bufferBefore and bufferAfter must be non-negative numbers.' });
    }

    const result = await db.runAsync(`UPDATE users SET bufferBefore = ?, bufferAfter = ? WHERE id = ?`, [bufferBefore, bufferAfter, req.userId]);
    if (result.changes === 0) return res.status(404).json({ error: 'User not found.' });
    res.json({ message: 'Buffers saved successfully! 🚗💨' });
}));

// --- Routine blocks (work, meals, sleep, workouts...) -------------------
app.get('/api/blocks', requireAuth, asyncRoute(async (req, res) => {
    const rows = await db.allAsync(`SELECT * FROM custom_blocks WHERE user_id = ? ORDER BY startMinutes ASC`, [req.userId]);
    res.json({
        blocks: rows.map(r => ({
            id: r.id,
            type: r.type,
            label: r.label,
            startMinutes: r.startMinutes,
            endMinutes: r.endMinutes,
            days: JSON.parse(r.days),
            bufferBeforeMinutes: r.bufferBeforeMinutes,
            bufferAfterMinutes: r.bufferAfterMinutes,
            enabled: r.enabled === 1
        }))
    });
}));

app.post('/api/blocks', requireAuth, asyncRoute(async (req, res) => {
    const { type, label, startMinutes, endMinutes, days, bufferBeforeMinutes, bufferAfterMinutes } = req.body;

    if (typeof label !== 'string' || !label.trim()) return res.status(400).json({ error: 'label is required.' });
    if (!Array.isArray(days) || days.length === 0) return res.status(400).json({ error: 'Pick at least one day.' });
    const start = Number(startMinutes), end = Number(endMinutes);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= 1440 || end < 0 || end > 1440) {
        return res.status(400).json({ error: 'startMinutes/endMinutes must be within a single day (0-1440).' });
    }

    const before = bufferBeforeMinutes === '' || bufferBeforeMinutes == null ? null : Number(bufferBeforeMinutes);
    const after = bufferAfterMinutes === '' || bufferAfterMinutes == null ? null : Number(bufferAfterMinutes);

    const result = await db.runAsync(
        `INSERT INTO custom_blocks (user_id, type, label, startMinutes, endMinutes, days, bufferBeforeMinutes, bufferAfterMinutes, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [req.userId, type || 'custom', label.trim(), start, end, JSON.stringify(days), before, after]
    );
    res.json({ id: result.lastID, message: 'Block added.' });
}));

app.patch('/api/blocks/:id', requireAuth, asyncRoute(async (req, res) => {
    if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required.' });
    const result = await db.runAsync(
        `UPDATE custom_blocks SET enabled = ? WHERE id = ? AND user_id = ?`,
        [req.body.enabled ? 1 : 0, req.params.id, req.userId]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Block not found.' });
    res.json({ message: 'Updated.' });
}));

app.delete('/api/blocks/:id', requireAuth, asyncRoute(async (req, res) => {
    const result = await db.runAsync(`DELETE FROM custom_blocks WHERE id = ? AND user_id = ?`, [req.params.id, req.userId]);
    if (result.changes === 0) return res.status(404).json({ error: 'Block not found.' });
    res.json({ message: 'Deleted.' });
}));

// --- Friends / contacts --------------------------------------------------
app.get('/api/friends', requireAuth, asyncRoute(async (req, res) => {
    const rows = await db.allAsync(`SELECT friend_id FROM friends WHERE user_id = ?`, [req.userId]);
    const friends = await Promise.all(rows.map(r => computeStatusFor(r.friend_id)));
    res.json({ friends: friends.filter(Boolean) });
}));

app.post('/api/friends', requireAuth, asyncRoute(async (req, res) => {
    // Accepts either an email or a phone number in the same field, like
    // adding a contact by number or handle in a messaging app.
    const query = String(req.body.query || req.body.email || '').trim();
    if (!query) return res.status(400).json({ error: 'Enter an email or phone number.' });

    let target;
    if (EMAIL_RE.test(query)) {
        target = await db.getAsync(`SELECT id, name FROM users WHERE lower(email) = ?`, [query.toLowerCase()]);
    } else {
        const key = phoneMatchKey(query);
        if (!key) return res.status(400).json({ error: 'Enter a valid email or phone number.' });
        target = await db.getAsync(`SELECT id, name FROM users WHERE phone IS NOT NULL AND substr(replace(phone, '+', ''), -10) = ?`, [key]);
    }

    if (!target) return res.status(404).json({ error: `No BusyBee account found for "${query}".` });
    if (target.id === req.userId) return res.status(400).json({ error: "That's your own account." });

    try {
        await db.runAsync(`INSERT INTO friends (user_id, friend_id) VALUES (?, ?)`, [req.userId, target.id]);
    } catch (err) {
        if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'Already in your contacts.' });
        throw err;
    }
    res.json({ message: `${target.name} added! 🐝` });
}));

app.delete('/api/friends/:friendId', requireAuth, asyncRoute(async (req, res) => {
    const result = await db.runAsync(`DELETE FROM friends WHERE user_id = ? AND friend_id = ?`, [req.userId, req.params.friendId]);
    if (result.changes === 0) return res.status(404).json({ error: 'Not in your contacts.' });
    res.json({ message: 'Removed.' });
}));

// Very small vCard (.vcf) reader - the export format every major contacts
// system (Google Contacts, iCloud, Android, Outlook) produces. Handles
// line-folding (RFC 6350) and multiple concatenated cards in one file.
function parseVCard(text) {
    const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const lines = unfolded.split(/\r\n|\n|\r/);
    const cards = [];
    let current = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (/^BEGIN:VCARD$/i.test(line)) { current = { name: null, emails: [], phones: [] }; continue; }
        if (/^END:VCARD$/i.test(line)) { if (current) cards.push(current); current = null; continue; }
        if (!current) continue;

        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx);
        const value = line.slice(idx + 1).trim();

        if (/^FN/i.test(key) && value) current.name = value;
        else if (/^EMAIL/i.test(key) && value) current.emails.push(value.toLowerCase());
        else if (/^TEL/i.test(key) && value) current.phones.push(value);
    }
    return cards;
}

// Reads a phone/email contacts export, matches its emails and phone
// numbers against real BusyBee accounts, and reports which of your
// contacts are already on here - nothing is added automatically, and
// nothing from the file is stored.
app.post('/api/contacts/import', requireAuth, upload.single('contacts'), asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const me = await db.getAsync(`SELECT lower(email) as email, phone FROM users WHERE id = ?`, [req.userId]);
    const myEmail = me ? me.email : null;
    const myPhoneKey = me && me.phone ? phoneMatchKey(me.phone) : null;

    const contacts = parseVCard(req.file.buffer.toString('utf8'))
        .map(c => ({
            name: c.name,
            emails: Array.from(new Set(c.emails)),
            phoneKeys: Array.from(new Set(c.phones.map(phoneMatchKey).filter(Boolean)))
        }))
        .filter(c => c.emails.length || c.phoneKeys.length)
        .filter(c => !c.emails.includes(myEmail) && !(myPhoneKey && c.phoneKeys.includes(myPhoneKey)));

    if (contacts.length === 0) return res.json({ matched: [], unmatchedCount: 0, totalParsed: 0 });

    const allEmails = Array.from(new Set(contacts.flatMap(c => c.emails)));
    const allPhoneKeys = Array.from(new Set(contacts.flatMap(c => c.phoneKeys)));

    const clauses = [];
    const params = [];
    if (allEmails.length) { clauses.push(`lower(email) IN (${allEmails.map(() => '?').join(',')})`); params.push(...allEmails); }
    if (allPhoneKeys.length) { clauses.push(`(phone IS NOT NULL AND substr(replace(phone, '+', ''), -10) IN (${allPhoneKeys.map(() => '?').join(',')}))`); params.push(...allPhoneKeys); }

    const accounts = clauses.length ? await db.allAsync(`SELECT id, name, email, phone FROM users WHERE ${clauses.join(' OR ')}`, params) : [];
    const existingFriends = new Set((await db.allAsync(`SELECT friend_id FROM friends WHERE user_id = ?`, [req.userId])).map(r => r.friend_id));

    const emailToAccount = new Map(accounts.filter(a => a.email).map(a => [a.email.toLowerCase(), a]));
    const phoneToAccount = new Map(accounts.filter(a => a.phone).map(a => [phoneMatchKey(a.phone), a]));

    const matched = [];
    const seenAccountIds = new Set();
    let matchedContactCount = 0;

    for (const c of contacts) {
        const account = c.emails.map(e => emailToAccount.get(e)).find(Boolean)
            || c.phoneKeys.map(k => phoneToAccount.get(k)).find(Boolean);
        if (!account) continue;
        matchedContactCount++;
        if (seenAccountIds.has(account.id)) continue;
        seenAccountIds.add(account.id);
        matched.push({ id: account.id, name: account.name, email: account.email, alreadyFriend: existingFriends.has(account.id) });
    }

    res.json({ matched, unmatchedCount: contacts.length - matchedContactCount, totalParsed: contacts.length });
}));

// --- "Remind me when they're free" ---------------------------------------
app.get('/api/reminders', requireAuth, asyncRoute(async (req, res) => {
    const rows = await db.allAsync(`SELECT target_id FROM reminders WHERE user_id = ? AND firedAt IS NULL`, [req.userId]);
    res.json({ targetIds: rows.map(r => r.target_id) });
}));

app.post('/api/reminders', requireAuth, asyncRoute(async (req, res) => {
    const targetId = req.body.targetId;
    if (!targetId) return res.status(400).json({ error: 'targetId is required.' });

    const isFriend = await db.getAsync(`SELECT id FROM friends WHERE user_id = ? AND friend_id = ?`, [req.userId, targetId]);
    if (!isFriend) return res.status(404).json({ error: 'Not in your contacts.' });

    // Re-arming a reminder that already fired (or already exists) just
    // clears firedAt so it can fire again.
    await db.runAsync(
        `INSERT INTO reminders (user_id, target_id) VALUES (?, ?)
         ON CONFLICT(user_id, target_id) DO UPDATE SET firedAt = NULL, createdAt = CURRENT_TIMESTAMP`,
        [req.userId, targetId]
    );
    res.json({ message: 'We\'ll let you know when they\'re free.' });
}));

app.delete('/api/reminders/:targetId', requireAuth, asyncRoute(async (req, res) => {
    await db.runAsync(`DELETE FROM reminders WHERE user_id = ? AND target_id = ?`, [req.userId, req.params.targetId]);
    res.json({ message: 'Reminder cancelled.' });
}));

// Polled by the extension's background worker (and, best-effort, the web
// app while a tab is open) to learn which pending reminders should fire
// right now. Firing is idempotent: once returned here, firedAt is set so
// the same reminder is never reported twice.
app.get('/api/reminders/check', requireAuth, asyncRoute(async (req, res) => {
    const pending = await db.allAsync(`SELECT id, target_id FROM reminders WHERE user_id = ? AND firedAt IS NULL`, [req.userId]);
    const ready = [];

    for (const reminder of pending) {
        const status = await computeStatusFor(reminder.target_id);
        if (status && isFree(status.availability)) {
            await db.runAsync(`UPDATE reminders SET firedAt = CURRENT_TIMESTAMP WHERE id = ?`, [reminder.id]);
            ready.push({ targetId: reminder.target_id, name: status.name, status: status.availability.status });
        }
    }

    res.json({ ready });
}));

// --- Calendar: multiple layered sources + manual events -------------------
// Each uploaded .ics keeps its own "source" label (the file name by
// default). Re-uploading a source only replaces that source's events -
// your other calendars stay put. 'manual' holds one-off events you add
// by hand directly in the app.
app.post('/api/upload-ics', requireAuth, upload.single('calendar'), asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const source = (req.body.source || req.file.originalname.replace(/\.ics$/i, '') || 'Calendar').trim().slice(0, 60);

    const icsData = req.file.buffer.toString();
    let events;
    try {
        events = ical.parseICS(icsData);
    } catch (error) {
        return res.status(500).json({ error: 'Failed to parse calendar file: ' + error.message });
    }

    const eventsToInsert = [];
    for (const k in events) {
        const ev = events[k];
        if (ev.type === 'VEVENT' && ev.start && ev.end) {
            eventsToInsert.push({
                summary: ev.summary || 'Busy Slot',
                startISO: new Date(ev.start).toISOString(),
                endISO: new Date(ev.end).toISOString()
            });
        }
    }

    await db.runAsync(`DELETE FROM imported_events WHERE user_id = ? AND source = ?`, [req.userId, source]);

    if (eventsToInsert.length === 0) {
        return res.json({ message: `"${source}" uploaded, but no events were found in it.` });
    }

    const stmt = db.prepare(`INSERT INTO imported_events (user_id, summary, startISO, endISO, source) VALUES (?, ?, ?, ?, ?)`);
    eventsToInsert.forEach(ev => stmt.run(req.userId, ev.summary, ev.startISO, ev.endISO, source));
    stmt.finalize();

    res.json({ message: `Imported ${eventsToInsert.length} events from "${source}".` });
}));

app.get('/api/my-events', requireAuth, (req, res) => {
    db.all(`SELECT id, summary, startISO, endISO, source FROM imported_events WHERE user_id = ? ORDER BY startISO ASC`, [req.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ events: rows });
    });
});

// Distinct calendar sources with counts, so the UI can list "Work
// Calendar (12 events)", "School (8 events)", "Manual (2)" as separate,
// individually-removable layers.
app.get('/api/calendar-sources', requireAuth, asyncRoute(async (req, res) => {
    const rows = await db.allAsync(
        `SELECT source, COUNT(*) as count FROM imported_events WHERE user_id = ? GROUP BY source ORDER BY source ASC`,
        [req.userId]
    );
    res.json({ sources: rows });
}));

app.delete('/api/calendar-sources/:source', requireAuth, asyncRoute(async (req, res) => {
    const result = await db.runAsync(`DELETE FROM imported_events WHERE user_id = ? AND source = ?`, [req.userId, req.params.source]);
    if (result.changes === 0) return res.status(404).json({ error: 'No events from that source.' });
    res.json({ message: 'Removed.' });
}));

// One-off manual events - "add your own" alongside uploaded calendars.
app.post('/api/events', requireAuth, asyncRoute(async (req, res) => {
    const { summary, startISO, endISO } = req.body;
    if (!summary || !summary.trim()) return res.status(400).json({ error: 'A title is required.' });
    const start = new Date(startISO), end = new Date(endISO);
    if (isNaN(start) || isNaN(end) || end <= start) return res.status(400).json({ error: 'Invalid start/end time.' });

    const result = await db.runAsync(
        `INSERT INTO imported_events (user_id, summary, startISO, endISO, source) VALUES (?, ?, ?, ?, 'manual')`,
        [req.userId, summary.trim(), start.toISOString(), end.toISOString()]
    );
    res.json({ id: result.lastID, message: 'Event added.' });
}));

app.delete('/api/events/:id', requireAuth, asyncRoute(async (req, res) => {
    const result = await db.runAsync(`DELETE FROM imported_events WHERE id = ? AND user_id = ?`, [req.params.id, req.userId]);
    if (result.changes === 0) return res.status(404).json({ error: 'Event not found.' });
    res.json({ message: 'Deleted.' });
}));

// --- Dev helper ------------------------------------------------------------
app.get('/api/test-engine', requireAuth, asyncRoute(async (req, res) => {
    const status = await computeStatusFor(req.userId);
    if (!status) return res.status(404).json({ error: 'User not found' });
    res.json({
        user: status.name,
        timezone: status.timezone,
        availability: status.availability,
        totalImportedEvents: (await db.allAsync(`SELECT id FROM imported_events WHERE user_id = ?`, [req.userId])).length,
        source: 'SQLite Database 📦'
    });
}));

app.listen(PORT, () => {
    console.log(`🐝 BusyBee server running on port ${PORT}`);
});
