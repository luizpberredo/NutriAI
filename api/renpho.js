// api/renpho.js
// POST /api/renpho   body: { token, action: 'connect'|'sync'|'get'|'disconnect', email?, password? }
//
// Requer variável de ambiente RENPHO_ENCRYPTION_KEY = 64 chars hex (32 bytes aleatórios)
// Gere com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

import { Redis } from '@upstash/redis';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function getEncKey() {
  const hex = process.env.RENPHO_ENCRYPTION_KEY || '';
  if (hex.length !== 64) throw new Error('RENPHO_ENCRYPTION_KEY must be 64 hex chars — run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  return Buffer.from(hex, 'hex');
}

function encrypt(text) {
  const key = getEncKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(stored) {
  const key = getEncKey();
  const [ivHex, tagHex, encHex] = stored.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

async function resolveUserId(token) {
  if (!token) return null;
  const session = await kv.get(`session:${token}`);
  if (!session || new Date(session.expiresAt) < new Date()) return null;
  return session.userId;
}

async function renphoLogin(email, password) {
  const r = await fetch('https://renpho.qnclouds.com/api/v3/users/sign_in.json?app_id=Renpho', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Renpho/3.0' },
    body: JSON.stringify({ email, password, secure_flag: '1' }),
  });
  if (!r.ok) throw new Error(`Renpho login HTTP ${r.status}`);
  const json = await r.json();
  if (json.status_code !== '20000') throw new Error(json.status_message || 'Login falhou — verifique e-mail e senha');
  return json.terminal_user_session_key;
}

async function renphoGetUserId(sessionKey) {
  const r = await fetch(
    `https://renpho.qnclouds.com/api/v3/scale_users/list_scale_user?locale=en&terminal_user_session_key=${encodeURIComponent(sessionKey)}`,
    { headers: { 'User-Agent': 'Renpho/3.0' } }
  );
  if (!r.ok) throw new Error(`Renpho scale_users HTTP ${r.status}`);
  const json = await r.json();
  const users = json.scale_users || [];
  if (!users.length) throw new Error('Nenhum usuário de balança encontrado nesta conta');
  return users[0].user_id;
}

function parseMeasurements(raw, limit = 20) {
  return (raw || []).slice(0, limit).map(m => ({
    time: m.time_stamp || m.time,
    date: m.time_stamp
      ? new Date(m.time_stamp * 1000).toISOString().slice(0, 10)
      : new Date(m.time * 1000).toISOString().slice(0, 10),
    weight: m.weight != null ? +parseFloat(m.weight).toFixed(2) : null,
    bmi: m.bmi != null ? +parseFloat(m.bmi).toFixed(1) : null,
    bodyfat: m.bodyfat != null ? +parseFloat(m.bodyfat).toFixed(1) : null,
    muscle_mass: m.muscle_mass != null ? +parseFloat(m.muscle_mass).toFixed(1) : null,
    water_percent: m.water_percent != null ? +parseFloat(m.water_percent).toFixed(1) : null,
    bone_mass: m.bone_mass != null ? +parseFloat(m.bone_mass).toFixed(2) : null,
    visceral_fat: m.visceral_fat != null ? +parseFloat(m.visceral_fat).toFixed(0) : null,
    protein: m.protein != null ? +parseFloat(m.protein).toFixed(1) : null,
    metabolic_age: m.metabolic_age != null ? parseInt(m.metabolic_age) : null,
  }));
}

async function fetchMeasurements(renphoUserId, sessionKey, daysBack = 14) {
  const lastAt = Math.floor((Date.now() - daysBack * 86400 * 1000) / 1000);
  const url = `https://renpho.qnclouds.com/api/v2/measurements/list.json` +
    `?user_id=${renphoUserId}&last_at=${lastAt}&locale=en&app_id=Renpho` +
    `&terminal_user_session_key=${encodeURIComponent(sessionKey)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Renpho/3.0' } });
  if (!r.ok) throw new Error(`Renpho measurements HTTP ${r.status}`);
  const json = await r.json();
  return parseMeasurements(json.last_ary, 20);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, token, email, password } = req.body || {};

  let userId;
  try {
    userId = await resolveUserId(token);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  // ── GET: retorna estado atual (conectado ou não) ──────────────────────────
  if (action === 'get') {
    try {
      const creds = await kv.get(`renpho:${userId}`);
      if (!creds) return res.status(200).json({ connected: false });
      const cached = await kv.get(`renpho_sync:${userId}`);
      return res.status(200).json({
        connected: true,
        connectedAt: creds.connectedAt,
        measurements: cached?.measurements || [],
        syncedAt: cached?.syncedAt || null,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── CONNECT: login + salva credenciais criptografadas + busca medições ────
  if (action === 'connect') {
    if (!email || !password) return res.status(400).json({ error: 'email e password são obrigatórios' });
    try {
      const sessionKey = await renphoLogin(email, password);
      const renphoUserId = await renphoGetUserId(sessionKey);
      const measurements = await fetchMeasurements(renphoUserId, sessionKey, 14);
      const stored = {
        encEmail: encrypt(email),
        encPassword: encrypt(password),
        renphoUserId,
        connectedAt: new Date().toISOString(),
      };
      await kv.set(`renpho:${userId}`, stored);
      await kv.set(`renpho_sync:${userId}`, { measurements, syncedAt: Date.now() });
      return res.status(200).json({ ok: true, measurements, syncedAt: Date.now() });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // ── SYNC: re-login e atualiza medições ────────────────────────────────────
  if (action === 'sync') {
    try {
      const creds = await kv.get(`renpho:${userId}`);
      if (!creds) return res.status(200).json({ error: 'not_connected' });
      const dec_email = decrypt(creds.encEmail);
      const dec_pass = decrypt(creds.encPassword);
      const sessionKey = await renphoLogin(dec_email, dec_pass);
      const measurements = await fetchMeasurements(creds.renphoUserId, sessionKey, 14);
      await kv.set(`renpho_sync:${userId}`, { measurements, syncedAt: Date.now() });
      return res.status(200).json({ ok: true, measurements, syncedAt: Date.now() });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DISCONNECT: apaga credenciais e cache ─────────────────────────────────
  if (action === 'disconnect') {
    try {
      await kv.del(`renpho:${userId}`);
      await kv.del(`renpho_sync:${userId}`);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
