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

for (const column of ['age', 'gender', 'weight', 'height']) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
  } catch {
    // колонка уже есть
  }
}

for (const column of ['fitness_test_pushups', 'fitness_test_plank', 'fitness_test_resting_hr', 'fitness_test_run', 'fitness_test_last_offered_at']) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
  } catch {
    // колонка уже есть
  }
}
try {
  db.exec('ALTER TABLE users ADD COLUMN fitness_test_offer_count INTEGER DEFAULT 0');
} catch {
  // колонка уже есть
}

const WEEKDAY_COLUMNS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_plan (
    telegram_id INTEGER PRIMARY KEY,
    ${WEEKDAY_COLUMNS.map((d) => `${d} TEXT`).join(',\n    ')},
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS plan_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    workout TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(telegram_id, date)
  )
`);

// Журнал ФАКТОВ (что реально было с тренировкой в этот день), отдельно от
// weekly_plan/plan_overrides (что должно быть — намерение, перезаписывается).
// Одна строка на (юзер, дата), как plan_overrides.
db.exec(`
  CREATE TABLE IF NOT EXISTS training_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    planned TEXT,
    status TEXT,
    actual TEXT,
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(telegram_id, date)
  )
`);

export function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

export function createUser(telegramId) {
  db.prepare('INSERT OR IGNORE INTO users (telegram_id) VALUES (?)').run(telegramId);
  return getUser(telegramId);
}

const ONBOARDING_FIELDS = ['goal', 'age', 'gender', 'weight', 'height', 'activity', 'tone', 'checkin_time'];

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

export function getWeeklyPlan(telegramId) {
  return db.prepare('SELECT * FROM weekly_plan WHERE telegram_id = ?').get(telegramId);
}

export function upsertWeeklyPlan(telegramId, updates) {
  const fields = Object.keys(updates).filter((k) => WEEKDAY_COLUMNS.includes(k));
  if (fields.length === 0) return;
  db.prepare('INSERT OR IGNORE INTO weekly_plan (telegram_id) VALUES (?)').run(telegramId);
  const setClause = fields.map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE weekly_plan SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`).run(
    ...fields.map((f) => updates[f]),
    telegramId,
  );
}

export function getActiveOverrides(telegramId, fromDate) {
  return db
    .prepare('SELECT date, workout FROM plan_overrides WHERE telegram_id = ? AND date >= ? ORDER BY date ASC')
    .all(telegramId, fromDate);
}

export function upsertOverride(telegramId, date, workout) {
  db.prepare(
    `INSERT INTO plan_overrides (telegram_id, date, workout) VALUES (?, ?, ?)
     ON CONFLICT(telegram_id, date) DO UPDATE SET workout = excluded.workout`,
  ).run(telegramId, date, workout);
}

export function getOverrideForDate(telegramId, date) {
  return db.prepare('SELECT workout FROM plan_overrides WHERE telegram_id = ? AND date = ?').get(telegramId, date)
    ?.workout;
}

export function getTrainingLogForDate(telegramId, date) {
  return db.prepare('SELECT * FROM training_log WHERE telegram_id = ? AND date = ?').get(telegramId, date);
}

// planned перезаписывается всегда свежим (это снимок того, что было
// запланировано на момент отчёта, не пользовательский ввод — код резолвит
// заново при каждом вызове). status/actual/note — последний непустой ответ
// выигрывает по каждому полю отдельно, не склейка истории дня.
export function upsertTrainingLog(telegramId, date, { planned, status, actual, note }) {
  db.prepare(
    `INSERT INTO training_log (telegram_id, date, planned, status, actual, note) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_id, date) DO UPDATE SET
       planned = excluded.planned,
       status = COALESCE(excluded.status, training_log.status),
       actual = COALESCE(excluded.actual, training_log.actual),
       note = COALESCE(excluded.note, training_log.note),
       updated_at = CURRENT_TIMESTAMP`,
  ).run(telegramId, date, planned ?? null, status ?? null, actual ?? null, note ?? null);
}

export function saveFitnessTestResults(telegramId, results) {
  const fields = ['pushups', 'plank', 'resting_hr', 'run'].filter((f) => results[f]);
  if (fields.length === 0) return;
  const setClause = fields.map((f) => `fitness_test_${f} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${setClause} WHERE telegram_id = ?`).run(
    ...fields.map((f) => results[f]),
    telegramId,
  );
}

export function markFitnessTestOffered(telegramId, todayISO) {
  db.prepare(
    'UPDATE users SET fitness_test_last_offered_at = ?, fitness_test_offer_count = COALESCE(fitness_test_offer_count, 0) + 1 WHERE telegram_id = ?',
  ).run(todayISO, telegramId);
}

export default db;
