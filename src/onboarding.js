const STEP_ORDER = ['goal', 'age', 'gender', 'weight', 'height', 'activity', 'tone', 'checkin_time'];

// Служебное значение goal, пока не пришло уточнение после кнопки «Другое» —
// технический маркер, не показывается пользователю и никогда не попадает в
// коуч-промпт (getNextStep держит шаг goal «неотвеченным», пока он не заменён
// на реальный текст).
export const GOAL_OTHER_PENDING = '__goal_other_pending__';

const QUESTIONS = {
  goal: {
    text: 'Привет! Я твой персональный тренер. Начнём с цели — какая она у тебя?',
    options: [
      ['Похудение', 'похудение'],
      ['Бег', 'бег'],
      ['Подтягивания', 'подтягивания'],
      ['Другое', 'другое'],
    ],
  },
  gender: {
    text: 'Какой у тебя пол? Нужно для точного расчёта темпа, калорий и нагрузки.',
    options: [
      ['Мужской', 'мужской'],
      ['Женский', 'женский'],
    ],
  },
  activity: {
    text: 'Какой профиль нагрузки тебе ближе?',
    options: [
      ['Выносливость (бег, кардио)', 'выносливость'],
      ['Силовая (зал, подтягивания)', 'силовая'],
    ],
  },
  tone: {
    text: 'Какой тренер тебе нужен?',
    options: [
      ['Строгий, но справедливый', 'строгий'],
      ['Тренер-партнёр', 'партнёр'],
      ['Мягкий и бережный', 'мягкий'],
    ],
  },
};

function parseAge(input) {
  const n = Number(input.trim());
  if (!Number.isInteger(n) || n < 10 || n > 100) return null;
  return String(n);
}

function parseWeight(input) {
  const n = Number(input.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 30 || n > 250) return null;
  return String(n);
}

function parseHeight(input) {
  const n = Number(input.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 100 || n > 230) return null;
  return String(n);
}

function parseCheckinTime(input) {
  const match = input.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

const TEXT_STEPS = {
  age: {
    prompt: 'Сколько тебе лет? Восстановление и риск перегрузки сильно зависят от возраста.',
    parse: parseAge,
    errorMessage: 'Не понял. Напиши возраст числом, например 35',
  },
  weight: {
    prompt: 'Твой вес в кг? Нужно для расчёта питания и нагрузки. Просто число, например 70',
    parse: parseWeight,
    errorMessage: 'Не понял. Напиши вес в кг числом, например 70',
  },
  height: {
    prompt: 'Твой рост в см? Просто число, например 175',
    parse: parseHeight,
    errorMessage: 'Не понял. Напиши рост в см числом, например 175',
  },
  checkin_time: {
    prompt: 'В какое время тебе удобно, чтобы я писал первым? Формат ЧЧ:ММ, например 08:00',
    parse: parseCheckinTime,
    errorMessage: 'Не понял формат. Напиши время как ЧЧ:ММ, например 08:00',
  },
};

export function getNextStep(user) {
  if (!user.goal || user.goal === GOAL_OTHER_PENDING) return 'goal';
  return STEP_ORDER.slice(1).find((field) => !user[field]) ?? null;
}

export function isButtonStep(field) {
  return field in QUESTIONS;
}

export function isAwaitingGoalDetail(user) {
  return user.goal === GOAL_OTHER_PENDING;
}

export function goalDetailPrompt() {
  return 'Расскажи своими словами, какая у тебя цель.';
}

export function isTextStep(field) {
  return field in TEXT_STEPS;
}

export function buildQuestion(field) {
  const q = QUESTIONS[field];
  return {
    text: q.text,
    keyboard: {
      inline_keyboard: q.options.map(([label, value]) => [{ text: label, callback_data: `${field}:${value}` }]),
    },
  };
}

export function getTextStepPrompt(field) {
  return TEXT_STEPS[field].prompt;
}

export function getTextStepError(field) {
  return TEXT_STEPS[field].errorMessage;
}

export function parseTextStep(field, input) {
  return TEXT_STEPS[field].parse(input);
}

export function completionMessage() {
  return 'Готово! Настройки сохранены. Буду писать тебе каждый день в выбранное время — начинаем.';
}
