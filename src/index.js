import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createUser, getUser, updateUser, addMessage, getHistory, getUsersDueForCheckin, markCheckinSent } from './db.js';
import { getNextStep, buildQuestion, isTextStep, getTextStepPrompt, getTextStepError, parseTextStep, completionMessage } from './onboarding.js';
import { getCoachReply, getCheckinTrigger, BOT_TIMEZONE } from './coach.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

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

bot.action(/^(goal|gender|activity|tone):(.+)$/, async (ctx) => {
  const [, field, value] = ctx.match;
  updateUser(ctx.from.id, field, value);
  await ctx.answerCbQuery();
  await askNextStep(ctx, ctx.from.id);
});

bot.on('text', async (ctx) => {
  const user = getUser(ctx.from.id);
  if (!user) return;
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

bot.launch();
console.log('Run Eat Fit bot started');

setInterval(checkinTick, 60 * 1000);

function shutdown(signal) {
  bot.stop(signal);
  // setInterval планировщика держит event loop живым — без явного exit
  // процесс не завершается сам по себе даже после graceful stop.
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
