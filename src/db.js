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

export default db;
