import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { userId, date, action } = req.method === 'GET' ? req.query : req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    if (action === 'saveProfile' || req.method === 'POST' && req.body.profile) {
      const { profile } = req.body;
      await kv.set(`profile:${userId}`, profile);
      return res.status(200).json({ ok: true });
    }

    if (action === 'getProfile') {
      const data = await kv.get(`profile:${userId}`);
      return res.status(200).json({ profile: data ?? null });
    }

    if (action === 'saveDay') {
      const { dayData } = req.body;
      await kv.set(`day:${userId}:${date}`, dayData);
      // keep index of dates
      const idx = await kv.get(`dates:${userId}`);
      const dates = idx ?? [];
      if (!dates.includes(date)) { dates.push(date); dates.sort().reverse(); }
      await kv.set(`dates:${userId}`, dates.slice(0, 60));
      return res.status(200).json({ ok: true });
    }

    if (action === 'getDay') {
      const data = await kv.get(`day:${userId}:${date}`);
      return res.status(200).json({ dayData: data ?? null });
    }

    if (action === 'getDates') {
      const data = await kv.get(`dates:${userId}`);
      return res.status(200).json({ dates: data ?? [] });
    }

    if (action === 'getAllDays') {
      const idx = await kv.get(`dates:${userId}`);
      const dates = idx ?? [];
      const days = {};
      for (const d of dates.slice(0, 30)) {
        const dd = await kv.get(`day:${userId}:${d}`);
        if (dd) days[d] = dd;
      }
      return res.status(200).json({ days });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
