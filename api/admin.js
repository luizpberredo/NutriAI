// api/admin.js — TEMPORÁRIO: inspeção e limpeza do Redis
// REMOVER após uso.
// Protegido por env var ADMIN_SECRET no Vercel.
//
// GET  /api/admin?secret=X&action=list&userId=UID
// POST /api/admin  body: {secret,action:'clean',userId,keepDate:'2026-04-23'}

import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'GET' ? req.query : (req.body || {});
  const { action, userId, keepDate } = params;
  const secret = params.secret;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!userId) return res.status(400).json({ error: 'userId required' });

  // ── LIST ─────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const keys = await kv.keys(`day:${userId}:*`);
    const result = {};
    for (const key of keys) {
      const d = await kv.get(key);
      result[key] = {
        savedAt: d?.savedAt ? new Date(d.savedAt).toISOString() : null,
        totalKcal: d?.totals?.kcal || 0,
        meals: (d?.meals || [])
          .filter(m => m.items?.length > 0)
          .map(m => ({ name: m.name, kcal: m.kcal, items: m.items.length, first: m.items[0]?.n })),
      };
    }
    const dateIndex = await kv.get(`dates:${userId}`);
    return res.status(200).json({ totalKeys: keys.length, keys: result, dateIndex: dateIndex ?? [] });
  }

  // ── CLEAN: apaga tudo exceto keepDate ────────────────────────────────────
  if (action === 'clean') {
    if (!keepDate) return res.status(400).json({ error: 'keepDate required' });
    const keys = await kv.keys(`day:${userId}:*`);
    const deleted = [], kept = [];
    for (const key of keys) {
      const date = key.split(':')[2];
      if (date === keepDate) { kept.push(key); }
      else { await kv.del(key); deleted.push(key); }
    }
    const keptDates = kept.map(k => k.split(':')[2]);
    await kv.set(`dates:${userId}`, keptDates);
    console.log(`[ADMIN] clean userId:${userId} deleted:[${deleted}] kept:[${kept}]`);
    return res.status(200).json({ deleted, kept, dateIndex: keptDates });
  }

  return res.status(400).json({ error: 'action must be list or clean' });
}
