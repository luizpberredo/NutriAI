import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const USER_ID = 'user_001';

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(302, '/?error=withings_denied');
  }

  const host = req.headers.host;
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth-withings-callback`;

  try {
    const body = new URLSearchParams({
      action: 'requesttoken',
      grant_type: 'authorization_code',
      client_id: process.env.WITHINGS_CLIENT_ID,
      client_secret: process.env.WITHINGS_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    });

    const r = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!r.ok) throw new Error(`Withings token exchange failed: ${r.status}`);
    const json = await r.json();
    if (json.status !== 0) throw new Error(`Withings error: ${json.error}`);

    const tokens = json.body;
    await kv.set(`withings_tokens:${USER_ID}`, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      issued_at: Math.floor(Date.now() / 1000),
      userid: tokens.userid,
    });

    res.redirect(302, '/?connected=withings');
  } catch (e) {
    console.error('Withings callback error:', e);
    res.redirect(302, `/?error=withings_callback&msg=${encodeURIComponent(e.message)}`);
  }
}
