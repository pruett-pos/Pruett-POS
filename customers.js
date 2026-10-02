import { Router } from 'express';
import multer from 'multer';
import { query, audit, tx } from '../db.js';
import { stageImport } from '../services/importer.js';
import { runCustomerImport } from '../services/customerImport.js';
import { requireRole } from '../auth.js';
import { parse, z, HttpError } from '../http.js';

const r = Router();
const db = { query };
r.param('id', (req, _res, next, id) => (/^\d+$/.test(id) ? next() : next(new HttpError(404, 'Not found'))));

r.get('/', requireRole('cashier'), async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = [];
  let where = 'WHERE c.active';
  if (q) {
    params.push(`%${q}%`);
    const digits = q.replace(/\D/g, '');
    let phoneMatch = '';
    if (digits.length >= 3) { params.push(`%${digits}%`); phoneMatch = ` OR regexp_replace(c.phone, '\\D', '', 'g') LIKE $2`; }
    where += ` AND (c.name ILIKE $1 OR c.company ILIKE $1 OR c.phone ILIKE $1 OR c.email ILIKE $1${phoneMatch})`;
  }
  if (req.query.charge === '1') where += ' AND c.charge_account';
  const { rows } = await query(`SELECT c.*, pl.name AS level_name, pl.pct AS level_pct FROM customers c
    LEFT JOIN price_levels pl ON pl.id = c.price_level_id ${where} ORDER BY c.name LIMIT 100`, params);
  res.json(rows);
});

r.get('/:id', requireRole('cashier'), async (req, res) => {
  const { rows: [c] } = await query(`SELECT c.*, pl.name AS level_name, pl.pct AS level_pct FROM customers c
    LEFT JOIN price_levels pl ON pl.id = c.price_level_id WHERE c.id = $1`, [Number(req.params.id)]);
  if (!c) throw new HttpError(404, 'Customer not found');
  const { rows: sales } = await query(
    `SELECT id, number, kind, status, total_cents, created_at, po_number FROM sales WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`, [c.id]);
  res.json({ ...c, sales });
});

const custSchema = z.object({
  name: z.string().trim().min(1).max(100),
  company: z.string().trim().max(100).nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().max(120).nullish(),
  address: z.string().trim().max(300).nullish(),
  price_level_id: z.number().int().nullish(),
  charge_account: z.boolean().default(false),
  credit_limit_cents: z.number().int().min(0).default(0),
  terms_days: z.number().int().min(0).max(120).default(30),
  tax_exempt: z.boolean().default(false),
  tax_exempt_cert: z.string().trim().max(60).nullish(),
  notes: z.string().max(1000).nullish(),
  require_po: z.boolean().default(false),
  checkout_note: z.string().trim().max(500).nullish(),
  email_statements: z.boolean().default(false),
  active: z.boolean().default(true),
});

// Only managers can open charge accounts, set credit limits or mark tax exempt.
function guardSensitive(user, data, current) {
  if (user.role !== 'cashier') return;
  const changed = (k) => (current ? (data[k] ?? null) !== (current[k] ?? null) : !!data[k]);
  if (changed('charge_account') || changed('credit_limit_cents') || changed('tax_exempt') || changed('price_level_id')) {
    throw new HttpError(403, 'A manager must set up contractor pricing, charge accounts and tax exemptions');
  }
}

r.post('/', requireRole('cashier'), async (req, res) => {
  const c = parse(custSchema, req.body);
  guardSensitive(req.user, { ...c, credit_limit_cents: c.credit_limit_cents || undefined }, null);
  const { rows } = await query(
    `INSERT INTO customers (name, company, phone, email, address, price_level_id, charge_account, credit_limit_cents, terms_days, tax_exempt,
       tax_exempt_cert, notes, active, require_po, checkout_note, email_statements)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [c.name, c.company || null, c.phone || null, c.email || null, c.address || null, c.price_level_id ?? null, c.charge_account, c.credit_limit_cents,
      c.terms_days, c.tax_exempt, c.tax_exempt_cert || null, c.notes || null, c.active, c.require_po, c.checkout_note || null, c.email_statements],
  );
  await audit(db, req.user.id, 'customer.create', 'customer', rows[0].id, { name: c.name, price_level_id: c.price_level_id, charge: c.charge_account });
  res.status(201).json(rows[0]);
});

r.put('/:id', requireRole('cashier'), async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [cur] } = await query('SELECT * FROM customers WHERE id = $1', [id]);
  if (!cur) throw new HttpError(404, 'Customer not found');
  const c = parse(custSchema, { ...cur, ...req.body });
  guardSensitive(req.user, c, cur);
  const { rows } = await query(
    `UPDATE customers SET name=$2, company=$3, phone=$4, email=$5, address=$6, price_level_id=$7, charge_account=$8, credit_limit_cents=$9,
       terms_days=$10, tax_exempt=$11, tax_exempt_cert=$12, notes=$13, active=$14, require_po=$15, checkout_note=$16, email_statements=$17
     WHERE id=$1 RETURNING *`,
    [id, c.name, c.company || null, c.phone || null, c.email || null, c.address || null, c.price_level_id ?? null, c.charge_account, c.credit_limit_cents,
      c.terms_days, c.tax_exempt, c.tax_exempt_cert || null, c.notes || null, c.active, c.require_po, c.checkout_note || null, c.email_statements],
  );
  await audit(db, req.user.id, 'customer.update', 'customer', id, req.body);
  res.json(rows[0]);
});

// ----- Paladin customer import -----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
r.post('/import/upload', requireRole('manager'), upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  const staged = await stageImport(req.file.buffer, req.file.originalname);
  res.json({ ...staged, preview: await runCustomerImport(db, staged.importId, req.user.id, false) });
});
r.post('/import/commit', requireRole('manager'), async (req, res) => {
  const { importId } = parse(z.object({ importId: z.string() }), req.body);
  const out = await tx(async (t) => {
    const result = await runCustomerImport(t, importId, req.user.id, true);
    await audit(t, req.user.id, 'customer.import', 'import', importId, { created: result.created, updated: result.updated });
    return result;
  });
  res.json(out);
});

export default r;
