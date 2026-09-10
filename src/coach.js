import Anthropic from '@anthropic-ai/sdk';
import {
  getWeeklyPlan,
  upsertWeeklyPlan,
  getActiveOverrides,
  upsertOverride,
  saveFitnessTestResults,
  markFitnessTestOffered,
} from './db.js';

const anthropic = new Anthropic();

const TONE_DESCRIPTIONS = {
  строгий: 'Строгий, но справедливый — прямо указывай на слабые места, дожимай, без сюсюканья.',
  партнёр: 'Тренер-партнёр — общайся на равных, вместе разбираетесь, без давления сверху.',
  мягкий: 'Мягкий и бережный — поддерживай, никакого давления, мягкие формулировки.',
};

export const BOT_TIMEZONE = 'Europe/Belgrade';
const CHECKIN_TRIGGER = '[[DAILY_CHECKIN]]';

function formatNow() {
  const now = new Date();
  const weekday = now.toLocaleDateString('ru-RU', { weekday: 'long', timeZone: BOT_TIMEZONE });
  const date = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: BOT_TIMEZONE });
  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: BOT_TIMEZONE });
  return `${weekday}, ${date}, ${time}`;
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

function formatPlanSection(user) {
  const plan = getWeeklyPlan(user.telegram_id);
  const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: BOT_TIMEZONE });
  const overrides = getActiveOverrides(user.telegram_id, todayISO);

  const templateLines = WEEKDAY_ORDER.map((day) => `- ${WEEKDAY_LABELS[day]}: ${plan?.[day] ?? 'не задано'}`).join('\n');

  const overrideLines = overrides.length
    ? overrides
        .map((o) => {
          const d = new Date(`${o.date}T12:00:00`);
          const weekday = d.toLocaleDateString('ru-RU', { weekday: 'long', timeZone: BOT_TIMEZONE });
          const dm = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: BOT_TIMEZONE });
          return `- ${dm} (${weekday}): ${o.workout}`;
        })
        .join('\n')
    : '— нет активных исключений';

  return `Текущий план тренировок (структурированные данные — источник правды, не переопределяй его домыслами из истории разговора):

Постоянная недельная схема:
${templateLines}

Разовые исключения на конкретные даты (действуют только в указанный день, не меняют постоянную схему; уже прошедшие даты здесь не показаны):
${overrideLines}

Когда называешь тренировку на сегодня/завтра/любой конкретный день — сначала проверь, нет ли разового исключения на эту дату; если есть, используй его; если нет — бери постоянную схему для этого дня недели.`;
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
  saveFitnessTestResults(telegramId, input);
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

function buildSystemPrompt(user) {
  return `Ты — персональный AI-тренер в Telegram-боте Run Eat Fit. Живой коуч с памятью о жизни пользователя, не калькулятор калорий: держишь контекст (усталость, перелёт, настроение) и подстраиваешь план под него.

Сейчас: ${formatNow()} (${BOT_TIMEZONE}). Это единственный источник правды о текущей дате и дне недели. Используй строго её, когда говоришь о «сегодня», «завтра», «на этой неделе» — не угадывай, не бери дату из памяти обучения и не додумывай, что раз в переписке недавно шла речь про «завтра» или «четверг», то время само сдвинулось на день вперёд. Один разговор может идти несколько дней подряд — дата в этой строке всегда актуальна на момент твоего ответа, даже если по логике диалога кажется иначе.

Профиль пользователя:
- Цель: ${user.goal}
- Возраст: ${user.age}
- Пол: ${user.gender}
- Вес: ${user.weight} кг
- Рост: ${user.height} см
- Профиль нагрузки: ${user.activity}
- Стиль общения: ${TONE_DESCRIPTIONS[user.tone] ?? user.tone}

${formatPlanSection(user)}
${formatFitnessTestSection(user)}

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
- План — это структурированные данные выше («Текущий план тренировок»), не то, что нужно домысливать из истории разговора. Когда называешь тренировку на день — бери её оттуда, а не реконструируй по памяти из более ранних сообщений.
- Если устанавливаешь план впервые, меняешь постоянную схему или добавляешь разовое исключение на дату — обязательно вызови update_plan, чтобы сохранить это. Без вызова инструмента изменение не сохранится, и в следующий раз ты снова увидишь старый план.
- Если даёшь развёрнутый план или расписание на несколько дней — сразу дай понять, что это ориентир, а не то, что нужно запомнить наизусть. Скажи, что будешь на связи каждый день: пользователь делится самочувствием, а план вы вместе подстраиваете под него.
- Если только что выдал(а) план тренировок или разговор плотно касался питания — предложи составить список покупок для сбалансированного и вкусного питания. Для этого на отдельной строке в конце ответа поставь маркер [[SPLIT]], а сразу после него — короткое предложение вроде «Если хочешь, могу составить список покупок для сбалансированного, вкусного питания!». Это уйдёт отдельным сообщением. Если предложение неуместно (обычный короткий разговор, вопрос не по теме) — маркер не добавляй.

Ежедневный чек-ин:
- Сообщение с текстом ровно ${CHECKIN_TRIGGER} — это не реплика пользователя, а системный сигнал: настало выбранное им время, и сейчас пишешь первым ты. Не упоминай этот текст и не реагируй на него как на вопрос — вместо этого сам инициируй короткое сообщение с минимальным порогом входа (например «одним словом — как ты сегодня?», «как спалось, как тело после вчерашнего?»), без «отчитайся о тренировке».
- Это сообщение — только сам вопрос, ничего больше. Не добавляй к нему ремарки, уточнения или комментарии в скобках («и да, сегодня можно отдыхать» и т.п.) — реальные люди в утреннем сообщении так не пишут, это разбивает на два смысловых куска то, что должно быть одной короткой репликой. Всё, что хочешь сказать по плану на сегодня — прибереги для следующего ответа, после того как пользователь откликнется.
- Если в истории видно, что на твой предыдущий такой сигнал пользователь не ответил (два твоих сообщения подряд без ответа между ними) — не ругай и не дави. Мягко верни его в разговор, предложи облегчённый вариант на сегодня.`;
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

async function callCoach(user, messages) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    thinking: { type: 'disabled' },
    system: buildSystemPrompt(user),
    tools: [PLAN_TOOL, FITNESS_TEST_TOOL],
    messages,
  });

  let calledTool = false;
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'update_plan') {
      applyPlanToolCall(user.telegram_id, block.input);
      calledTool = true;
    }
    if (block.type === 'tool_use' && block.name === 'save_fitness_test_results') {
      applyFitnessTestToolCall(user.telegram_id, block.input);
      calledTool = true;
    }
  }

  const textBlocks = response.content.filter((block) => block.type === 'text');
  if (textBlocks.length === 0) {
    if (calledTool) {
      return 'Обновил план.';
    }
    throw new Error(`No text block in coach response (stop_reason: ${response.stop_reason})`);
  }
  const rawText = textBlocks.map((block) => block.text).join('\n\n');
  return markdownToTelegramHtml(correctDateMentions(rawText));
}

export async function getCoachReply(user, history) {
  return callCoach(user, history);
}

export async function getCheckinTrigger(user, history) {
  return callCoach(user, [...history, { role: 'user', content: CHECKIN_TRIGGER }]);
}
