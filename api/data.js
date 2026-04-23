import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function resolveUserId(token) {
  if (!token) return null;
  const session = await kv.get(`session:${token}`);
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    await kv.del(`session:${token}`);
    return null;
  }
  return session.userId;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'GET' ? req.query : req.body;
  const { action, date } = params;
  const token = params.token;

  let userId;
  try {
    userId = await resolveUserId(token);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (action === 'saveProfile') {
      const { profile } = params;
      await kv.set(`profile:${userId}`, profile);
      return res.status(200).json({ ok: true });
    }

    if (action === 'getProfile') {
      const data = await kv.get(`profile:${userId}`);
      return res.status(200).json({ profile: data ?? null });
    }

    if (action === 'saveDay') {
      const { dayData } = params;
      await kv.set(`day:${userId}:${date}`, dayData);
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

    if (action === 'saveOnboarding') {
      await kv.set(`onboarding:${userId}`, { done: true, completedAt: new Date().toISOString() });
      return res.status(200).json({ ok: true });
    }

    if (action === 'getOnboarding') {
      const data = await kv.get(`onboarding:${userId}`);
      return res.status(200).json({ onboarding: data ?? null });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
