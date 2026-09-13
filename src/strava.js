// Вся логика похода в Strava API — OAuth, обновление токенов, чтение
// активности. Никаких обращений к Anthropic здесь нет (в отличие от
// coach.js) — это чистая интеграция с внешним REST API.
import { upsertStravaTokens, getStravaTokensByTelegramId } from './db.js';

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

export function buildAuthorizeUrl(telegramId) {
  const params = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${PUBLIC_BASE_URL}/strava/callback`,
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state: String(telegramId),
  });
  return `https://www.strava.com/oauth/authorize?${params}`;
}

async function requestToken(body) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET, ...body }),
  });
  if (!res.ok) {
    throw new Error(`Strava token request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function exchangeCodeForTokens(telegramId, code) {
  const data = await requestToken({ code, grant_type: 'authorization_code' });
  upsertStravaTokens(telegramId, {
    stravaAthleteId: data.athlete.id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
  });
}

// Strava выдаёt новый refresh_token при каждом рефреше — старый после этого
// недействителен, поэтому обязательно перезаписываем оба токена, не только access.
export async function getValidAccessToken(telegramId) {
  const tokens = getStravaTokensByTelegramId(telegramId);
  if (!tokens) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (tokens.expires_at > nowSeconds + 300) {
    return tokens.access_token;
  }

  const data = await requestToken({ refresh_token: tokens.refresh_token, grant_type: 'refresh_token' });
  upsertStravaTokens(telegramId, {
    stravaAthleteId: tokens.strava_athlete_id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
  });
  return data.access_token;
}

export async function fetchActivity(accessToken, activityId) {
  const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Strava activity fetch failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function formatPace(movingTimeSeconds, distanceMeters) {
  if (!distanceMeters) return null;
  const minPerKm = movingTimeSeconds / 60 / (distanceMeters / 1000);
  const min = Math.floor(minPerKm);
  const sec = Math.round((minPerKm - min) * 60);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

// distance/moving_time — метры/секунды (сырые единицы Strava API).
export function mapRunToTrainingLogFields(activity) {
  return {
    distance_km: (activity.distance / 1000).toFixed(2),
    avg_pace_min_km: formatPace(activity.moving_time, activity.distance),
    avg_hr: activity.average_heartrate ? String(Math.round(activity.average_heartrate)) : null,
  };
}
