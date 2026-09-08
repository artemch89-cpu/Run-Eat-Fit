const STEP_ORDER = ['goal', 'activity', 'tone', 'checkin_time'];

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

export function getNextStep(user) {
  return STEP_ORDER.find((field) => !user[field]) ?? null;
}

export function isButtonStep(field) {
  return field in QUESTIONS;
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

export function parseCheckinTime(input) {
  const match = input.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

export function completionMessage() {
  return 'Готово! Настройки сохранены. Буду писать тебе каждый день в выбранное время — начинаем.';
}
