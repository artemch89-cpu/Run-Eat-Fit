// Отдельный HTTP-сервер только для Strava (OAuth-редирект + webhook).
// node:http, не Express — два маршрута не оправдывают новую зависимость.
import http from 'node:http';
import { exchangeCodeForTokens, getValidAccessToken, fetchActivity, mapRunToTrainingLogFields } from './strava.js';
import { getStravaTokensByAthleteId, upsertTrainingLog } from './db.js';

const WEBHOOK_VERIFY_TOKEN = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Асинхронная обработка после мгновенного 200 (Strava требует быстрый ack,
// иначе повторяет доставку). Только новые пробежки — другие виды спорта и
// update/delete осознанно не в этом заходе.
async function handleActivityEvent(bot, event) {
  if (event.aspect_type !== 'create' || event.object_type !== 'activity') return;

  const tokens = getStravaTokensByAthleteId(event.owner_id);
  if (!tokens) return; // вебхук на юзера, у которого нет активного подключения

  try {
    const accessToken = await getValidAccessToken(tokens.telegram_id);
    const activity = await fetchActivity(accessToken, event.object_id);
    if (activity.sport_type !== 'Run') return;

    const fields = mapRunToTrainingLogFields(activity);
    const date = activity.start_date_local.slice(0, 10);
    upsertTrainingLog(tokens.telegram_id, date, { ...fields, status: 'done' });

    await bot.telegram.sendMessage(
      tokens.telegram_id,
      `Забрал пробежку из Strava: ${fields.distance_km} км, ${fields.avg_pace_min_km}/км${fields.avg_hr ? `, пульс ${fields.avg_hr}` : ''}.`,
    );
  } catch (err) {
    console.error('Strava activity event failed:', err);
  }
}

export function createWebhookServer(bot) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/strava/callback') {
      const code = url.searchParams.get('code');
      const telegramId = url.searchParams.get('state');
      if (!code || !telegramId) return sendHtml(res, 400, 'Missing code/state');

      try {
        await exchangeCodeForTokens(telegramId, code);
        await bot.telegram.sendMessage(telegramId, 'Strava подключена. Пробежки будут появляться в дневнике автоматически.');
        return sendHtml(res, 200, '<h1>Готово</h1><p>Можешь вернуться в Telegram.</p>');
      } catch (err) {
        console.error('Strava OAuth callback failed:', err);
        return sendHtml(res, 500, '<h1>Ошибка</h1><p>Не получилось подключить Strava — попробуй ещё раз.</p>');
      }
    }

    if (req.method === 'GET' && url.pathname === '/strava/webhook') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
        return sendJson(res, 200, { 'hub.challenge': challenge });
      }
      return sendJson(res, 403, { error: 'invalid verify_token' });
    }

    if (req.method === 'POST' && url.pathname === '/strava/webhook') {
      let event;
      try {
        event = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      sendJson(res, 200, {}); // ack сразу, обрабатываем после ответа
      handleActivityEvent(bot, event);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });
}
