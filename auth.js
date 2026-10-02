import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query } from './db.js';
import { config } from './config.js';
import { HttpError } from './http.js';

export const COOKIE = 'pruett_session';
const ROLE_RANK = { cashier: 1, manager: 2, admin: 3 };

export function hashPassword(pw) { return bcrypt.hash(pw, 10); }

export function validatePassword(role, pw) {
  // Cashiers may use a 4+ digit PIN; managers/admins need a real password.
  if (role === 'cashier') {
    if (!pw || pw.length < 4) return 'PIN/password must be at least 4 characters';
  } else if (!pw || pw.length < 10) {
    return 'Manager/admin passwords must be at least 10 characters';
  }
  return null;
}

// --- simple in-memory login throttling (single-instance deploy) ---
const failures = new Map();
function throttleKey(username, ip) { return `${String(username).toLowerCase()}|${ip}`; }
function isLocked(key) {
  const f = failures.get(key);
  return f && f.count >= 8 && Date.now() - f.first < 15 * 60 * 1000;
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) failures.set(key, { count: 1, first: Date.now() });
  else f.count += 1;
}

export async function verifyCredentials(username, password, ip = '') {
  const key = throttleKey(username, ip);
  if (isLocked(key)) throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes.');
  const { rows } = await query('SELECT * FROM users WHERE lower(username) = lower($1) AND active', [username]);
  const user = rows[0];
  const ok = user && (await bcrypt.compare(password || '', user.password_hash));
  if (!ok) {
    recordFailure(key);
    throw new HttpError(401, 'Wrong username or password');
  }
  failures.delete(key);
  return user;
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [token, userId, String(config.sessionDays)],
  );
  return token;
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: config.sessionDays * 86400 * 1000,
  });
}

export async function loadUser(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (token) {
    const { rows } = await query(
      `SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > now() AND u.active`,
      [token],
    );
    req.user = rows[0];
  }
  next();
}

export function requireRole(min = 'cashier') {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    if (ROLE_RANK[req.user.role] < ROLE_RANK[min]) return next(new HttpError(403, `Requires ${min} access`));
    next();
  };
}

export const isManager = (user) => user && ROLE_RANK[user.role] >= ROLE_RANK.manager;

// --- manager approvals (price overrides, voids, returns without receipt) ---
// One-time tokens, valid 15 minutes, kept in memory.
const approvals = new Map();

export async function createApproval(username, password, ip) {
  const user = await verifyCredentials(username, password, ip);
  if (!isManager(user)) throw new HttpError(403, `${user.name} is not a manager`);
  const token = crypto.randomBytes(16).toString('hex');
  approvals.set(token, { userId: user.id, name: user.name, expires: Date.now() + 15 * 60 * 1000 });
  return { token, approvedBy: user.name };
}

/** Returns the approving manager's user id, or throws. Consumes the token. */
export function useApproval(token) {
  const a = token && approvals.get(token);
  if (!a || a.expires < Date.now()) throw new HttpError(403, 'Manager approval required');
  approvals.delete(token);
  return a.userId;
}
