// api/auth.js — consolida register, login, logout, me
// GET  /api/auth?action=me&token=...
// POST /api/auth?action=register   body: {name, email, password}
// POST /api/auth?action=login      body: {email, password}
// POST /api/auth?action=logout     body: {token}

import { Redis } from '@upstash/redis';
import { randomBytes, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const pbkdf2Async = promisify(pbkdf2);

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const buf = await pbkdf2Async(password, salt, 100000, 64, 'sha512');
  return `pbkdf2:${salt}:${buf.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [, salt, hash] = stored.split(':');
  const buf = await pbkdf2Async(password, salt, 100000, 64, 'sha512');
  return buf.toString('hex') === hash;
}

async function createSession(userId, email, name) {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await kv.set(`session:${token}`, { userId, email, name, expiresAt }, { ex: 30 * 24 * 60 * 60 });
  return token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // ── GET /api/auth?action=me&token=... ────────────────────────────────────
  if (action === 'me') {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
      const session = await kv.get(`session:${token}`);
      if (!session) return res.status(401).json({ error: 'Session not found' });
      if (new Date(session.expiresAt) < new Date()) {
        await kv.del(`session:${token}`);
        return res.status(401).json({ error: 'Session expired' });
      }
      return res.status(200).json({ userId: session.userId, email: session.email, name: session.name });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── POST /api/auth?action=register ───────────────────────────────────────
  if (action === 'register') {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password)
      return res.status(400).json({ error: 'name, email e password são obrigatórios' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });

    const emailKey = `user:email:${email.toLowerCase().trim()}`;
    try {
      const existing = await kv.get(emailKey);
      if (existing) return res.status(409).json({ error: 'E-mail já cadastrado' });

      const passwordHash = await hashPassword(password);
      const userId = randomUUID();
      const user = {
        id: userId,
        email: email.toLowerCase().trim(),
        name: name.trim(),
        passwordHash,
        createdAt: new Date().toISOString(),
      };
      await kv.set(emailKey, user);
      const token = await createSession(userId, user.email, user.name);
      return res.status(200).json({ token, userId, name: user.name, email: user.email });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST /api/auth?action=login ──────────────────────────────────────────
  if (action === 'login') {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: 'email e password são obrigatórios' });
    try {
      const user = await kv.get(`user:email:${email.toLowerCase().trim()}`);
      if (!user) return res.status(401).json({ error: 'E-mail ou senha inválidos' });

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'E-mail ou senha inválidos' });

      const token = await createSession(user.id, user.email, user.name);
      return res.status(200).json({ token, userId: user.id, name: user.name, email: user.email });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST /api/auth?action=logout ─────────────────────────────────────────
  if (action === 'logout') {
    const token = req.body?.token || req.query?.token;
    if (token) {
      try { await kv.del(`session:${token}`); } catch (e) {}
    }
    return res.status(200).json({ ok: true });
  }

  // ── POST /api/auth?action=disconnect  body: {token, provider} ────────────
  if (action === 'disconnect') {
    const sessionToken = req.body?.token || req.query?.token;
    const provider = req.body?.provider || req.query?.provider;
    if (!sessionToken || !provider) return res.status(400).json({ error: 'token and provider required' });
    const session = await kv.get(`session:${sessionToken}`);
    if (!session || new Date(session.expiresAt) < new Date()) return res.status(401).json({ error: 'Unauthorized' });
    const keyMap = { strava: 'strava_tokens', google: 'google_tokens', withings: 'withings_tokens' };
    const key = keyMap[provider];
    if (!key) return res.status(400).json({ error: 'Unknown provider' });
    try {
      await kv.del(`${key}:${session.userId}`);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
