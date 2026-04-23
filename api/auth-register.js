import { Redis } from '@upstash/redis';
import bcrypt from 'bcryptjs';

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

  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email e password são obrigatórios' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
  }

  const emailKey = `user:email:${email.toLowerCase().trim()}`;

  try {
    const existing = await kv.get(emailKey);
    if (existing) return res.status(409).json({ error: 'E-mail já cadastrado' });

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID();
    const user = {
      id: userId,
      email: email.toLowerCase().trim(),
      name: name.trim(),
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    await kv.set(emailKey, user);

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await kv.set(`session:${token}`, {
      userId,
      email: user.email,
      name: user.name,
      expiresAt,
    }, { ex: 30 * 24 * 60 * 60 });

    return res.status(200).json({ token, userId, name: user.name, email: user.email });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
