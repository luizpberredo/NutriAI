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

  if (error || !code) return res.redirect(302, '/?error=google_denied');

  const userId = await resolveUserId(sessionToken);
  if (!userId) return res.redirect(302, '/?error=google_auth&msg=invalid_session');

  const host = req.headers.host;
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/auth-google-callback`;

  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!r.ok) throw new Error(`Google token exchange failed: ${r.status}`);
    const tokens = await r.json();

    await kv.set(`google_tokens:${userId}`, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      issued_at: Math.floor(Date.now() / 1000),
    });

    res.redirect(302, '/?connected=google');
  } catch (e) {
    console.error('Google callback error:', e);
    res.redirect(302, `/?error=google_callback&msg=${encodeURIComponent(e.message)}`);
  }
}
