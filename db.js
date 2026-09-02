// db.js
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

// This will create a local file named 'busybee.db' in your folder
const dbPath = path.resolve(__dirname, 'busybee.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Error opening database', err.message);
    } else {
        console.log('📦 Connected to the SQLite database');
    }
});

// Promise-friendly helpers (sqlite3's own callback API gets unwieldy once
// a route needs to join data from several tables, e.g. building a friend's
// full status).
db.getAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
db.allAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});
db.runAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});

// ADD COLUMN throws if the column already exists (SQLite has no
// "IF NOT EXISTS" for columns) - swallow just that one error so re-running
// against an already-migrated database is safe.
function addColumnIfMissing(table, columnDef) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`, (err) => {
        if (err && !/duplicate column name/i.test(err.message)) {
            console.error(`❌ Migration failed on ${table}.${columnDef}:`, err.message);
        }
    });
}

db.serialize(() => {
    // --- Core tables -------------------------------------------------
    db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    timezone TEXT,
    bufferBefore INTEGER DEFAULT 15,
    bufferAfter INTEGER DEFAULT 15
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS custom_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    type TEXT,
    startMinutes INTEGER,
    endMinutes INTEGER,
    days TEXT,
    enabled BOOLEAN DEFAULT 1,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS imported_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    summary TEXT,
    startISO TEXT,
    endISO TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

    // --- Migrations ------------------------------------------------------
    addColumnIfMissing('users', 'manualOverride TEXT');
    addColumnIfMissing('custom_blocks', 'label TEXT');
    addColumnIfMissing('custom_blocks', 'bufferBeforeMinutes INTEGER');
    addColumnIfMissing('custom_blocks', 'bufferAfterMinutes INTEGER');

    // Real accounts. SQLite can't add a UNIQUE constraint to an existing
    // column via ALTER TABLE without a full table rebuild, so email
    // uniqueness is enforced in the signup route instead.
    addColumnIfMissing('users', 'email TEXT');
    addColumnIfMissing('users', 'passwordHash TEXT');
    addColumnIfMissing('users', 'phone TEXT');

    db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    friend_id TEXT,
    UNIQUE(user_id, friend_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(friend_id) REFERENCES users(id)
  )`);

    // Each imported .ics carries its own "source" label (e.g. its file
    // name) so uploading a second calendar layers on top instead of
    // replacing the first - re-uploading a given source only refreshes
    // that one. 'manual' is reserved for one-off events added by hand.
    addColumnIfMissing('imported_events', "source TEXT DEFAULT 'manual'");

    // "Remind me when this person is free" - one row per (owner, target)
    // pair. firedAt is set once the reminder has actually fired, so a
    // background poll never notifies the same reminder twice.
    db.run(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    target_id TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
    firedAt TEXT,
    UNIQUE(user_id, target_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(target_id) REFERENCES users(id)
  )`);

    // --- Legacy local profile ---------------------------------------------
    // Before accounts existed, this app had one implicit local profile
    // ("user-1") holding real calendar/routine data. Keep it in place,
    // unclaimed (no email/password) - the first real signup adopts it
    // in-place (see POST /api/auth/signup) so that data isn't orphaned.
    db.run(
        `INSERT OR IGNORE INTO users (id, name, timezone, bufferBefore, bufferAfter) VALUES (?, ?, ?, ?, ?)`,
        ['user-1', 'Mitchell', 'America/Vancouver', 15, 15]
    );

    // --- Demo accounts -------------------------------------------------
    // Real, addable, computed-not-hardcoded contacts across timezones, so
    // there's something to add and see once you've signed up. Guarded on
    // user-2 not existing yet, so restarts don't re-seed/duplicate.
    // Demo password for all three: "busybee123"
    db.get(`SELECT id FROM users WHERE id = 'user-2'`, [], (err, row) => {
        if (err || row) return;

        const demoPasswordHash = bcrypt.hashSync('busybee123', 10);

        const demoUsers = [
            ['user-2', 'Florian', 'florian@example.com', 'Europe/Berlin', 10, 10],
            ['user-3', 'Rocky', 'rocky@example.com', 'America/Vancouver', 15, 15],
            ['user-4', 'Aki', 'aki@example.com', 'Asia/Tokyo', 10, 10]
        ];
        const demoBlocks = [
            // Florian: office job, gym after work with shower grace, sleeps overnight.
            ['user-2', 'work', 'Work', 9 * 60, 17 * 60 + 30, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], null, null],
            ['user-2', 'activity', 'Gym', 18 * 60 + 30, 19 * 60 + 30, ['Tue', 'Thu'], 0, 20],
            ['user-2', 'sleep', 'Sleep', 23 * 60, 7 * 60, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], 20, 0],

            // Rocky: classes, dinner with family, sleeps overnight.
            ['user-3', 'work', 'Classes', 8 * 60 + 30, 16 * 60, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], null, null],
            ['user-3', 'meal', 'Dinner', 18 * 60, 19 * 60, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], 0, 10],
            ['user-3', 'sleep', 'Sleep', 23 * 60 + 30, 7 * 60, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], 20, 0],

            // Aki: office job, dinner, sleeps overnight.
            ['user-4', 'work', 'Work', 9 * 60, 18 * 60, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], null, null],
            ['user-4', 'meal', 'Dinner', 19 * 60, 20 * 60, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], 0, 10],
            ['user-4', 'sleep', 'Sleep', 23 * 60, 6 * 60 + 30, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], 20, 0]
        ];

        const insertUser = db.prepare(`INSERT OR IGNORE INTO users (id, name, email, passwordHash, timezone, bufferBefore, bufferAfter) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        demoUsers.forEach(u => insertUser.run(u[0], u[1], u[2], demoPasswordHash, u[3], u[4], u[5]));
        insertUser.finalize();

        const insertBlock = db.prepare(`INSERT INTO custom_blocks (user_id, type, label, startMinutes, endMinutes, days, bufferBeforeMinutes, bufferAfterMinutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        demoBlocks.forEach(b => insertBlock.run(b[0], b[1], b[2], b[3], b[4], JSON.stringify(b[5]), b[6], b[7]));
        insertBlock.finalize();
    });
});

module.exports = db;
