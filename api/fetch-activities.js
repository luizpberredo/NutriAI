import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const USER_ID = 'user_001';

async function refreshStravaToken(tokens) {
  if (tokens.expires_at > Math.floor(Date.now() / 1000) + 60) return tokens;
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error('Strava token refresh failed');
  const fresh = await r.json();
  const updated = { ...tokens, access_token: fresh.access_token, refresh_token: fresh.refresh_token, expires_at: fresh.expires_at };
  await kv.set(`strava_tokens:${USER_ID}`, updated);
  return updated;
}

async function refreshGoogleToken(tokens) {
  const age = Math.floor(Date.now() / 1000) - tokens.issued_at;
  if (age < tokens.expires_in - 60) return tokens;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error('Google token refresh failed');
  const fresh = await r.json();
  const updated = { ...tokens, access_token: fresh.access_token, issued_at: Math.floor(Date.now() / 1000), expires_in: fresh.expires_in };
  await kv.set(`google_tokens:${USER_ID}`, updated);
  return updated;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const result = { strava: null, google: null, errors: {} };

  // ── Strava: last 7 days ──────────────────────────────────────────────────
  try {
    let tokens = await kv.get(`strava_tokens:${USER_ID}`);
    if (!tokens) throw new Error('not_connected');
    tokens = await refreshStravaToken(tokens);

    const after = Math.floor((Date.now() - 7 * 86400 * 1000) / 1000);
    const r = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=30`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!r.ok) throw new Error(`Strava API error: ${r.status}`);
    const activities = await r.json();

    result.strava = activities.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      date: a.start_date_local?.slice(0, 10),
      duration_min: Math.round(a.moving_time / 60),
      distance_km: a.distance ? +(a.distance / 1000).toFixed(2) : null,
      calories: a.calories || null,
      elevation_m: a.total_elevation_gain || null,
    }));
  } catch (e) {
    result.errors.strava = e.message;
  }

  // ── Google Fit: steps + calories burned today ────────────────────────────
  try {
    let tokens = await kv.get(`google_tokens:${USER_ID}`);
    if (!tokens) throw new Error('not_connected');
    tokens = await refreshGoogleToken(tokens);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    const endMs = Date.now();

    const r = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aggregateBy: [
          { dataTypeName: 'com.google.step_count.delta' },
          { dataTypeName: 'com.google.calories.expended' },
        ],
        bucketByTime: { durationMillis: 86400000 },
        startTimeMillis: startMs,
        endTimeMillis: endMs,
      }),
    });
    if (!r.ok) throw new Error(`Google Fit API error: ${r.status}`);
    const data = await r.json();

    let steps = 0, caloriesBurned = 0;
    for (const bucket of data.bucket || []) {
      for (const dataset of bucket.dataset || []) {
        for (const point of dataset.point || []) {
          for (const val of point.value || []) {
            if (dataset.dataSourceId?.includes('step_count')) steps += val.intVal || 0;
            if (dataset.dataSourceId?.includes('calories')) caloriesBurned += val.fpVal || 0;
          }
        }
      }
    }
    result.google = { steps, calories_burned: Math.round(caloriesBurned) };
  } catch (e) {
    result.errors.google = e.message;
  }

  return res.status(200).json(result);
}
