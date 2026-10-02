import { Router } from 'express';
import { query, audit } from '../db.js';
import { requireRole } from '../auth.js';
import { parse, z, HttpError } from '../http.js';
import { priceCart, completeSale, getSale, getSaleByNumber, createReturn, voidSale } from '../services/checkout.js';
import { cards } from '../services/cardPayments.js';
import { config } from '../config.js';

const r = Router();
const db = { query };
r.param('id', (req, _res, next, id) => (/^\d+$/.test(id) ? next() : next(new HttpError(404, 'Not found'))));

const qty = z.number().positive().max(100000);
const lineSchema = z.object({
  product_id: z.number().int().nullish(),
  qty,
  unit_price_cents: z.number().int().min(0).nullish(),
  description: z.string().trim().max(200).optional(),
  taxable: z.boolean().optional(),
});

r.post('/price', requireRole('cashier'), async (req, res) => {
  const b = parse(z.object({ customer_id: z.number().int().nullish(), lines: z.array(lineSchema).max(500) }), req.body);
  res.json(await priceCart(db, b));
});

r.post('/', requireRole('cashier'), async (req, res) => {
  const b = parse(z.object({
    customer_id: z.number().int().nullish(),
    lines: z.array(lineSchema).min(1).max(500),
    payments: z.array(z.object({
      method: z.enum(['cash', 'check', 'card', 'charge']),
      amount_cents: z.number().int(),
      tendered_cents: z.number().int().nullish(),
      check_number: z.string().max(30).nullish(),
      payment_intent_id: z.string().max(100).nullish(),
    })).min(1).max(10),
    po_number: z.string().trim().max(40).nullish(),
    notes: z.string().max(500).nullish(),
    register: z.string().max(40).nullish(),
    approval_token: z.string().max(64).nullish(),
  }), req.body);
  res.status(201).json(await completeSale(b, req.user));
});

r.get('/', requireRole('cashier'), async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.number) { params.push(Number(req.query.number)); where.push(`s.number = $${params.length}`); }
  if (req.query.customer_id) { params.push(Number(req.query.customer_id)); where.push(`s.customer_id = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); where.push(`s.created_at >= $${params.length}::date`); }
  if (req.query.to) { params.push(req.query.to); where.push(`s.created_at < $${params.length}::date + 1`); }
  if (req.query.q) { params.push(`%${req.query.q}%`); where.push(`(c.name ILIKE $${params.length} OR c.company ILIKE $${params.length} OR s.po_number ILIKE $${params.length})`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT s.id, s.number, s.kind, s.status, s.total_cents, s.created_at, s.po_number, s.register, u.name AS cashier,
       c.name AS customer_name, c.company AS customer_company,
       (SELECT string_agg(DISTINCT p.method, ', ') FROM payments p WHERE p.sale_id = s.id) AS methods
     FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
     ${w} ORDER BY s.created_at DESC LIMIT 200`, params);
  res.json(rows);
});

r.get('/number/:number', requireRole('cashier'), async (req, res) => {
  const n = Number(req.params.number);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Bad receipt number');
  res.json(await getSaleByNumber(db, n));
});

r.post('/returns', requireRole('cashier'), async (req, res) => {
  const b = parse(z.object({
    original_sale_id: z.number().int().nullish(),
    customer_id: z.number().int().nullish(),
    lines: z.array(z.object({ original_line_id: z.number().int().optional(), product_id: z.number().int().optional(), qty })).min(1),
    refund_method: z.enum(['original', 'cash', 'check', 'card', 'charge']),
    restock: z.boolean().default(true),
    approval_token: z.string().max(64).nullish(),
    notes: z.string().max(500).nullish(),
    register: z.string().max(40).nullish(),
  }), req.body);
  res.status(201).json(await createReturn(b, req.user));
});

r.post('/:id/void', requireRole('cashier'), async (req, res) => {
  const b = parse(z.object({ approval_token: z.string().max(64).nullish(), reason: z.string().max(200).optional() }), req.body);
  res.json(await voidSale(Number(req.params.id), req.user, b.approval_token, b.reason));
});

// End-of-day summary for counting the drawer.
r.get('/summary/day', requireRole('cashier'), async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const tz = 'America/Chicago';
  const dayExpr = day ? '$1::date' : `(now() AT TIME ZONE '${tz}')::date`;
  const params = day ? [day] : [];
  const regFilter = req.query.register ? ` AND s.register = $${params.push(req.query.register)}` : '';
  const { rows: tenders } = await query(
    `SELECT p.method, count(*) AS count, sum(p.amount_cents) AS amount_cents
     FROM payments p JOIN sales s ON s.id = p.sale_id
     WHERE s.status = 'completed' AND (s.completed_at AT TIME ZONE '${tz}')::date = ${dayExpr}${regFilter}
     GROUP BY p.method ORDER BY p.method`, params);
  const { rows: [totals] } = await query(
    `SELECT count(*) FILTER (WHERE kind = 'sale') AS sales, count(*) FILTER (WHERE kind = 'return') AS returns,
       COALESCE(sum(subtotal_cents),0) AS subtotal_cents, COALESCE(sum(tax_cents),0) AS tax_cents, COALESCE(sum(total_cents),0) AS total_cents,
       COALESCE(sum((SELECT sum(l.line_total_cents - round(l.qty * l.cost_cents)) FROM sale_lines l WHERE l.sale_id = s.id)),0) AS gross_profit_cents
     FROM sales s WHERE status = 'completed' AND (completed_at AT TIME ZONE '${tz}')::date = ${dayExpr}${regFilter}`, params);
  const { rows: [voids] } = await query(
    `SELECT count(*) AS count, COALESCE(sum(total_cents),0) AS amount_cents FROM sales s
     WHERE status = 'voided' AND (voided_at AT TIME ZONE '${tz}')::date = ${dayExpr}${regFilter}`, params);
  res.json({ date: day, tenders, totals, voids });
});

// ----- card reader -----
r.get('/card/readers', requireRole('cashier'), async (_req, res) => {
  res.json({ mode: cards().mode, readers: await cards().listReaders() });
});

r.post('/card/start', requireRole('cashier'), async (req, res) => {
  const b = parse(z.object({ amount_cents: z.number().int().positive().max(5_000_000), reader_id: z.string().max(60).nullish() }), req.body);
  const { paymentIntentId } = await cards().start({ amountCents: b.amount_cents, readerId: b.reader_id, description: 'Pruett POS sale' });
  await query('INSERT INTO card_attempts (payment_intent_id, reader_id, amount_cents, user_id) VALUES ($1,$2,$3,$4)',
    [paymentIntentId, b.reader_id || null, b.amount_cents, req.user.id]);
  res.json({ payment_intent_id: paymentIntentId, mode: cards().mode });
});

async function attempt(pi) {
  const { rows: [a] } = await query('SELECT * FROM card_attempts WHERE payment_intent_id = $1', [pi]);
  if (!a) throw new HttpError(404, 'Unknown card payment');
  return a;
}

r.get('/card/:pi', requireRole('cashier'), async (req, res) => {
  const a = await attempt(req.params.pi);
  if (a.status === 'used') return res.json({ status: 'used' });
  const s = await cards().status(a.payment_intent_id, a.reader_id);
  if (s.status !== a.status) {
    await query('UPDATE card_attempts SET status=$2, failure_message=$3, card_brand=$4, card_last4=$5, updated_at=now() WHERE id=$1',
      [a.id, s.status, s.message || null, s.brand || null, s.last4 || null]);
  }
  res.json(s);
});

r.post('/card/:pi/cancel', requireRole('cashier'), async (req, res) => {
  const a = await attempt(req.params.pi);
  if (a.status === 'used') throw new HttpError(400, 'Payment already attached to a sale');
  await cards().cancel(a.payment_intent_id, a.reader_id);
  await query(`UPDATE card_attempts SET status='canceled', updated_at=now() WHERE id=$1`, [a.id]);
  await audit(db, req.user.id, 'card.cancel', 'card', a.payment_intent_id, null);
  res.json({ ok: true });
});

r.post('/card/:pi/simulate-tap', requireRole('cashier'), async (req, res) => {
  const a = await attempt(req.params.pi);
  if (config.isProduction && !config.stripeSecretKey.startsWith('sk_test_') && !config.stripeSimulated) throw new HttpError(400, 'Not available');
  await cards().simulateTap(a.reader_id);
  res.json({ ok: true });
});

r.get('/:id', requireRole('cashier'), async (req, res) => res.json(await getSale(db, Number(req.params.id))));

export default r;
