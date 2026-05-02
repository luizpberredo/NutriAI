// api/renpho.js
// POST /api/renpho   body: { token, action: 'connect'|'sync'|'get'|'disconnect', email?, password? }
//
// RENPHO_ENCRYPTION_KEY (opcional): 64 hex chars para AES-256-GCM.
// Se não definida, usa base64 (menos seguro mas funcional).

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// ── Criptografia opcional ─────────────────────────────────────────────────
function encrypt(text) {
  const hex = process.env.RENPHO_ENCRYPTION_KEY || '';
  if (hex.length === 64) {
    try {
      const { createCipheriv, randomBytes } = require('crypto');
      const key = Buffer.from(hex, 'hex');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `aes:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    } catch (e) { /* fall through to base64 */ }
  }
  return 'b64:' + Buffer.from(text, 'utf8').toString('base64');
}

function decrypt(stored) {
  if (stored.startsWith('aes:')) {
    const { createDecipheriv } = require('crypto');
    const hex = process.env.RENPHO_ENCRYPTION_KEY || '';
    const key = Buffer.from(hex, 'hex');
    const [, ivHex, tagHex, encHex] = stored.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }
  // b64: prefix (or legacy without prefix)
  const b64 = stored.startsWith('b64:') ? stored.slice(4) : stored;
  return Buffer.from(b64, 'base64').toString('utf8');
}

// ── Auth ──────────────────────────────────────────────────────────────────
async function resolveUserId(token) {
  if (!token) return null;
  const session = await kv.get(`session:${token}`);
  if (!session || new Date(session.expiresAt) < new Date()) return null;
  return session.userId;
}

// ── Renpho API ────────────────────────────────────────────────────────────
const RENPHO_UA = 'Renpho/5.0.0 (iPhone; iOS 16.0; Scale)';

// Try multiple login strategies in sequence; return detailed error info
async function renphoLogin(email, password) {
  const strategies = [
    // Strategy 1: JSON body, v3, secure_flag as string
    {
      url: 'https://renpho.qnclouds.com/api/v3/users/sign_in.json?app_id=Renpho&locale=en',
      headers: { 'Content-Type': 'application/json', 'User-Agent': RENPHO_UA },
      body: JSON.stringify({ email, password, secure_flag: '1' }),
    },
    // Strategy 2: JSON body, v3, secure_flag as number
    {
      url: 'https://renpho.qnclouds.com/api/v3/users/sign_in.json?app_id=Renpho&locale=en',
      headers: { 'Content-Type': 'application/json', 'User-Agent': RENPHO_UA },
      body: JSON.stringify({ email, password, secure_flag: 1 }),
    },
    // Strategy 3: form-encoded, v3
    {
      url: 'https://renpho.qnclouds.com/api/v3/users/sign_in.json',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': RENPHO_UA },
      body: new URLSearchParams({ email, password, secure_flag: '1', app_id: 'Renpho', locale: 'en' }).toString(),
    },
    // Strategy 4: JSON body, v4
    {
      url: 'https://renpho.qnclouds.com/api/v4/users/sign_in.json?app_id=Renpho&locale=en',
      headers: { 'Content-Type': 'application/json', 'User-Agent': RENPHO_UA },
      body: JSON.stringify({ email, password, secure_flag: '1' }),
    },
  ];

  const attempts = [];
  for (const s of strategies) {
    try {
      const r = await fetch(s.url, { method: 'POST', headers: s.headers, body: s.body });
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch (_) { json = null; }

      attempts.push({ url: s.url, status: r.status, body: text.slice(0, 300) });

      if (!r.ok) continue;

      // Check for successful login
      if (json?.terminal_user_session_key) return json.terminal_user_session_key;
      if (json?.status_code === '20000' && json?.terminal_user_session_key) return json.terminal_user_session_key;
      if (json?.status_code && json.status_code !== '20000') {
        // Auth error — no point retrying other strategies
        throw new Error(
          (json.status_message || `Renpho login falhou (${json.status_code})`) +
          ` | detalhes: ${text.slice(0, 200)}`
        );
      }
    } catch (e) {
      if (e.message.includes('Renpho login falhou') || e.message.includes('Unauthorized')) throw e;
      attempts.push({ url: s.url, error: e.message });
    }
  }

  throw new Error(
    'Não foi possível conectar à Renpho. Tentativas: ' +
    attempts.map(a => `[${a.url.includes('v4') ? 'v4' : 'v3'} → ${a.status || a.error} ${a.body || ''}]`).join(' | ')
  );
}

async function renphoGetUserId(sessionKey) {
  const url = `https://renpho.qnclouds.com/api/v3/scale_users/list_scale_user?locale=en&terminal_user_session_key=${encodeURIComponent(sessionKey)}`;
  const r = await fetch(url, { headers: { 'User-Agent': RENPHO_UA } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Renpho scale_users HTTP ${r.status}: ${text.slice(0, 200)}`);
  let json;
  try { json = JSON.parse(text); } catch (_) { throw new Error(`Renpho scale_users resposta inválida: ${text.slice(0, 200)}`); }
  const users = json.scale_users || [];
  if (!users.length) throw new Error('Nenhum usuário de balança encontrado nesta conta Renpho');
  return users[0].user_id;
}

function parseMeasurements(raw, limit = 20) {
  return (raw || []).slice(0, limit).map(m => ({
    time: m.time_stamp || m.time,
    date: new Date(((m.time_stamp || m.time) || 0) * 1000).toISOString().slice(0, 10),
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
  const r = await fetch(url, { headers: { 'User-Agent': RENPHO_UA } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Renpho measurements HTTP ${r.status}: ${text.slice(0, 200)}`);
  let json;
  try { json = JSON.parse(text); } catch (_) { throw new Error(`Renpho measurements resposta inválida: ${text.slice(0, 200)}`); }
  return parseMeasurements(json.last_ary || json.measurements || [], 20);
}

// ── Handler ───────────────────────────────────────────────────────────────
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
    return res.status(500).json({ error: 'Redis error: ' + e.message });
  }
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  // ── GET ───────────────────────────────────────────────────────────────────
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

  // ── CONNECT ───────────────────────────────────────────────────────────────
  if (action === 'connect') {
    if (!email || !password) return res.status(400).json({ error: 'email e password são obrigatórios' });
    try {
      const sessionKey = await renphoLogin(email, password);
      const renphoUserId = await renphoGetUserId(sessionKey);
      const measurements = await fetchMeasurements(renphoUserId, sessionKey, 14);
      await kv.set(`renpho:${userId}`, {
        encEmail: encrypt(email),
        encPassword: encrypt(password),
        renphoUserId,
        connectedAt: new Date().toISOString(),
      });
      await kv.set(`renpho_sync:${userId}`, { measurements, syncedAt: Date.now() });
      return res.status(200).json({ ok: true, measurements, syncedAt: Date.now() });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // ── SYNC ──────────────────────────────────────────────────────────────────
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
      return res.status(400).json({ error: e.message });
    }
  }

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  if (action === 'disconnect') {
    try {
      await kv.del(`renpho:${userId}`);
      await kv.del(`renpho_sync:${userId}`);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action. Use: connect | sync | get | disconnect' });
}
