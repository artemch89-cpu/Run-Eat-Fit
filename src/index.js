import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { createUser } from './db.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.start((ctx) => {
  createUser(ctx.from.id);
  ctx.reply('Привет! Я твой персональный тренер. Онбординг скоро появится здесь.');
});

bot.launch();
console.log('Run Eat Fit bot started');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
