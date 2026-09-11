import Anthropic from '@anthropic-ai/sdk';
import {
  getWeeklyPlan,
  upsertWeeklyPlan,
  getActiveOverrides,
  upsertOverride,
  getOverrideForDate,
  upsertTrainingLog,
  saveFitnessTestResults,
  addFitnessTestRecord,
  markFitnessTestOffered,
  updateBodyMeasurementSnapshot,
  addBodyMeasurementRecord,
  markMeasurementOffered,
} from './db.js';

const anthropic = new Anthropic();

const TONE_DESCRIPTIONS = {
  строгий: 'Строгий, но справедливый — прямо указывай на слабые места, дожимай, без сюсюканья.',
  партнёр: 'Тренер-партнёр — общайся на равных, вместе разбираетесь, без давления сверху.',
  мягкий: 'Мягкий и бережный — поддерживай, никакого давления, мягкие формулировки.',
};

export const BOT_TIMEZONE = 'Europe/Belgrade';
const CHECKIN_TRIGGER = '[[DAILY_CHECKIN]]';
const DAY_CLOSE_TRIGGER = '[[DAY_CLOSE]]';

function formatNow() {
  const now = new Date();
  const weekday = now.toLocaleDateString('ru-RU', { weekday: 'long', timeZone: BOT_TIMEZONE });
  const date = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: BOT_TIMEZONE });
  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: BOT_TIMEZONE });
  return `${weekday}, ${date}, ${time}`;
}

export function belgradeTodayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: BOT_TIMEZONE });
}

// Дата-арифметика по строке ГГГГ-ММ-ДД: полдень UTC, чтобы переход на летнее
// время не сдвигал день.
function addDaysISO(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function ddmm(iso) {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

// getUTCDay(): 0=вс .. 6=сб → колонка таблицы weekly_plan
const DOW_TO_COLUMN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function isoWeekdayColumn(iso) {
  return DOW_TO_COLUMN[new Date(`${iso}T12:00:00Z`).getUTCDay()];
}

const WEEKDAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKDAY_LABELS = {
  monday: 'Понедельник',
  tuesday: 'Вторник',
  wednesday: 'Среда',
  thursday: 'Четверг',
  friday: 'Пятница',
  saturday: 'Суббота',
  sunday: 'Воскресенье',
};

const PLAN_TOOL = {
  name: 'update_plan',
  description:
    'Сохрани изменения в план тренировок пользователя — постоянную недельную схему и/или разовые исключения на конкретные даты. Вызывай КАЖДЫЙ раз, когда устанавливаешь новый план или меняешь существующий по просьбе пользователя. Не вызывай просто чтобы подтвердить уже действующий план или ответить на общий вопрос. Всегда сопровождай вызов обычным текстовым ответом пользователю в этом же сообщении.',
  input_schema: {
    type: 'object',
    properties: {
      weekly_template: {
        type: 'object',
        description: 'Обновления постоянной недельной схемы. Указывай только те дни, которые меняешь — остальные останутся как были.',
        properties: Object.fromEntries(WEEKDAY_ORDER.map((day) => [day, { type: 'string' }])),
      },
      date_overrides: {
        type: 'array',
        description: 'Разовые исключения на конкретные даты, не меняющие постоянную схему.',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Дата в формате ГГГГ-ММ-ДД' },
            workout: { type: 'string' },
          },
          required: ['date', 'workout'],
        },
      },
    },
  },
};

function applyPlanToolCall(telegramId, input) {
  if (input.weekly_template) {
    upsertWeeklyPlan(telegramId, input.weekly_template);
  }
  if (Array.isArray(input.date_overrides)) {
    for (const { date, workout } of input.date_overrides) {
      if (date && workout) upsertOverride(telegramId, date, workout);
    }
  }
}

// Журнал ФАКТОВ — что реально было, а не что планировалось (update_plan).
// Разграничитель для модели — время действия: update_plan про будущее и
// намерение, log_training_day про уже случившееся.
const TRAINING_LOG_TOOL = {
  name: 'log_training_day',
  description:
    'Зафиксируй факт — что реально произошло с тренировкой в конкретный день, уже случившееся, не намерение и не план. ' +
    'Вызывай, когда пользователь рассказывает, что сделал или не сделал: «сбегал 5 км», «пропустил, не было сил», ' +
    '«сделал только половину», «сегодня по плану отдых, так и было». ' +
    'НЕ вызывай при обсуждении будущего плана или его изменения («давай завтра лучше бег вместо силовой») — для этого update_plan. ' +
    'НЕ вызывай для предположений о будущем («наверное сегодня не успею») — только когда факт уже известен. ' +
    'Если день не указан явно — это сегодня; для другого дня вычисли точную дату от строки «Сейчас:» в конце промпта.',
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'ГГГГ-ММ-ДД, только если пользователь говорит про день, отличный от сегодня' },
      status: {
        type: 'string',
        enum: ['done', 'partial', 'skipped', 'rest', 'sick'],
        description:
          'done — выполнил как планировалось, partial — частично, skipped — пропустил, rest — плановый отдых, sick — не смог по болезни/травме',
      },
      actual: { type: 'string', description: 'Что реально сделал, например «5 км в спокойном темпе вместо силовой»' },
      note: { type: 'string', description: 'Самочувствие/контекст, например «было тяжело, мало спал»' },
    },
    required: ['status'],
  },
};

function applyTrainingLogToolCall(telegramId, input) {
  const iso = input.date || belgradeTodayISO();
  const planned = resolveDayWorkout(telegramId, iso);
  upsertTrainingLog(telegramId, iso, { planned, status: input.status, actual: input.actual, note: input.note });
}

// Календарь отдаём модели уже СВЕДЁННЫМ: на каждый день одна строка, разовые
// исключения уже наложены на постоянную схему. Модель ничего не вычисляет и не
// сопоставляет — просто читает строку нужного дня. Это убирает класс ошибок
// «взял тренировку не того дня» (модель тянулась к тому, что обсуждали недавно).
//
// Окно смотрит и назад (PAST), и вперёд (FUTURE): первая версия смотрела только
// вперёд, и на вопрос «что было вчера» модель не находила исключение на вчера
// (оно раньше today и выпадало из выборки) — вместо этого хватала голый шаблон
// того же дня недели через неделю вперёд, который в окно попадал. Разовое
// исключение в прошлом так же легко теряется, как и в будущем.
const PLAN_PAST_DAYS = 2;
const PLAN_FUTURE_DAYS = 14; // включая сегодня

// Единая точка резолва «что за тренировка в этот день»: исключение на дату
// приоритетнее постоянной схемы. formatPlanSection/buildDayAnchor раньше
// дублировали это выражение каждый по-своему — вынесено, чтобы не разъезжалось.
function resolveWorkout(plan, overrideByDate, iso) {
  const col = isoWeekdayColumn(iso);
  return overrideByDate.get(iso) ?? plan?.[col] ?? 'тренировки нет';
}

// Резолв ЛЮБОЙ даты (не только окна −2..+14 из formatPlanSection) — нужен для
// бэкдейтинга в training_log («в понедельник пропустил» может быть неделю
// назад). Точечный lookup через getOverrideForDate, не getActiveOverrides
// (та возвращает «от даты и дальше вперёд» — не то же самое для одной
// произвольной, возможно далеко прошлой, даты).
export function resolveDayWorkout(telegramId, iso) {
  const plan = getWeeklyPlan(telegramId);
  const workout = getOverrideForDate(telegramId, iso);
  const overrideByDate = workout ? new Map([[iso, workout]]) : new Map();
  return resolveWorkout(plan, overrideByDate, iso);
}

export function formatPlanSection(user) {
  const plan = getWeeklyPlan(user.telegram_id);
  const today = belgradeTodayISO();
  const windowStartISO = addDaysISO(today, -PLAN_PAST_DAYS);
  const overrides = getActiveOverrides(user.telegram_id, windowStartISO);
  const overrideByDate = new Map(overrides.map((o) => [o.date, o.workout]));

  const hasTemplate = plan && WEEKDAY_ORDER.some((day) => plan[day]);
  if (!hasTemplate && overrides.length === 0) {
    return 'Текущий план тренировок: ещё не составлен. Если пользователь просит план или расписание — составь его и сохрани через update_plan.';
  }

  const lastWindowISO = addDaysISO(today, PLAN_FUTURE_DAYS - 1);
  const DAY_LABELS = { [-2]: 'ПОЗАВЧЕРА, ', [-1]: 'ВЧЕРА, ', 0: 'СЕГОДНЯ, ', 1: 'ЗАВТРА, ' };
  const rows = [];
  for (let i = -PLAN_PAST_DAYS; i < PLAN_FUTURE_DAYS; i++) {
    const iso = addDaysISO(today, i);
    const col = isoWeekdayColumn(iso);
    const prefix = DAY_LABELS[i] ?? '';
    const changed = overrideByDate.has(iso);
    const workout = resolveWorkout(plan, overrideByDate, iso);
    rows.push(`- ${prefix}${WEEKDAY_LABELS[col]} ${ddmm(iso)}: ${workout}${changed ? '  [разовое изменение на этот день]' : ''}`);
  }

  const beyond = overrides
    .filter((o) => o.date > lastWindowISO)
    .map((o) => `- ${WEEKDAY_LABELS[isoWeekdayColumn(o.date)]} ${ddmm(o.date)}: ${o.workout}`);

  return `Текущий план тренировок — готовый календарь на прошлые и ближайшие дни (постоянная недельная схема и разовые изменения на даты уже сведены вместе):

${rows.join('\n')}${beyond.length ? `\n\nДальше по датам:\n${beyond.join('\n')}` : ''}

Как отвечать про тренировки:
- Называешь тренировку на день — бери строку этого дня из календаря дословно. Не складывай соседние дни и ничего не переноси сам, всё уже сведено.
- Если в строке сказано, что тренировка отменена или перенесена — так и передай, не подставляй туда тренировку другого дня.
- Это источник правды о плане, а не переписка выше.
- Меняешь план или ставишь разовое исключение — вызови update_plan.`;
}

// Короткая выжимка на 4 дня (вчера тоже — «как прошло вчера» после утреннего
// чек-ина встречается постоянно). Приклеивается к последнему сообщению
// пользователя в самом вызове API (не в БД) — это последнее, что модель видит
// перед ответом, поэтому рекенси работает на нас: свежий факт бьёт «что
// обсуждали 2 реплики назад».
export function buildDayAnchor(user) {
  const plan = getWeeklyPlan(user.telegram_id);
  const today = belgradeTodayISO();
  const overrides = getActiveOverrides(user.telegram_id, addDaysISO(today, -1));
  const overrideByDate = new Map(overrides.map((o) => [o.date, o.workout]));

  const hasPlan = (plan && WEEKDAY_ORDER.some((day) => plan[day])) || overrides.length > 0;
  if (!hasPlan) return '';

  const lines = [
    ['вчера', -1],
    ['сегодня', 0],
    ['завтра', 1],
  ].map(([label, i]) => {
    const iso = addDaysISO(today, i);
    const col = isoWeekdayColumn(iso);
    const workout = resolveWorkout(plan, overrideByDate, iso);
    return `${label} (${WEEKDAY_LABELS[col]} ${ddmm(iso)}) — ${workout}`;
  });

  return `[Служебный контекст, не сообщение пользователя. Сверяйся с этим, а не с обсуждением выше:
${lines.join('\n')}
Спрашивают про день из этого списка — отвечай ровно этой строкой. Отменено/перенесено — так и говори.]`;
}

// Приклеить выжимку к последнему сообщению пользователя. Не трогаем сигнал
// чек-ина (он должен остаться «ровно [[DAILY_CHECKIN]]»), пустую выжимку и
// мультимодальные сообщения (фото еды — там content уже массив блоков, а не
// строка; `${content}` на массиве сломал бы его в мусорную строку).
function appendDayAnchor(user, messages) {
  const anchor = buildDayAnchor(user);
  const last = messages[messages.length - 1];
  if (!anchor || !last || last.role !== 'user' || typeof last.content !== 'string' || last.content === CHECKIN_TRIGGER) {
    return messages;
  }
  return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${anchor}` }];
}

const FITNESS_TEST_TOOL = {
  name: 'save_fitness_test_results',
  description:
    'Сохрани результаты теста физической готовности, которые сообщил пользователь. Указывай только то, что он реально рассказал — не обязательно все поля сразу, тест можно проходить по частям.',
  input_schema: {
    type: 'object',
    properties: {
      pushups: { type: 'string', description: 'Например: "20 без остановки, легко" или "выбрал 10, было тяжело на последних"' },
      plank: { type: 'string', description: 'Например: "1 минута без проблем" или "1:40, максимум"' },
      resting_hr: { type: 'string', description: 'Пульс в покое, например "62 уд/мин утром лёжа"' },
      run: { type: 'string', description: 'Комфортная дистанция/темп разговорным темпом (для профиля выносливость), например "5 км в 6:30/км спокойно"' },
    },
  },
};

function applyFitnessTestToolCall(telegramId, input) {
  saveFitnessTestResults(telegramId, input); // снимок последнего теста (как было)
  addFitnessTestRecord(telegramId, belgradeTodayISO(), input); // + история всех тестов
}

// Расписание в днях между предложениями теста: первое сразу, потом 2, 5, 10,
// дальше каждые 14 — растущий интервал без давления, но не забываем совсем.
const FITNESS_TEST_SCHEDULE_DAYS = [0, 2, 5, 10, 14];

function daysBetweenISO(fromISO, toISO) {
  return Math.round((new Date(`${toISO}T00:00:00Z`) - new Date(`${fromISO}T00:00:00Z`)) / 86400000);
}

function formatFitnessTestSection(user) {
  const hasResults =
    user.fitness_test_pushups || user.fitness_test_plank || user.fitness_test_resting_hr || user.fitness_test_run;
  if (hasResults) return '';

  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: BOT_TIMEZONE });
  const offerCount = user.fitness_test_offer_count || 0;
  const requiredGap = FITNESS_TEST_SCHEDULE_DAYS[Math.min(offerCount, FITNESS_TEST_SCHEDULE_DAYS.length - 1)];

  const shouldOffer = !user.fitness_test_last_offered_at || daysBetweenISO(user.fitness_test_last_offered_at, todayISO) >= requiredGap;
  if (!shouldOffer) return '';

  markFitnessTestOffered(user.telegram_id, todayISO);

  return `

Сейчас подходящий момент мягко предложить тест физической готовности (${offerCount === 0 ? 'первое предложение' : `повторное предложение, откладывали уже ${offerCount} раз`}). Впиши это органично в ответ, объясни коротко пользу — точнее план и понимание текущей формы. Без давления: если пользователь не готов или уходит от темы, просто продолжай разговор как обычно, не настаивай и не повторяй в этом же ответе.`;
}

const BODY_MEASUREMENTS_TOOL = {
  name: 'log_body_measurements',
  description:
    'Сохрани результаты замера тела, которые сообщил пользователь — вес и/или объёмы. Указывай только то, что он реально назвал, не обязательно все поля сразу.',
  input_schema: {
    type: 'object',
    properties: {
      weight: { type: 'string', description: 'Вес, например "78 кг"' },
      waist: { type: 'string', description: 'Объём талии, например "82 см"' },
      chest: { type: 'string', description: 'Объём груди (опционально)' },
      hips: { type: 'string', description: 'Объём бёдер (опционально)' },
    },
  },
};

function applyBodyMeasurementsToolCall(telegramId, input) {
  const iso = belgradeTodayISO();
  addBodyMeasurementRecord(telegramId, iso, input); // история всех замеров
  updateBodyMeasurementSnapshot(telegramId, input); // снимок последнего — это же обновляет users.weight
}

// Не гасится навсегда после первого замера (в отличие от теста готовности
// выше) — замеры повторяются регулярно, это и есть смысл фичи. Интервал не
// убывающий ramp (тест готовности рассчитан «предложить раз и отстать»), а
// держится около недели: первое предложение сразу доступно, дальше — каждые
// 7 дней от последнего (Math.min естественно держит хвост на 7).
const MEASUREMENT_SCHEDULE_DAYS = [0, 7];

function formatMeasurementsSection(user) {
  const todayISO = belgradeTodayISO();
  const offerCount = user.measurement_offer_count || 0;
  const requiredGap = MEASUREMENT_SCHEDULE_DAYS[Math.min(offerCount, MEASUREMENT_SCHEDULE_DAYS.length - 1)];

  const shouldOffer = !user.measurement_last_offered_at || daysBetweenISO(user.measurement_last_offered_at, todayISO) >= requiredGap;
  if (!shouldOffer) return '';

  markMeasurementOffered(user.telegram_id, todayISO);

  // Про грудь/бёдра — только в самом первом предложении за всё время: дальше
  // не упоминаем, чтобы не наседать на тех, кому это не интересно (сам юзер
  // может прислать их в любой момент — tool это всё равно примет).
  return `

Сейчас подходящий момент мягко напомнить про замеры тела — в конце ответа, не отдельным вопросом (как с чек-ином — не разбивай реплику на два смысловых куска). Вес и талия по утрам натощак.${offerCount === 0 ? ' Можешь также упомянуть, что при желании — ещё и грудь/бёдра.' : ''} Без нажима: если сегодня не удобно, просто продолжай разговор как обычно.`;
}

// Замороженная часть промпта: одинакова для всех пользователей и не меняется
// между запросами. Идёт первой — потом на неё можно будет повесить кэш.
const FROZEN_INSTRUCTIONS = `Ты — персональный AI-тренер в Telegram-боте Run Eat Fit. Живой коуч с памятью о жизни пользователя, не калькулятор калорий: держишь контекст (усталость, перелёт, настроение) и подстраиваешь план под него.

Текущие дата, день недели и время указаны в самом конце этого промпта — строка «Сейчас:». Это единственный источник правды о текущем моменте. «Сегодня», «завтра», «на этой неделе» считай строго от неё: не угадывай, не бери дату из памяти обучения и не сдвигай день из-за того, что в переписке недавно шла речь про «завтра» или «четверг». Один разговор может идти несколько дней подряд — строка «Сейчас:» всегда актуальна на момент ответа.

Тест физической готовности (правила проведения, когда предлагаешь или ведёшь его):
- НЕ проси делать что-то «до отказа» — для новичка, который не может выполнить ни одного повтора, это унизительно и обесценивает его усилия. Всегда давай выбор.
- Отжимания: предложи на выбор — 10, 20, 30 повторений или «проверь свой максимум». После — спроси, как ощущалось (легко / тяжело / не смог).
- Планка: тот же принцип — 1 минута, 2 минуты, или свой максимум.
- Пульс в покое: у большинства нет трекера на руке — обязательно подскажи, как измерить руками: нащупать пульс на запястье или на шее, посчитать удары за 15 секунд и умножить на 4. Лучше сразу после пробуждения, лёжа, до того как встал.
- Комфортный бег без одышки (дистанция/темп разговорным темпом) — предлагай только если профиль нагрузки «выносливость», силовикам эта часть не нужна.
- Когда пользователь сообщает результат хотя бы одного теста — вызови save_fitness_test_results с тем, что он реально сказал. Не обязательно проходить всё за один раз.

Ты — conditioning/lifestyle-коуч: питание, разминка, восстановление, календарь тренировок. Не учишь технике конкретного вида спорта — не твоя экспертиза. Возраст, пол, вес и рост используй для точных расчётов (калораж, ориентир по темпу, нагрузке, скорость восстановления) — не для общих фраз. Возраст особенно влияет на восстановление и риск перегрузки — 20-летний и 40-летний с одинаковой тренировкой восстанавливаются по-разному.

Когда советуешь по питанию — всегда конкретный пример, не абстрактные категории. Не «углеводы + белок», а «банан с ложкой арахисовой пасты» или «овсянка на воде с бананом». И указывай время относительно тренировки (за сколько до/после) — «поешь нормально» без таймфрейма не инструкция, а общие слова.

Если расписываешь питание на день (несколько приёмов пищи, не один совет) — обязательно закладывай 1-2 полезных перекуса между основными приёмами, не только завтрак/обед/ужин. Люди, особенно после бесконтрольного питания, будут срываться и искать, что перекусить между приёмами — если не предложить вариант заранее, схватят первое попавшееся под руку. Перекус — тоже конкретный пример (яблоко с горстью орехов, творог, хумус с овощами), не абстрактное «перекуси чем-то полезным».

Отвечай коротко, по-человечески, без канцелярита.

Форматирование (Telegram HTML, не Markdown):
- Жирный — <b>текст</b>, курсив — <i>текст</i>, моноширинный (темп, время, дистанции) — <code>текст</code>
- НЕ используй **, __, # и другую Markdown-разметку — Telegram её не понимает, покажет звёздочки как есть
- Таблиц Telegram не поддерживает. Если нужно расписание по дням — оформляй списком с эмодзи-маркером на каждый день (🏃 бег, 🎾 теннис, 😴 отдых, 💪 силовая), не заголовками КАПСОМ
- Эмодзи — умеренно, для визуальной иерархии, не в каждой строке

Подача плана:
- План — это готовый календарь ниже («Текущий план тренировок»), не то, что нужно домысливать из переписки. Когда называешь тренировку на день — бери строку этого дня из календаря, а не реконструируй по памяти из более ранних сообщений.
- Если устанавливаешь план впервые, меняешь постоянную схему или добавляешь разовое исключение на дату — обязательно вызови update_plan, чтобы сохранить это. Без вызова инструмента изменение не сохранится, и в следующий раз ты снова увидишь старый план.
- Если даёшь развёрнутый план или расписание на несколько дней — сразу дай понять, что это ориентир, а не то, что нужно запомнить наизусть. Скажи, что будешь на связи каждый день: пользователь делится самочувствием, а план вы вместе подстраиваете под него.
- Если только что выдал(а) план тренировок или разговор плотно касался питания — предложи составить список покупок для сбалансированного и вкусного питания. Для этого на отдельной строке в конце ответа поставь маркер [[SPLIT]], а сразу после него — короткое предложение вроде «Если хочешь, могу составить список покупок для сбалансированного, вкусного питания!». Это уйдёт отдельным сообщением. Если предложение неуместно (обычный короткий разговор, вопрос не по теме) — маркер не добавляй.

Журнал фактов (отдельно от плана — план это намерение, журнал это что реально было):
- Пользователь рассказывает, что сделал или не сделал (сбегал, пропустил, сделал частично, отдохнул как планировалось) — вызови log_training_day. Это не то же самое, что update_plan: факт о прошлом, а не изменение будущей схемы.
- Не путай с изменением плана («давай завтра лучше бег вместо силовой» — это update_plan) и с предположениями о будущем («наверное сегодня не успею» — это вообще не факт, ничего не вызывай, пока не станет известно точно).

Замеры тела (не путай с тестом физической готовности и не с журналом тренировок):
- Пользователь сообщает вес и/или объёмы (талия/грудь/бёдра) — вызови log_body_measurements. Это отдельный tool от save_fitness_test_results (тот про отжимания/планку/пульс/бег) и от log_training_day (тот про факт тренировки).
- Не обязательно все поля сразу — что назвал, то и сохраняй.

Ежедневный чек-ин:
- Сообщение с текстом ровно ${CHECKIN_TRIGGER} — это не реплика пользователя, а системный сигнал: настало выбранное им время, и сейчас пишешь первым ты. Не упоминай этот текст и не реагируй на него как на вопрос — вместо этого сам инициируй короткое сообщение с минимальным порогом входа (например «одним словом — как ты сегодня?», «как спалось, как тело после вчерашнего?»), без «отчитайся о тренировке».
- Это сообщение — только сам вопрос, ничего больше. Не добавляй к нему ремарки, уточнения или комментарии в скобках («и да, сегодня можно отдыхать» и т.п.) — реальные люди в утреннем сообщении так не пишут, это разбивает на два смысловых куска то, что должно быть одной короткой репликой. Всё, что хочешь сказать по плану на сегодня — прибереги для следующего ответа, после того как пользователь откликнется.
- Если в истории видно, что на твой предыдущий такой сигнал пользователь не ответил (два твоих сообщения подряд без ответа между ними) — не ругай и не дави. Мягко верни его в разговор, предложи облегчённый вариант на сегодня.

Закрытие дня:
- Сообщение с текстом ровно ${DAY_CLOSE_TRIGGER} — системный сигнал, не реплика пользователя: день заканчивается, а факт по сегодняшней тренировке ещё не известен (пользователь не рассказал в течение дня). Спроси коротко и мягко, что по плану на сегодня — без допроса, без «ты не отчитался».
- Когда пользователь ответит — если это факт (сделал/не сделал/частично) — вызови log_training_day, как в любом другом разговоре.
- Это отдельный, более редкий сигнал, не путай с ${CHECKIN_TRIGGER} — тот утром инициирует разговор, этот вечером подбирает то, что за день не прозвучало.

Фото еды:
- Если в последнем сообщении пользователя есть картинка — это фото того, что он ест или собирается есть. Дай короткую качественную оценку разговорным тоном: баланс белка/углеводов/овощей, чего не хватает, что добавить или убрать в следующий раз. НЕ считай и не называй точные калории, граммы или БЖУ в цифрах — бот не калькулятор калорий, оценка на глаз, как сказал бы живой тренер, а не приложение для подсчёта.
- Если уместно — свяжи с планом на сегодня (например, это до или после тренировки, что дальше по расписанию).
- Если фото нечёткое, тёмное или на нём не похоже на еду — мягко скажи об этом и попроси переснять или уточнить словами, не выдумывай, что на фото.`;

// Порядок: замороженные инструкции → профиль пользователя → тест готовности →
// календарь плана → текущее время. Самое волатильное («Сейчас:») — в конце,
// ближе всего к вопросу пользователя.
//
// Возвращаем массив блоков (не строку) с двумя точками кэширования:
// 1. FROZEN_INSTRUCTIONS — одинаков для всех пользователей и дней, самый
//    большой выигрыш (кэш-хит даже на первом сообщении нового юзера).
// 2. Профиль + тест готовности + календарь плана — меняется раз в день на
//    юзера (окно календаря сдвигается по дате), но стабилен между
//    сообщениями внутри одного дня — а их за день много.
// «Сейчас:» не кэшируем — меняется на каждый запрос, кэшировать нечего.
export function buildSystemPrompt(user) {
  const profileSection = `—— Дальше — данные под конкретного пользователя и текущий момент ——

Профиль пользователя:
- Цель: ${user.goal}
- Возраст: ${user.age}
- Пол: ${user.gender}
- Вес: ${user.weight} кг
- Рост: ${user.height} см
- Профиль нагрузки: ${user.activity}
- Стиль общения: ${TONE_DESCRIPTIONS[user.tone] ?? user.tone}
${formatFitnessTestSection(user)}
${formatMeasurementsSection(user)}

${formatPlanSection(user)}`;

  return [
    { type: 'text', text: FROZEN_INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: profileSection, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Сейчас: ${formatNow()} (${BOT_TIMEZONE}).` },
  ];
}

function markdownToTelegramHtml(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<i>$2</i>');
}

const WEEKDAYS_RU = 'понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресень[еэ]';

// Модель иногда путает день недели (держится за то, что сама сказала раньше
// в этом же диалоге, а не за свежую дату в системном промпте). Прогоняем
// ответ через детерминированную сверку с реальным календарём как страховку.
function weekdayForDDMM(day, month) {
  const now = new Date();
  const currentYear = Number(now.toLocaleDateString('en-CA', { timeZone: BOT_TIMEZONE }).slice(0, 4));
  let candidate = new Date(Date.UTC(currentYear, month - 1, day, 12));
  if (candidate.getTime() < now.getTime() - 30 * 86400000) {
    candidate = new Date(Date.UTC(currentYear + 1, month - 1, day, 12));
  }
  return candidate.toLocaleDateString('ru-RU', { weekday: 'long', timeZone: BOT_TIMEZONE });
}

function dayInfo(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return {
    weekday: d.toLocaleDateString('ru-RU', { weekday: 'long', timeZone: BOT_TIMEZONE }),
    dm: d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: BOT_TIMEZONE }),
  };
}

// В JS \b не распознаёт границы слов у кириллицы (\w — это [A-Za-z0-9_]),
// поэтому границы слова делаем вручную через lookaround.
const CB = '(?<![а-яёА-ЯЁ])';
const CA = '(?![а-яёА-ЯЁ])';

function matchCase(original, replacement) {
  if (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function correctDateMentions(text) {
  const today = dayInfo(0);
  const tomorrow = dayInfo(1);

  // «сегодня/завтра <день недели> (ДД.ММ)?» — правим и день недели, и дату разом
  // по смыслу маркера (это самый частый вид ошибки: оба сдвинуты синхронно,
  // поэтому пара сама по себе внутренне непротиворечива, но не совпадает с «сегодня»).
  let fixed = text.replace(
    new RegExp(`${CB}(сегодня|завтра)${CA}([^.!?\\n]{0,15}?)${CB}(${WEEKDAYS_RU})${CA}(\\s*\\(\\d{2}\\.\\d{2}\\))?`, 'gi'),
    (match, marker, gap, weekday, dateGroup) => {
      const info = marker.toLowerCase() === 'завтра' ? tomorrow : today;
      return `${marker}${gap}${matchCase(weekday, info.weekday)}${dateGroup ? ` (${info.dm})` : ''}`;
    },
  );

  // Оставшиеся пары «день недели + ДД.ММ» без сегодня/завтра рядом (например дата
  // гонки) — подстраховка на случай, если день недели и дата противоречат друг другу.
  fixed = fixed.replace(
    new RegExp(`${CB}(${WEEKDAYS_RU})${CA}(\\s*\\(?\\s*)(\\d{2})\\.(\\d{2})`, 'gi'),
    (match, weekday, sep, dd, mm) => `${matchCase(weekday, weekdayForDDMM(Number(dd), Number(mm)))}${sep}${dd}.${mm}`,
  );

  return fixed;
}

const COACH_MODEL = 'claude-haiku-4-5';
const COACH_MAX_TOKENS = 1500;
const COACH_MAX_TOKENS_RETRY = 3000;

function requestCoach(user, messages, maxTokens) {
  // Без параметра thinking — у Haiku 4.5 это и есть режим «без рассуждений»
  // (у неё нет type:disabled; включается только через budget_tokens).
  return anthropic.messages.create({
    model: COACH_MODEL,
    max_tokens: maxTokens,
    system: buildSystemPrompt(user),
    tools: [PLAN_TOOL, FITNESS_TEST_TOOL, TRAINING_LOG_TOOL, BODY_MEASUREMENTS_TOOL],
    messages: appendDayAnchor(user, messages),
  });
}

// Разбирает ответ модели: применяет вызовы инструментов, возвращает текст для
// пользователя. null — если модель не дала ничего пригодного (ни текста, ни
// инструмента); тогда callCoach решает, повторять или падать.
// Заглушка на случай, если модель вызвала tool, но не сопроводила его
// текстом (промпт просит так не делать, но подстраховка нужна) — по
// последнему вызванному tool'у, чтобы не говорить «обновил план» про лог.
const TOOL_FALLBACK_REPLY = {
  update_plan: 'Обновил план.',
  save_fitness_test_results: 'Записал результаты теста.',
  log_training_day: 'Записал.',
  log_body_measurements: 'Записал замеры.',
};

function extractReply(user, response) {
  let fallbackReply = null;
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'update_plan') {
      applyPlanToolCall(user.telegram_id, block.input);
      fallbackReply = TOOL_FALLBACK_REPLY.update_plan;
    }
    if (block.type === 'tool_use' && block.name === 'save_fitness_test_results') {
      applyFitnessTestToolCall(user.telegram_id, block.input);
      fallbackReply = TOOL_FALLBACK_REPLY.save_fitness_test_results;
    }
    if (block.type === 'tool_use' && block.name === 'log_training_day') {
      applyTrainingLogToolCall(user.telegram_id, block.input);
      fallbackReply = TOOL_FALLBACK_REPLY.log_training_day;
    }
    if (block.type === 'tool_use' && block.name === 'log_body_measurements') {
      applyBodyMeasurementsToolCall(user.telegram_id, block.input);
      fallbackReply = TOOL_FALLBACK_REPLY.log_body_measurements;
    }
  }

  const textBlocks = response.content.filter((block) => block.type === 'text');
  if (textBlocks.length > 0) {
    const rawText = textBlocks.map((block) => block.text).join('\n\n');
    return markdownToTelegramHtml(correctDateMentions(rawText));
  }
  return fallbackReply;
}

async function callCoach(user, messages) {
  let response = await requestCoach(user, messages, COACH_MAX_TOKENS);
  let reply = extractReply(user, response);

  // Упёрлись в лимит и не успели выдать ни текст, ни вызов инструмента —
  // один повтор с запасом по токенам.
  if (reply === null && response.stop_reason === 'max_tokens') {
    response = await requestCoach(user, messages, COACH_MAX_TOKENS_RETRY);
    reply = extractReply(user, response);
  }

  if (reply === null) {
    throw new Error(`Пустой ответ коуча (stop_reason: ${response.stop_reason})`);
  }
  return reply;
}

export async function getCoachReply(user, history) {
  return callCoach(user, history);
}

export async function getCheckinTrigger(user, history) {
  return callCoach(user, [...history, { role: 'user', content: CHECKIN_TRIGGER }]);
}

export async function getDayCloseTrigger(user, history) {
  return callCoach(user, [...history, { role: 'user', content: DAY_CLOSE_TRIGGER }]);
}

// Фото еды: история уже содержит лёгкий текстовый плейсхолдер последней
// записью (сама картинка в БД не хранится — разовая, большая, не нужна для
// памяти). Подменяем его на мультимодальный блок только для этого вызова API.
function buildPhotoUserMessage(caption, photo) {
  return {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: photo.mediaType, data: photo.data } },
      { type: 'text', text: caption || 'Вот что я сейчас ем.' },
    ],
  };
}

export async function getCoachPhotoReply(user, history, photo, caption) {
  const messages = [...history.slice(0, -1), buildPhotoUserMessage(caption, photo)];
  return callCoach(user, messages);
}
