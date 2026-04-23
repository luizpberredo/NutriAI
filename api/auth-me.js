import { Redis } from '@upstash/redis';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
