import Database from 'better-sqlite3';

const db = new Database('run-eat-fit.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    goal TEXT,
    activity TEXT,
    tone TEXT,
    checkin_time TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

try {
  db.exec('ALTER TABLE users ADD COLUMN last_checkin_date TEXT');
} catch {
  // колонка уже есть — ALTER TABLE ADD COLUMN IF NOT EXISTS в SQLite не поддерживается
}

export function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

export function createUser(telegramId) {
  db.prepare('INSERT OR IGNORE INTO users (telegram_id) VALUES (?)').run(telegramId);
  return getUser(telegramId);
}

const ONBOARDING_FIELDS = ['goal', 'activity', 'tone', 'checkin_time'];

export function updateUser(telegramId, field, value) {
  if (!ONBOARDING_FIELDS.includes(field)) {
    throw new Error(`Unknown onboarding field: ${field}`);
  }
  db.prepare(`UPDATE users SET ${field} = ? WHERE telegram_id = ?`).run(value, telegramId);
  return getUser(telegramId);
}

export function addMessage(telegramId, role, content) {
  db.prepare('INSERT INTO messages (telegram_id, role, content) VALUES (?, ?, ?)').run(telegramId, role, content);
}

export function getHistory(telegramId, limit = 20) {
  const rows = db
    .prepare('SELECT role, content FROM messages WHERE telegram_id = ? ORDER BY id DESC LIMIT ?')
    .all(telegramId, limit);
  return rows.reverse();
}

export function getUsersDueForCheckin(hhmm, today) {
  return db
    .prepare(
      `SELECT * FROM users
       WHERE checkin_time = ?
         AND goal IS NOT NULL AND activity IS NOT NULL AND tone IS NOT NULL
         AND (last_checkin_date IS NULL OR last_checkin_date != ?)`,
    )
    .all(hhmm, today);
}

export function markCheckinSent(telegramId, today) {
  db.prepare('UPDATE users SET last_checkin_date = ? WHERE telegram_id = ?').run(today, telegramId);
}

export default db;
