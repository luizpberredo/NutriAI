// api/health-data.js — consolida fetch-activities e fetch-weight
// GET /api/health-data?type=activities&token=...
// GET /api/health-data?type=weight&token=...

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function resolveUserId(token) {
  if (!token) return null;
  const session = await kv.get(`session:${token}`);
  if (!session || new Date(session.expiresAt) < new Date()) return null;
  return session.userId;
}

async function refreshStravaToken(tokens, userId) {
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
  await kv.set(`strava_tokens:${userId}`, updated);
  return updated;
}

async function refreshGoogleToken(tokens, userId) {
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
  await kv.set(`google_tokens:${userId}`, updated);
  return updated;
}

async function refreshWithingsToken(tokens, userId) {
  const age = Math.floor(Date.now() / 1000) - tokens.issued_at;
  if (age < tokens.expires_in - 60) return tokens;
  const body = new URLSearchParams({
    action: 'requesttoken',
    grant_type: 'refresh_token',
    client_id: process.env.WITHINGS_CLIENT_ID,
    client_secret: process.env.WITHINGS_CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
  });
  const r = await fetch('https://wbsapi.withings.net/v2/oauth2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) throw new Error('Withings token refresh failed');
  const json = await r.json();
  if (json.status !== 0) throw new Error(`Withings refresh error: ${json.error}`);
  const fresh = json.body;
  const updated = { ...tokens, access_token: fresh.access_token, refresh_token: fresh.refresh_token, issued_at: Math.floor(Date.now() / 1000), expires_in: fresh.expires_in };
  await kv.set(`withings_tokens:${userId}`, updated);
  return updated;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = await resolveUserId(req.query.token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const type = req.query.type;

  // ── type=activities: Strava (últimos 7 dias) + Google Fit (hoje) ──────────
  if (type === 'activities') {
    const result = { strava: null, google: null, errors: {} };

    try {
      let tokens = await kv.get(`strava_tokens:${userId}`);
      console.log('[health-data] userId:', userId, '| strava tokens found:', !!tokens, tokens ? `expires_at:${tokens.expires_at} scope:${tokens.scope}` : '');
      if (!tokens) throw new Error('not_connected');
      tokens = await refreshStravaToken(tokens, userId);
      const after = Math.floor((Date.now() - 7 * 86400 * 1000) / 1000);
      const stravaUrl = `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=30`;
      console.log('[health-data] calling Strava:', stravaUrl);
      const r = await fetch(stravaUrl, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      console.log('[health-data] Strava response status:', r.status);
      if (!r.ok) {
        const body = await r.text();
        console.error('[health-data] Strava error body:', body);
        throw new Error(`Strava API error: ${r.status}`);
      }
      const activities = await r.json();
      console.log('[health-data] Strava activities count:', activities.length);

      // Busca detalhes individuais para garantir campo calories completo
      const detailed = await Promise.all(activities.map(async a => {
        // Se a lista já trouxe calorias ou kilojoules, usa direto (evita chamada extra)
        if ((a.calories && a.calories > 0) || (a.kilojoules && a.kilojoules > 0)) {
          console.log('[health-data] list OK:', a.name, 'cal:', a.calories, 'kj:', a.kilojoules);
          return a;
        }
        try {
          const dr = await fetch(`https://www.strava.com/api/v3/activities/${a.id}`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          if (!dr.ok) { console.warn('[health-data] detail fetch failed', a.id, dr.status); return a; }
          const det = await dr.json();
          console.log('[health-data] detail', det.name, JSON.stringify({
            calories: det.calories, kilojoules: det.kilojoules,
            has_heartrate: det.has_heartrate, average_heartrate: det.average_heartrate,
            visibility: det.visibility,
          }));
          return { ...a, calories: det.calories, kilojoules: det.kilojoules };
        } catch (e) {
          console.warn('[health-data] detail error', a.id, e.message);
          return a;
        }
      }));

      const todaySP = new Date().toLocaleDateString('en-CA', {timeZone:'America/Sao_Paulo'});
      console.log('[health-data] server TODAY (SP):', todaySP);

      result.strava = detailed.map(a => {
        let calories = null;
        if (a.calories && a.calories > 0) {
          calories = Math.round(a.calories);
        } else if (a.kilojoules && a.kilojoules > 0) {
          calories = Math.round(a.kilojoules / 4.184);
        }
        const dateSP = a.start_date ? new Date(a.start_date).toLocaleDateString('en-CA', {timeZone:'America/Sao_Paulo'}) : null;
        console.log('[health-data] activity:', a.name,
          '| start_date (UTC):', a.start_date,
          '| start_date_local (athlete tz):', a.start_date_local,
          '| date→SP:', dateSP,
          '| isToday:', dateSP === todaySP);
        return {
          id: a.id,
          name: a.name,
          type: a.sport_type || a.type,
          date: dateSP,
          duration_min: Math.round(a.moving_time / 60),
          distance_km: a.distance ? +(a.distance / 1000).toFixed(2) : null,
          calories,
          elevation_m: a.total_elevation_gain || null,
        };
      });
    } catch (e) {
      result.errors.strava = e.message;
    }

    try {
      let tokens = await kv.get(`google_tokens:${userId}`);
      if (!tokens) throw new Error('not_connected');
      tokens = await refreshGoogleToken(tokens, userId);
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const r = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aggregateBy: [
            { dataTypeName: 'com.google.step_count.delta' },
            { dataTypeName: 'com.google.calories.expended' },
          ],
          bucketByTime: { durationMillis: 86400000 },
          startTimeMillis: startOfDay.getTime(),
          endTimeMillis: Date.now(),
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

  // ── type=weight: Withings (últimos 30 dias) ───────────────────────────────
  if (type === 'weight') {
    try {
      let tokens = await kv.get(`withings_tokens:${userId}`);
      if (!tokens) return res.status(200).json({ error: 'not_connected', measurements: [] });
      tokens = await refreshWithingsToken(tokens, userId);

      const startdate = Math.floor((Date.now() - 30 * 86400 * 1000) / 1000);
      const enddate = Math.floor(Date.now() / 1000);
      const body = new URLSearchParams({ action: 'getmeas', meastype: '1,6,8', category: '1', startdate, enddate });
      const r = await fetch('https://wbsapi.withings.net/measure', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!r.ok) throw new Error(`Withings API error: ${r.status}`);
      const json = await r.json();
      if (json.status !== 0) throw new Error(`Withings error: ${json.error}`);

      const measurements = (json.body?.measuregrps || []).map(grp => {
        const entry = { date: new Date(grp.date * 1000).toISOString().slice(0, 10) };
        for (const m of grp.measures) {
          const val = m.value * Math.pow(10, m.unit);
          if (m.type === 1) entry.weight_kg = +val.toFixed(2);
          if (m.type === 6) entry.fat_pct = +val.toFixed(1);
          if (m.type === 8) entry.fat_free_mass_kg = +val.toFixed(2);
        }
        return entry;
      }).filter(e => e.weight_kg);

      return res.status(200).json({ measurements });
    } catch (e) {
      return res.status(500).json({ error: e.message, measurements: [] });
    }
  }

  return res.status(400).json({ error: 'Missing type param (activities or weight)' });
}
