import 'dotenv/config';
import { Telegraf } from 'telegraf';
import {
  createUser,
  getUser,
  updateUser,
  addMessage,
  getHistory,
  getUsersDueForCheckin,
  markCheckinSent,
  getLastUserMessageDate,
  getUsersDueForDayClose,
  markDayCloseSent,
  setPendingEditField,
  clearPendingEditField,
} from './db.js';
import {
  getNextStep,
  buildQuestion,
  isTextStep,
  isButtonStep,
  getTextStepPrompt,
  getTextStepError,
  parseTextStep,
  completionMessage,
  GOAL_OTHER_PENDING,
  isAwaitingGoalDetail,
  goalDetailPrompt,
  isProfileComplete,
  describeProfile,
  describeFieldValue,
  PROFILE_FIELD_LABELS,
} from './onboarding.js';
import { getCoachReply, getCheckinTrigger, getDayCloseTrigger, getCoachPhotoReply, BOT_TIMEZONE } from './coach.js';
import { buildAuthorizeUrl } from './strava.js';
import { createWebhookServer } from './webhookServer.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Фиксированное время для всех на старте (не поле анкеты — не усложняем
// онбординг). Если понадобится гибче — привязать к checkin_time юзера.
const DAY_CLOSE_TIME = '21:00';

async function sendFormatted(telegram, chatId, text) {
  try {
    await telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (sendErr) {
    console.error('HTML parse failed, resending as plain text:', sendErr);
    await telegram.sendMessage(chatId, text);
  }
}

async function sendCoachReply(telegram, chatId, reply) {
  const [main, upsell] = reply.split('[[SPLIT]]').map((part) => part.trim());
  await sendFormatted(telegram, chatId, main);
  if (upsell) {
    await sendFormatted(telegram, chatId, upsell);
  }
}

function belgradeNowParts() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: BOT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { hhmm: `${parts.hour}:${parts.minute}`, today: `${parts.year}-${parts.month}-${parts.day}` };
}

async function checkinTick() {
  const { hhmm, today } = belgradeNowParts();
  const dueUsers = getUsersDueForCheckin(hhmm, today);
  for (const user of dueUsers) {
    try {
      if (getLastUserMessageDate(user.telegram_id, BOT_TIMEZONE) === today) {
        // пользователь уже писал сегодня сам до времени чек-ина — контакт уже
        // был, стандартное «как спалось» тут неуместно, просто закрываем день
        markCheckinSent(user.telegram_id, today);
        continue;
      }
      const history = getHistory(user.telegram_id);
      const reply = await getCheckinTrigger(user, history);
      addMessage(user.telegram_id, 'assistant', reply);
      markCheckinSent(user.telegram_id, today);
      await sendCoachReply(bot.telegram, user.telegram_id, reply);
    } catch (err) {
      console.error('Checkin trigger failed for', user.telegram_id, err);
    }
  }
}

// Пассивной ловли log_training_day в обычном разговоре недостаточно — если
// юзер за день ни разу не написал, день молча остаётся без записи. Второй,
// активный тик: раз в день в фиксированное время догоняет тех, у кого
// training_log за сегодня ещё пуст (getUsersDueForDayClose это уже фильтрует).
async function dayCloseTick() {
  const { hhmm, today } = belgradeNowParts();
  if (hhmm !== DAY_CLOSE_TIME) return;
  const dueUsers = getUsersDueForDayClose(today);
  for (const user of dueUsers) {
    try {
      const history = getHistory(user.telegram_id);
      const reply = await getDayCloseTrigger(user, history);
      addMessage(user.telegram_id, 'assistant', reply);
      markDayCloseSent(user.telegram_id, today);
      await sendCoachReply(bot.telegram, user.telegram_id, reply);
    } catch (err) {
      console.error('Day-close trigger failed for', user.telegram_id, err);
    }
  }
}

// Постоянная reply-клавиатура (не inline — крепится к сообщению и остаётся
// видна снизу чата для ВСЕХ следующих сообщений, Telegram сам добавляет
// иконку скрыть/показать). Отдельная кнопка на каждое будущее действие —
// сейчас только профиль, остальное (тренер/нутрициолог-тумблеры, дайджесты,
// тихий режим) осознанно не делаем, под них пока нет функциональности.
const PROFILE_BUTTON = '👤 Мой профиль';
const MAIN_KEYBOARD = { keyboard: [[PROFILE_BUTTON]], resize_keyboard: true };

async function askNextStep(ctx, telegramId) {
  const user = getUser(telegramId);
  const step = getNextStep(user);
  if (!step) {
    return ctx.reply(completionMessage(), { reply_markup: MAIN_KEYBOARD });
  }
  if (isTextStep(step)) {
    return ctx.reply(getTextStepPrompt(step));
  }
  const { text, keyboard } = buildQuestion(step);
  return ctx.reply(text, { reply_markup: keyboard });
}

bot.start((ctx) => {
  createUser(ctx.from.id);
  askNextStep(ctx, ctx.from.id);
});

const MEASUREMENT_LABELS = { waist: 'Талия', chest: 'Грудь', hips: 'Бёдра' };

function sendProfile(ctx) {
  const user = getUser(ctx.from.id);
  if (!user || !isProfileComplete(user)) {
    return ctx.reply('Сначала закончи анкету — напиши /start.');
  }

  const extras = ['waist', 'chest', 'hips']
    .filter((f) => user[f])
    .map((f) => `${MEASUREMENT_LABELS[f]}: ${user[f]}`);
  const extrasBlock = extras.length ? `\n\nПоследние замеры:\n${extras.join('\n')}` : '';

  // inline_keyboard тут — Telegram позволяет только один reply_markup на
  // сообщение, постоянная клавиатура (MAIN_KEYBOARD) сюда не крепится,
  // она уже висит снизу чата с момента завершения анкеты.
  const keyboard = {
    inline_keyboard: Object.entries(PROFILE_FIELD_LABELS).map(([field, label]) => [
      { text: `Изменить: ${label}`, callback_data: `profile_edit:${field}` },
    ]),
  };

  return ctx.reply(`${describeProfile(user)}${extrasBlock}`, { reply_markup: keyboard });
}

bot.command('profile', (ctx) => sendProfile(ctx));

bot.command('connect_strava', (ctx) => {
  const user = getUser(ctx.from.id);
  if (!user || getNextStep(user)) return ctx.reply('Сначала закончи анкету — напиши /start.');
  return ctx.reply(`Подключи Strava: ${buildAuthorizeUrl(ctx.from.id)}`);
});

bot.action(/^(goal|gender|activity|tone):(.+)$/, async (ctx) => {
  const [, field, value] = ctx.match;
  await ctx.answerCbQuery();

  const user = getUser(ctx.from.id);
  const isEdit = isProfileComplete(user); // /profile правит уже полный профиль, а не анкету

  if (field === 'goal' && value === 'другое') {
    updateUser(ctx.from.id, 'goal', GOAL_OTHER_PENDING);
    return ctx.reply(goalDetailPrompt());
  }

  updateUser(ctx.from.id, field, value);
  if (isEdit) {
    return ctx.reply(`Обновил: ${PROFILE_FIELD_LABELS[field]} → ${describeFieldValue(field, value)}`);
  }
  await askNextStep(ctx, ctx.from.id);
});

// /profile жмёт «Изменить: <поле>» → для кнопочных полей просто повторно
// показывает тот же вопрос анкеты (дальше отрабатывает хендлер выше), для
// текстовых — нет готового callback-флоу, запоминаем ожидание в БД.
bot.action(/^profile_edit:(.+)$/, async (ctx) => {
  const field = ctx.match[1];
  await ctx.answerCbQuery();
  if (isButtonStep(field)) {
    const { text, keyboard } = buildQuestion(field);
    return ctx.reply(text, { reply_markup: keyboard });
  }
  setPendingEditField(ctx.from.id, field);
  return ctx.reply(getTextStepPrompt(field));
});

bot.on('text', async (ctx) => {
  const user = getUser(ctx.from.id);
  if (!user) return;

  if (ctx.message.text === PROFILE_BUTTON) {
    return sendProfile(ctx);
  }

  if (user.pending_edit_field) {
    const field = user.pending_edit_field;
    const value = parseTextStep(field, ctx.message.text);
    if (!value) return ctx.reply(getTextStepError(field));
    updateUser(ctx.from.id, field, value);
    clearPendingEditField(ctx.from.id);
    return ctx.reply(`Обновил: ${PROFILE_FIELD_LABELS[field]} → ${value}`);
  }

  if (isAwaitingGoalDetail(user)) {
    const value = ctx.message.text.trim();
    if (!value) return ctx.reply(goalDetailPrompt());
    const isEdit = isProfileComplete(user); // остальные 7 полей уже заполнены — это /profile, не анкета
    updateUser(ctx.from.id, 'goal', value);
    if (isEdit) {
      return ctx.reply(`Обновил: ${PROFILE_FIELD_LABELS.goal} → ${value}`);
    }
    return askNextStep(ctx, ctx.from.id);
  }

  const step = getNextStep(user);
  if (isTextStep(step)) {
    const value = parseTextStep(step, ctx.message.text);
    if (!value) {
      return ctx.reply(getTextStepError(step));
    }
    updateUser(ctx.from.id, step, value);
    return askNextStep(ctx, ctx.from.id);
  }
  if (step) return;

  addMessage(ctx.from.id, 'user', ctx.message.text);
  const history = getHistory(ctx.from.id);
  try {
    const reply = await getCoachReply(user, history);
    addMessage(ctx.from.id, 'assistant', reply);
    await sendCoachReply(ctx.telegram, ctx.chat.id, reply);
  } catch (err) {
    console.error('Coach reply error:', err);
    ctx.reply('Не получилось ответить — сбой на моей стороне. Попробуй ещё раз чуть позже.');
  }
});

// Telegram присылает альбом (несколько фото одним действием пользователя)
// как отдельные апдейты с общим media_group_id, без гарантии, что они придут
// одним батчем. Копим их здесь и обрабатываем разом одним вызовом коуча —
// иначе на 3 фото прилетает 3 несогласованных ответа (и 3x стоимость истории
// в каждом вызове, т.к. история не кэшируется — кэш только на системный
// промпт). Буферизация (push + сброс таймера) синхронна — Node однопоточный,
// гонки между апдейтами одной группы исключены, пока тут нет await.
const ALBUM_DEBOUNCE_MS = 1200; // Telegram обычно доставляет альбом за < 1с, запас на сеть
const pendingPhotoGroups = new Map(); // `${telegramId}:${mediaGroupId}` -> { photos, ctx, timer }

// Какой размер брать из массива sizes Telegram. По ширине, не по индексу —
// у скриншотов (в отличие от обычных фото) размерных тиров часто меньше
// (например 3 вместо привычных 4), и вычитание фиксированного числа тиров
// «назад» может провалиться сразу в миниатюру. Так и вышло 17.09.2026:
// правка от прошлого бага (альбом из 6 фото пришёл к модели пустым) на
// альбоме из 5 скриншотов тренировки срезала разрешение до ~15 КБ на
// фото — модель физически не смогла прочитать цифры и написала "Записал"
// без данных. Берём по ширине: 1600px для 1-2 фото, 1024px для альбома
// 3+ — этого достаточно, чтобы прочитать текст на скриншоте, и суммарный
// объём для больших альбомов остаётся разумным.
function pickPhotoSize(sizes, groupCount) {
  if (sizes.length === 1) return sizes[0];
  const maxWidth = groupCount >= 3 ? 1024 : 1600;
  const fitting = sizes.filter((s) => s.width <= maxWidth);
  return fitting.length > 0 ? fitting[fitting.length - 1] : sizes[0];
}

async function flushPhotoGroup(ctx, telegramId, photos) {
  const user = getUser(telegramId);
  if (!user || getNextStep(user)) return; // анкета не завершена — фото пока не обрабатываем

  const caption = photos.find((p) => p.caption)?.caption || '';
  const countSuffix = photos.length > 1 ? ` x${photos.length}` : '';
  addMessage(telegramId, 'user', caption ? `[Фото${countSuffix}] ${caption}` : `[Фото${countSuffix}]`);
  const history = getHistory(telegramId);

  try {
    const images = [];
    for (const p of photos) {
      const chosen = pickPhotoSize(p.sizes, photos.length);
      const fileUrl = await ctx.telegram.getFileLink(chosen.file_id);
      const res = await fetch(fileUrl.href);
      const buf = Buffer.from(await res.arrayBuffer());
      // Диагностика бага 17.09.2026 (альбом фото модель иногда "не видит"):
      // magic — первые байты файла, у настоящего JPEG должно быть ffd8ff...
      // Если тут когда-нибудь окажется НЕ ffd8ff или status не 200 — фото
      // портится уже на этапе скачки из Telegram, а не в запросе к модели.
      console.log(
        `[photo] fetch ${chosen.width}x${chosen.height} status=${res.status} bytes=${buf.length} magic=${buf.subarray(0, 4).toString('hex')}`,
      );
      if (!res.ok) {
        throw new Error(`Скачка фото из Telegram вернула HTTP ${res.status}`);
      }
      images.push({ data: buf.toString('base64'), mediaType: 'image/jpeg' });
    }
    const totalKb = Math.round(images.reduce((sum, img) => sum + img.data.length, 0) / 1024);
    console.log(`[photo] батч из ${photos.length}, суммарно base64 ~${totalKb} KB`);
    const reply = await getCoachPhotoReply(user, history, images, caption);
    addMessage(telegramId, 'assistant', reply);
    await sendCoachReply(ctx.telegram, ctx.chat.id, reply);
  } catch (err) {
    console.error('Photo coach reply error:', err);
    ctx.reply('Не получилось разобрать фото — сбой на моей стороне. Попробуй ещё раз чуть позже.');
  }
}

// Только сжатые фото (ctx.message.photo) — не document-файлы. Сам размер
// выбирается позже в flushPhotoGroup (pickPhotoSize), когда известен
// финальный размер альбома — тут сохраняем весь массив sizes как есть.
bot.on('photo', (ctx) => {
  const user = getUser(ctx.from.id);
  if (!user || getNextStep(user)) return;

  const sizes = ctx.message.photo;
  if (!sizes?.length) return;
  const photoItem = { sizes, caption: ctx.message.caption || '', messageId: ctx.message.message_id };

  const groupId = ctx.message.media_group_id;
  if (!groupId) {
    flushPhotoGroup(ctx, ctx.from.id, [photoItem]);
    return;
  }

  const key = `${ctx.from.id}:${groupId}`;
  let entry = pendingPhotoGroups.get(key);
  if (!entry) {
    entry = { photos: [] };
    pendingPhotoGroups.set(key, entry);
  }
  entry.photos.push(photoItem);
  entry.ctx = ctx; // держим последний ctx — telegram/chat одинаковы для всех апдейтов группы
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pendingPhotoGroups.delete(key);
    entry.photos.sort((a, b) => a.messageId - b.messageId);
    flushPhotoGroup(entry.ctx, ctx.from.id, entry.photos);
  }, ALBUM_DEBOUNCE_MS);
});

bot.launch();
console.log('Run Eat Fit bot started');

const webhookServer = createWebhookServer(bot);
webhookServer.listen(process.env.WEBHOOK_PORT || 3000, () => {
  console.log(`Strava webhook server on port ${process.env.WEBHOOK_PORT || 3000}`);
});

setInterval(checkinTick, 60 * 1000);
setInterval(dayCloseTick, 60 * 1000);

function shutdown(signal) {
  bot.stop(signal);
  // setInterval планировщика держит event loop живым — без явного exit
  // процесс не завершается сам по себе даже после graceful stop.
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
