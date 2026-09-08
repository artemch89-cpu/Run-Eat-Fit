import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createUser, getUser, updateUser, addMessage, getHistory } from './db.js';
import { getNextStep, buildQuestion, parseCheckinTime, completionMessage } from './onboarding.js';
import { getCoachReply } from './coach.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

async function askNextStep(ctx, telegramId) {
  const user = getUser(telegramId);
  const step = getNextStep(user);
  if (!step) {
    return ctx.reply(completionMessage());
  }
  if (step === 'checkin_time') {
    return ctx.reply('В какое время тебе удобно, чтобы я писал первым? Формат ЧЧ:ММ, например 08:00');
  }
  const { text, keyboard } = buildQuestion(step);
  return ctx.reply(text, { reply_markup: keyboard });
}

bot.start((ctx) => {
  createUser(ctx.from.id);
  askNextStep(ctx, ctx.from.id);
});

bot.action(/^(goal|activity|tone):(.+)$/, async (ctx) => {
  const [, field, value] = ctx.match;
  updateUser(ctx.from.id, field, value);
  await ctx.answerCbQuery();
  await askNextStep(ctx, ctx.from.id);
});

bot.on('text', async (ctx) => {
  const user = getUser(ctx.from.id);
  if (!user) return;
  const step = getNextStep(user);
  if (step === 'checkin_time') {
    const time = parseCheckinTime(ctx.message.text);
    if (!time) {
      return ctx.reply('Не понял формат. Напиши время как ЧЧ:ММ, например 08:00');
    }
    updateUser(ctx.from.id, 'checkin_time', time);
    return askNextStep(ctx, ctx.from.id);
  }
  if (step) return;

  addMessage(ctx.from.id, 'user', ctx.message.text);
  const history = getHistory(ctx.from.id);
  try {
    const reply = await getCoachReply(user, history);
    addMessage(ctx.from.id, 'assistant', reply);
    ctx.reply(reply);
  } catch (err) {
    console.error('Coach reply error:', err);
    ctx.reply('Не получилось ответить — сбой на моей стороне. Попробуй ещё раз чуть позже.');
  }
});

bot.launch();
console.log('Run Eat Fit bot started');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
