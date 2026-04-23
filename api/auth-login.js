import { Redis } from '@upstash/redis';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email e password são obrigatórios' });
  }

  try {
    const user = await kv.get(`user:email:${email.toLowerCase().trim()}`);
    if (!user) return res.status(401).json({ error: 'E-mail ou senha inválidos' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'E-mail ou senha inválidos' });

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await kv.set(`session:${token}`, {
      userId: user.id,
      email: user.email,
      name: user.name,
      expiresAt,
    }, { ex: 30 * 24 * 60 * 60 });

    return res.status(200).json({ token, userId: user.id, name: user.name, email: user.email });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
