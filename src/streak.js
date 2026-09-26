// Механика серии (стрик) — решение 23.09.2026, см. CLAUDE.md.
// Идея: код каждый день один раз окончательно решает статус дня и пишет его
// в training_log (finalizeDay) — дальше computeStreak просто читает готовые
// строки, ничего не домысливая по плану заново. Так же, как весь остальной
// проект: считает код, модель только рассказывает по-человечески.
import {
  getTrainingLogForDate,
  upsertTrainingLog,
  getUser,
  spendStreakFreebie,
  getMilestonesReached,
  addMilestone,
  getTotalDistanceKm,
} from './db.js';
import { resolveDayWorkout, belgradeTodayISO, addDaysISO } from './coach.js';

// Грубая эвристика: план — свободный текст ("бег 5 км", "🎾 теннис", "отдых"),
// не enum. «Отдых» по подстроке плюс дефолт resolveDayWorkout, когда схемы
// ещё нет вовсе — этого достаточно для реальных формулировок в проекте.
const REST_PATTERN = /отдых/i;

function isRestPlanned(workoutText) {
  return REST_PATTERN.test(workoutText) || workoutText === 'тренировки нет';
}

// Один раз на дату — если запись уже есть (юзер сам отчитался, или модель
// вызвала log_training_day), ничего не трогаем. Если нет — код сам решает:
// плановый отдых без режима челленджа проходит бесплатно, во всех остальных
// случаях (был реальный план, или режим челленджа требует зарядку) это
// пропуск, который гасится банком бесплатных пропусков, если он не пуст.
export function finalizeDay(telegramId, dateISO) {
  const existing = getTrainingLogForDate(telegramId, dateISO);
  if (existing) return;

  const user = getUser(telegramId);
  const planned = resolveDayWorkout(telegramId, dateISO);

  if (isRestPlanned(planned) && !user.challenge_mode) {
    upsertTrainingLog(telegramId, dateISO, { planned, status: 'rest' });
    return;
  }

  const covered = spendStreakFreebie(telegramId);
  upsertTrainingLog(telegramId, dateISO, { planned, status: 'skipped', freebie_covered: covered ? 1 : 0 });
}

// Идём назад по дням от сегодня. Сегодняшний день, если по нему ещё нет
// записи (обычное дело — день не закрыт), просто пропускаем без разрыва и
// без прибавки — итог должен отражать вчера и раньше, а не наказывать за то,
// что до вечера ещё не отчитались. sick — пауза: не растит счётчик и не
// рвёт его. skipped без freebie_covered — настоящий пропуск, обрыв.
export function computeStreak(telegramId) {
  let iso = belgradeTodayISO();
  let length = 0;
  let checkingToday = true;

  for (let i = 0; i < 400; i += 1) {
    const row = getTrainingLogForDate(telegramId, iso);

    if (!row) {
      if (checkingToday) {
        checkingToday = false;
        iso = addDaysISO(iso, -1);
        continue;
      }
      break;
    }
    checkingToday = false;

    if (row.status === 'sick') {
      iso = addDaysISO(iso, -1);
      continue;
    }
    if (row.status === 'skipped' && !row.freebie_covered) break;
    if (row.status === 'done' || row.status === 'partial' || row.status === 'rest' || row.status === 'skipped') {
      length += 1;
      iso = addDaysISO(iso, -1);
      continue;
    }
    break;
  }

  return length;
}

const STREAK_MILESTONES = [7, 14, 30, 60, 90, 100, 150, 180, 200, 250, 300, 365];
const DISTANCE_MILESTONES = [10, 50, 100, 150, 200, 300, 500, 750, 1000];

// Сверяет текущий стрик/суммарный км с уже отмеченными вехами, записывает
// новые и возвращает их — вызывающий код решает, что с этим делать
// (formatStreakSection просит модель поздравить прямо в ответе).
export function checkMilestones(telegramId) {
  const streak = computeStreak(telegramId);
  const totalKm = getTotalDistanceKm(telegramId);
  const reachedStreak = getMilestonesReached(telegramId, 'streak_days');
  const reachedKm = getMilestonesReached(telegramId, 'distance_km');

  const newStreak = STREAK_MILESTONES.filter((v) => streak >= v && !reachedStreak.has(v));
  const newKm = DISTANCE_MILESTONES.filter((v) => totalKm >= v && !reachedKm.has(v));

  for (const v of newStreak) addMilestone(telegramId, 'streak_days', v);
  for (const v of newKm) addMilestone(telegramId, 'distance_km', v);

  return { streak, totalKm, newStreak, newKm };
}

const CHALLENGE_MODE_RULES =
  'В дни планового отдыха всё равно нужна короткая зарядка/растяжка (10-15 минут), иначе день не идёт в серию.';

// Кусок системного промпта — код уже всё посчитал и решил, модель только
// рассказывает по-человечески, каждый раз разными словами (см. инструкцию
// ниже в FROZEN_INSTRUCTIONS). Идёт во второй, некэшируемый по дате блок
// buildSystemPrompt (см. коммент там) — тут не место замороженной части.
export function formatStreakSection(user) {
  const { streak, newStreak, newKm } = checkMilestones(user.telegram_id);
  const freebies = user.streak_freebies ?? 0;

  const lines = [`Серия подряд: ${streak} дн. Бесплатных пропусков в запасе: ${freebies}/4.`];
  lines.push(
    user.challenge_mode
      ? `Режим челленджа включён. ${CHALLENGE_MODE_RULES}`
      : 'Режим челленджа выключен — дни планового отдыха засчитываются в серию без доп. действий.',
  );

  const yesterday = getTrainingLogForDate(user.telegram_id, addDaysISO(belgradeTodayISO(), -1));
  if (yesterday) {
    if (yesterday.status === 'done' || yesterday.status === 'partial') {
      const parts = [];
      if (yesterday.status === 'partial') parts.push('частично');
      if (yesterday.distance_km) parts.push(`${yesterday.distance_km} км`);
      if (yesterday.actual) parts.push(yesterday.actual);
      const detail = parts.length ? ` (${parts.join(', ')})` : '';
      lines.push(`Вчера тренировка выполнена${detail} — используй это в утреннем сообщении: скажи живо и тепло, не шаблонно.`);
    } else if (yesterday.status === 'skipped') {
      const freebieNote = yesterday.freebie_covered ? 'потрачен бесплатный пропуск' : 'серия обнулена';
      lines.push(`Вчера тренировка пропущена (${freebieNote}) — поддержи без укора, не акцентируй вину, серия начинается сегодня.`);
    } else if (yesterday.status === 'rest') {
      lines.push(`Вчера плановый отдых — серия не прервалась. Можно упомянуть это позитивно в утреннем сообщении.`);
    } else if (yesterday.status === 'sick') {
      lines.push(
        `Вчера был болен — если сегодня пишет, что стало лучше или снова готов заниматься, обязательно скажи, что серия не прервалась (${streak} дней), это подбодрит.`,
      );
    }
  }

  if (newStreak.length || newKm.length) {
    const parts = [...newStreak.map((v) => `${v} дней подряд`), ...newKm.map((v) => `${v} км суммарно`)];
    lines.push(`Только что пройден рубеж: ${parts.join(', ')}. Обязательно тепло поздравь в этом ответе.`);
  }

  return `\n\nПрогресс/серия (для тебя, не зачитывай как отчёт — вплетай в живую речь, каждый раз разными словами):\n${lines.join('\n')}`;
}
