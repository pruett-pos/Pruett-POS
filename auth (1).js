import { Router } from 'express';
import { query } from '../db.js';
import { verifyCredentials, createSession, setSessionCookie, COOKIE, createApproval, requireRole } from '../auth.js';
import { parse, z } from '../http.js';
import { getSettings } from '../settings.js';
import { config } from '../config.js';

const r = Router();

r.post('/login', async (req, res) => {
  const { username, password } = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
  const user = await verifyCredentials(username, password, req.ip);
  const token = await createSession(user.id);
  setSessionCookie(res, token);
  res.json({ user: { id: user.id, name: user.name, username: user.username, role: user.role } });
});

r.post('/logout', async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) await query('DELETE FROM sessions WHERE token = $1', [token]);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

r.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const s = await getSettings();
  res.json({ user: req.user, store: s.store, cardMode: config.stripeSimulated ? 'simulated' : (config.stripeSecretKey.startsWith('sk_test_') ? 'stripe-test' : 'stripe') });
});

// A manager types their credentials on the cashier's screen to approve an override.
r.post('/approve', requireRole('cashier'), async (req, res) => {
  const { username, password } = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
  res.json(await createApproval(username, password, req.ip));
});

export default r;
