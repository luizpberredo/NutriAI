// api/renpho-save.js
// POST /api/renpho-save  body: { token, email, password }  → save credentials
// GET  /api/renpho-save?action=load&token=...              → load saved credentials
// GET  /api/renpho-save?action=disconnect&token=...        → delete saved credentials

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

// Simple base64 obfuscation — credentials are stored server-side (Redis),
// protected by the user's session token. For strong encryption use renpho.js
// which implements AES-256-GCM via RENPHO_ENCRYPTION_KEY.
function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decode(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf8');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET /api/renpho-save?action=load&token=... ───────────────────────────
  // ── GET /api/renpho-save?action=disconnect&token=... ────────────────────
  if (req.method === 'GET') {
    const { action, token } = req.query;
    let userId;
    try {
      userId = await resolveUserId(token);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    if (action === 'load') {
      try {
        const saved = await kv.get(`renpho_save:${userId}`);
        if (!saved) return res.status(200).json({ saved: false });
        return res.status(200).json({
          saved: true,
          email: saved.encEmail ? decode(saved.encEmail) : null,
          savedAt: saved.savedAt,
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'disconnect') {
      try {
        await kv.del(`renpho_save:${userId}`);
        await kv.del(`renpho_sync:${userId}`);
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Unknown action. Use action=load or action=disconnect' });
  }

  // ── POST /api/renpho-save  body: { token, email, password } ─────────────
  if (req.method === 'POST') {
    const { token, email, password } = req.body || {};
    if (!token) return res.status(401).json({ error: 'token required' });
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    let userId;
    try {
      userId = await resolveUserId(token);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const record = {
        encEmail: encode(email),
        encPassword: encode(password),
        savedAt: new Date().toISOString(),
      };
      await kv.set(`renpho_save:${userId}`, record);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
