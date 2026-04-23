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

export default async function handler(req, res) {
  const { code, error, state } = req.query;
  const [, sessionToken] = (state || '').split('|');

  if (error || !code) return res.redirect(302, '/?error=strava_denied');

  const userId = await resolveUserId(sessionToken);
  if (!userId) return res.redirect(302, '/?error=strava_auth&msg=invalid_session');

  try {
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });
    if (!r.ok) throw new Error(`Strava token exchange failed: ${r.status}`);
    const tokens = await r.json();

    await kv.set(`strava_tokens:${userId}`, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      athlete_id: tokens.athlete?.id,
    });

    res.redirect(302, '/?connected=strava');
  } catch (e) {
    console.error('Strava callback error:', e);
    res.redirect(302, `/?error=strava_callback&msg=${encodeURIComponent(e.message)}`);
  }
}
