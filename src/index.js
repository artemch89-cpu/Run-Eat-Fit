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

async function askNextStep(ctx, telegramId) {
  const user = getUser(telegramId);
  const step = getNextStep(user);
  if (!step) {
    return ctx.reply(completionMessage());
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

bot.command('profile', (ctx) => {
  const user = getUser(ctx.from.id);
  if (!user || !isProfileComplete(user)) {
    return ctx.reply('Сначала закончи анкету — напиши /start.');
  }

  const extras = ['waist', 'chest', 'hips']
    .filter((f) => user[f])
    .map((f) => `${MEASUREMENT_LABELS[f]}: ${user[f]}`);
  const extrasBlock = extras.length ? `\n\nПоследние замеры:\n${extras.join('\n')}` : '';

  const keyboard = {
    inline_keyboard: Object.entries(PROFILE_FIELD_LABELS).map(([field, label]) => [
      { text: `Изменить: ${label}`, callback_data: `profile_edit:${field}` },
    ]),
  };

  ctx.reply(`${describeProfile(user)}${extrasBlock}`, { reply_markup: keyboard });
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

// Только сжатые фото (ctx.message.photo) — не document-файлы. Берём
// предпоследний размер массива (Telegram отдаёт от меньшего к большему) —
// «стандартное» разрешение, не миниатюра и не полноразмерный оригинал.
bot.on('photo', async (ctx) => {
  const user = getUser(ctx.from.id);
  if (!user || getNextStep(user)) return; // анкета не завершена — фото пока не обрабатываем

  const sizes = ctx.message.photo;
  if (!sizes?.length) return;
  const chosen = sizes.length >= 2 ? sizes[sizes.length - 2] : sizes[0];
  const caption = ctx.message.caption || '';

  addMessage(ctx.from.id, 'user', caption ? `[Фото еды] ${caption}` : '[Фото еды]');
  const history = getHistory(ctx.from.id);

  try {
    const fileUrl = await ctx.telegram.getFileLink(chosen.file_id);
    const res = await fetch(fileUrl.href);
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    const reply = await getCoachPhotoReply(user, history, { data, mediaType: 'image/jpeg' }, caption);
    addMessage(ctx.from.id, 'assistant', reply);
    await sendCoachReply(ctx.telegram, ctx.chat.id, reply);
  } catch (err) {
    console.error('Photo coach reply error:', err);
    ctx.reply('Не получилось разобрать фото — сбой на моей стороне. Попробуй ещё раз чуть позже.');
  }
});

bot.launch();
console.log('Run Eat Fit bot started');

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
