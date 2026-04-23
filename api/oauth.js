// api/oauth.js — consolida todos os fluxos OAuth (Strava, Google, Withings)
// GET /api/oauth?provider=strava&action=start&token=...
// GET /api/oauth?provider=strava&action=callback&code=...&state=...
// (idem para google e withings)
//
// IMPORTANTE: nas configurações de cada app OAuth, registre o redirect URI como:
//   https://<seu-dominio>/api/oauth?provider=strava&action=callback
//   https://<seu-dominio>/api/oauth?provider=google&action=callback
//   https://<seu-dominio>/api/oauth?provider=withings&action=callback

import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';

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

function baseUrl(req) {
  const host = req.headers.host;
  const protocol = host.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${host}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { provider, action, code, state, error } = req.query;

  // ── START flows (redirect to provider) ───────────────────────────────────
  if (action === 'start') {
    const sessionToken = req.query.token || '';
    const callbackUrl = `${baseUrl(req)}/api/oauth?provider=${provider}&action=callback`;
    const oauthState = `nutriai|${sessionToken}`;

    if (provider === 'strava') {
      const url = new URL('https://www.strava.com/oauth/authorize');
      url.searchParams.set('client_id', process.env.STRAVA_CLIENT_ID);
      url.searchParams.set('redirect_uri', callbackUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('approval_prompt', 'auto');
      url.searchParams.set('scope', 'activity:read_all');
      url.searchParams.set('state', oauthState);
      return res.redirect(302, url.toString());
    }

    if (provider === 'google') {
      const url = new URL('https://accounts.google.com/o/oauth2/auth');
      url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
      url.searchParams.set('redirect_uri', callbackUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
      url.searchParams.set('scope', [
        'https://www.googleapis.com/auth/fitness.activity.read',
        'https://www.googleapis.com/auth/fitness.body.read',
      ].join(' '));
      url.searchParams.set('state', oauthState);
      return res.redirect(302, url.toString());
    }

    if (provider === 'withings') {
      const url = new URL('https://account.withings.com/oauth2_user/authorize2');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', process.env.WITHINGS_CLIENT_ID);
      url.searchParams.set('redirect_uri', callbackUrl);
      url.searchParams.set('scope', 'user.metrics');
      url.searchParams.set('state', oauthState);
      return res.redirect(302, url.toString());
    }

    return res.status(400).json({ error: 'Unknown provider' });
  }

  // ── CALLBACK flows (exchange code for tokens) ─────────────────────────────
  if (action === 'callback') {
    const [, sessionToken] = (state || '').split('|');
    const callbackUrl = `${baseUrl(req)}/api/oauth?provider=${provider}&action=callback`;

    if (error || !code) return res.redirect(302, `/?error=${provider}_denied`);

    const userId = await resolveUserId(sessionToken);
    if (!userId) return res.redirect(302, `/?error=${provider}_auth&msg=invalid_session`);

    try {
      if (provider === 'strava') {
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
        return res.redirect(302, '/?connected=strava');
      }

      if (provider === 'google') {
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            code,
            redirect_uri: callbackUrl,
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
        return res.redirect(302, '/?connected=google');
      }

      if (provider === 'withings') {
        const body = new URLSearchParams({
          action: 'requesttoken',
          grant_type: 'authorization_code',
          client_id: process.env.WITHINGS_CLIENT_ID,
          client_secret: process.env.WITHINGS_CLIENT_SECRET,
          code,
          redirect_uri: callbackUrl,
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
        await kv.set(`withings_tokens:${userId}`, {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
          issued_at: Math.floor(Date.now() / 1000),
          userid: tokens.userid,
        });
        return res.redirect(302, '/?connected=withings');
      }

      return res.redirect(302, '/?error=unknown_provider');
    } catch (e) {
      console.error(`${provider} callback error:`, e);
      return res.redirect(302, `/?error=${provider}_callback&msg=${encodeURIComponent(e.message)}`);
    }
  }

  return res.status(400).json({ error: 'Missing action param (start or callback)' });
}
