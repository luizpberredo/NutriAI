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

  try {
    let tokens = await kv.get(`withings_tokens:${userId}`);
    if (!tokens) return res.status(200).json({ error: 'not_connected', measurements: [] });
    tokens = await refreshWithingsToken(tokens, userId);

    const startdate = Math.floor((Date.now() - 30 * 86400 * 1000) / 1000);
    const enddate = Math.floor(Date.now() / 1000);

    const body = new URLSearchParams({
      action: 'getmeas',
      meastype: '1,6,8',
      category: '1',
      startdate,
      enddate,
    });

    const r = await fetch('https://wbsapi.withings.net/measure', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
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
