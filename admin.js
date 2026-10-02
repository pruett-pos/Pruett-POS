// Categories (margins), vendors, users and store settings.
import { Router } from 'express';
import { query, tx, audit } from '../db.js';
import { requireRole, hashPassword, validatePassword } from '../auth.js';
import { parse, z, HttpError } from '../http.js';
import { getSettings, setSetting, DEFAULT_SETTINGS } from '../settings.js';
import { repriceCategory } from '../services/catalog.js';

const r = Router();
const db = { query };
r.param('id', (req, _res, next, id) => (/^\d+$/.test(id) ? next() : next(new HttpError(404, 'Not found'))));

// ----- categories -----
r.get('/categories', requireRole('cashier'), async (_req, res) => {
  const { rows } = await query(`SELECT c.*, (SELECT count(*) FROM products p WHERE p.category_id = c.id AND p.active) AS product_count
    FROM categories c ORDER BY name`);
  res.json(rows);
});

const catSchema = z.object({ name: z.string().trim().min(1).max(60), margin_pct: z.number().min(0).max(95) });

r.post('/categories', requireRole('manager'), async (req, res) => {
  const c = parse(catSchema, req.body);
  const { rows } = await query('INSERT INTO categories (name, margin_pct) VALUES ($1,$2) RETURNING *', [c.name, c.margin_pct]);
  await audit(db, req.user.id, 'category.create', 'category', rows[0].id, c);
  res.status(201).json(rows[0]);
});

// Changing a margin returns a preview; send apply=true to update the category and reprice its products.
r.put('/categories/:id', requireRole('manager'), async (req, res) => {
  const c = parse(catSchema.extend({ apply: z.boolean().default(false) }), req.body);
  const id = Number(req.params.id);
  const out = await tx(async (t) => {
    const { rows: [old] } = await t.query('SELECT * FROM categories WHERE id = $1 FOR UPDATE', [id]);
    if (!old) throw new HttpError(404, 'Category not found');
    await t.query('UPDATE categories SET name = $2, margin_pct = $3 WHERE id = $1', [id, c.name, c.margin_pct]);
    const preview = await repriceCategory(t, id, { apply: c.apply, userId: req.user.id });
    if (!c.apply) throw Object.assign(new Error('preview'), { preview });
    await audit(t, req.user.id, 'category.update', 'category', id, { from: old.margin_pct, to: c.margin_pct, repriced: preview.changes.length });
    return preview;
  }).catch((e) => { if (e.preview) return { ...e.preview, preview: true }; throw e; });
  res.json({ ...out, changes: out.changes.slice(0, 300), changeCount: out.changes.length });
});

// ----- price levels (Paladin pricing plans) -----
r.get('/price-levels', requireRole('cashier'), async (_req, res) => {
  const { rows } = await query(`SELECT pl.*, (SELECT count(*) FROM customers c WHERE c.price_level_id = pl.id AND c.active) AS customer_count
    FROM price_levels pl ORDER BY sort, name`);
  res.json(rows);
});
const levelSchema = z.object({
  name: z.string().trim().min(1).max(40),
  kind: z.enum(['discount', 'cost_plus']),
  pct: z.number().min(0).max(300).nullable(),
});
r.post('/price-levels', requireRole('manager'), async (req, res) => {
  const l = parse(levelSchema, req.body);
  if (l.kind === 'discount' && l.pct != null && l.pct >= 100) throw new HttpError(400, 'A discount must be under 100%');
  const { rows } = await query('INSERT INTO price_levels (name, kind, pct, sort) VALUES ($1,$2,$3,(SELECT COALESCE(max(sort),0)+10 FROM price_levels)) RETURNING *', [l.name, l.kind, l.pct]);
  await audit(db, req.user.id, 'price_level.create', 'price_level', rows[0].id, l);
  res.status(201).json(rows[0]);
});
r.put('/price-levels/:id', requireRole('manager'), async (req, res) => {
  const l = parse(levelSchema, req.body);
  if (l.kind === 'discount' && l.pct != null && l.pct >= 100) throw new HttpError(400, 'A discount must be under 100%');
  const { rows } = await query('UPDATE price_levels SET name=$2, kind=$3, pct=$4 WHERE id=$1 RETURNING *', [Number(req.params.id), l.name, l.kind, l.pct]);
  if (!rows[0]) throw new HttpError(404, 'Price level not found');
  await audit(db, req.user.id, 'price_level.update', 'price_level', rows[0].id, l);
  res.json(rows[0]);
});

// ----- vendors -----
r.get('/vendors', requireRole('cashier'), async (_req, res) => {
  const { rows } = await query('SELECT * FROM vendors ORDER BY name');
  res.json(rows);
});
const vendSchema = z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().max(120).nullish(), account_no: z.string().max(40).nullish(), notes: z.string().max(500).nullish() });
r.post('/vendors', requireRole('manager'), async (req, res) => {
  const v = parse(vendSchema, req.body);
  const { rows } = await query('INSERT INTO vendors (name, email, account_no, notes) VALUES ($1,$2,$3,$4) RETURNING *', [v.name, v.email || null, v.account_no || null, v.notes || null]);
  res.status(201).json(rows[0]);
});
r.put('/vendors/:id', requireRole('manager'), async (req, res) => {
  const v = parse(vendSchema, req.body);
  const { rows } = await query('UPDATE vendors SET name=$2, email=$3, account_no=$4, notes=$5 WHERE id=$1 RETURNING *', [Number(req.params.id), v.name, v.email || null, v.account_no || null, v.notes || null]);
  if (!rows[0]) throw new HttpError(404, 'Vendor not found');
  res.json(rows[0]);
});

// ----- settings -----
r.get('/settings', requireRole('cashier'), async (_req, res) => res.json(await getSettings()));

const settingsSchema = z.object({
  store: z.object({ name: z.string().max(80), address: z.string().max(200), phone: z.string().max(30) }).optional(),
  tax_rate_pct: z.number().min(0).max(20).nullable().optional(),
  price_rounding_cents: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(25)]).optional(),
  default_margin_pct: z.number().min(0).max(95).optional(),
  receipt_footer: z.string().max(300).optional(),
  require_manager_for_price_override: z.boolean().optional(),
  large_change_flag_pct: z.number().min(0).max(100).optional(),
});

r.put('/settings', requireRole('manager'), async (req, res) => {
  const s = parse(settingsSchema, req.body);
  await tx(async (t) => {
    for (const [k, v] of Object.entries(s)) if (k in DEFAULT_SETTINGS) await setSetting(t, k, v);
    await audit(t, req.user.id, 'settings.update', 'settings', null, s);
  });
  res.json(await getSettings());
});

// ----- users -----
r.get('/users', requireRole('manager'), async (_req, res) => {
  const { rows } = await query('SELECT id, username, name, email, role, active, created_at FROM users ORDER BY active DESC, name');
  res.json(rows);
});

const userSchema = z.object({
  username: z.string().trim().min(2).max(40).regex(/^[a-zA-Z0-9._-]+$/, 'letters, numbers, . _ - only'),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().max(120).nullish(),
  role: z.enum(['admin', 'manager', 'cashier']),
  password: z.string().max(100).optional(),
  active: z.boolean().optional(),
});

function checkRoleChange(actor, role) {
  if (role === 'admin' && actor.role !== 'admin') throw new HttpError(403, 'Only an admin can create admins');
}

r.post('/users', requireRole('manager'), async (req, res) => {
  const u = parse(userSchema, req.body);
  checkRoleChange(req.user, u.role);
  const err = validatePassword(u.role, u.password);
  if (err) throw new HttpError(400, err);
  const { rows } = await query(
    'INSERT INTO users (username, name, email, role, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, name, email, role, active',
    [u.username, u.name, u.email || null, u.role, await hashPassword(u.password)],
  );
  await audit(db, req.user.id, 'user.create', 'user', rows[0].id, { username: u.username, role: u.role });
  res.status(201).json(rows[0]);
});

r.put('/users/:id', requireRole('manager'), async (req, res) => {
  const u = parse(userSchema.partial(), req.body);
  const id = Number(req.params.id);
  const { rows: [cur] } = await query('SELECT * FROM users WHERE id = $1', [id]);
  if (!cur) throw new HttpError(404, 'User not found');
  if (cur.role === 'admin' && req.user.role !== 'admin') throw new HttpError(403, 'Only an admin can change an admin');
  if (u.role) checkRoleChange(req.user, u.role);
  if (id === req.user.id && (u.active === false || (u.role && u.role !== cur.role))) throw new HttpError(400, "You can't deactivate or change your own role");
  const role = u.role || cur.role;
  let hash = cur.password_hash;
  if (u.password) {
    const err = validatePassword(role, u.password);
    if (err) throw new HttpError(400, err);
    hash = await hashPassword(u.password);
  } else if (role !== cur.role && role !== 'cashier') {
    throw new HttpError(400, 'Set a new password (10+ characters) when promoting to manager/admin');
  }
  const { rows } = await query(
    `UPDATE users SET username=$2, name=$3, email=$4, role=$5, password_hash=$6, active=$7 WHERE id=$1
     RETURNING id, username, name, email, role, active`,
    [id, u.username ?? cur.username, u.name ?? cur.name, u.email ?? cur.email, role, hash, u.active ?? cur.active],
  );
  if (u.password || u.active === false) await query('DELETE FROM sessions WHERE user_id = $1 AND $1 <> $2', [id, req.user.id]);
  await audit(db, req.user.id, 'user.update', 'user', id, { ...u, password: u.password ? '***' : undefined });
  res.json(rows[0]);
});

export default r;
