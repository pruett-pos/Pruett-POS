import { Router } from 'express';
import multer from 'multer';
import { query, tx, audit } from '../db.js';
import { requireRole } from '../auth.js';
import { parse, z, HttpError } from '../http.js';
import { getProduct, findByCode, searchProducts, createProduct, updateProduct, adjustInventory } from '../services/catalog.js';
import { stageImport, runImport, TARGETS } from '../services/importer.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const db = { query };

r.param('id', (req, _res, next, id) => (/^\d+$/.test(id) ? next() : next(new HttpError(404, 'Not found'))));

const money = z.number().int().min(0);
const productSchema = z.object({
  sku: z.string().trim().min(1).max(60),
  upc: z.string().trim().max(40).nullish(),
  description: z.string().trim().min(1).max(200),
  category_id: z.number().int().nullish(),
  vendor_id: z.number().int().nullish(),
  vendor_sku: z.string().trim().max(60).nullish(),
  unit: z.string().trim().max(10).nullish(),
  cost_cents: money,
  retail_cents: money.nullish(),
  price_override: z.boolean().optional(),
  taxable: z.boolean().optional(),
  on_hand: z.number().optional(),
  reorder_point: z.number().nullish(),
  reorder_qty: z.number().nullish(),
  location: z.string().trim().max(40).nullish(),
  active: z.boolean().optional(),
  target_margin_pct: z.number().min(0).max(95).nullish(),
  description2: z.string().trim().max(200).nullish(),
  needs_review: z.string().trim().max(200).nullish(),
});

r.get('/', requireRole('cashier'), async (req, res) => {
  const { q, category_id, low_stock, needs_review, inactive, limit, offset } = req.query;
  res.json(await searchProducts(db, {
    q: q?.trim(), categoryId: category_id ? Number(category_id) : null, lowStock: low_stock === '1', needsReview: needs_review === '1',
    includeInactive: inactive === '1', limit: Number(limit) || 50, offset: Number(offset) || 0,
  }));
});

r.get('/lookup/:code', requireRole('cashier'), async (req, res) => {
  const p = await findByCode(db, req.params.code);
  if (!p) throw new HttpError(404, `No item found for "${req.params.code}"`);
  res.json(p);
});

r.get('/:id', requireRole('cashier'), async (req, res) => {
  const p = await getProduct(db, Number(req.params.id));
  const { rows: history } = await query(
    `SELECT h.*, u.name AS user_name FROM price_history h LEFT JOIN users u ON u.id = h.user_id
     WHERE product_id = $1 ORDER BY created_at DESC LIMIT 25`, [p.id]);
  const { rows: movements } = await query(
    `SELECT m.*, u.name AS user_name FROM inventory_movements m LEFT JOIN users u ON u.id = m.user_id
     WHERE product_id = $1 ORDER BY created_at DESC LIMIT 25`, [p.id]);
  const { rows: barcodes } = await query('SELECT barcode FROM product_barcodes WHERE product_id = $1', [p.id]);
  res.json({ ...p, history, movements, barcodes: barcodes.map((b) => b.barcode) });
});

r.post('/', requireRole('manager'), async (req, res) => {
  const data = parse(productSchema, req.body);
  const id = await tx(async (t) => {
    const id = await createProduct(t, data, req.user.id);
    await audit(t, req.user.id, 'product.create', 'product', id, { sku: data.sku });
    return id;
  });
  res.status(201).json(await getProduct(db, id));
});

r.put('/:id', requireRole('manager'), async (req, res) => {
  const data = parse(productSchema.partial(), req.body);
  delete data.on_hand; // on-hand changes go through /adjust so they are logged
  const p = await tx(async (t) => {
    const p = await updateProduct(t, Number(req.params.id), data, req.user.id);
    await audit(t, req.user.id, 'product.update', 'product', p.id, data);
    return p;
  });
  res.json(p);
});

r.post('/:id/barcodes', requireRole('manager'), async (req, res) => {
  const { barcode } = parse(z.object({ barcode: z.string().trim().min(3).max(40) }), req.body);
  await query('INSERT INTO product_barcodes (barcode, product_id) VALUES ($1,$2)', [barcode, Number(req.params.id)]);
  res.status(201).json({ ok: true });
});

r.delete('/:id/barcodes/:barcode', requireRole('manager'), async (req, res) => {
  await query('DELETE FROM product_barcodes WHERE barcode = $1 AND product_id = $2', [req.params.barcode, Number(req.params.id)]);
  res.json({ ok: true });
});

// Receive stock or correct a count.
r.post('/:id/adjust', requireRole('manager'), async (req, res) => {
  const body = parse(z.object({
    mode: z.enum(['receive', 'set', 'adjust']),
    qty: z.number(),
    ref: z.string().max(100).optional(),
  }), req.body);
  const id = Number(req.params.id);
  await tx(async (t) => {
    const { rows: [p] } = await t.query('SELECT on_hand FROM products WHERE id = $1 FOR UPDATE', [id]);
    if (!p) throw new HttpError(404, 'Product not found');
    const delta = body.mode === 'set' ? body.qty - p.on_hand : body.qty;
    if (delta !== 0) await adjustInventory(t, { productId: id, qtyChange: delta, reason: body.mode === 'receive' ? 'receive' : 'adjust', ref: body.ref, userId: req.user.id });
  });
  res.json(await getProduct(db, id));
});

// ----- Paladin / spreadsheet import -----
r.get('/import/targets', requireRole('manager'), (_req, res) => res.json(Object.keys(TARGETS)));

r.post('/import/upload', requireRole('manager'), upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  res.json(await stageImport(req.file.buffer, req.file.originalname));
});

const importBody = z.object({
  importId: z.string(),
  mapping: z.record(z.string(), z.number().int().nullable()),
  options: z.object({ priceMode: z.enum(['margin', 'keep']).default('margin'), updateOnHand: z.boolean().default(false) }).default({ priceMode: 'margin', updateOnHand: false }),
});

r.post('/import/preview', requireRole('manager'), async (req, res) => {
  const b = parse(importBody, req.body);
  res.json(await runImport(db, b.importId, b.mapping, b.options, req.user.id, false));
});

r.post('/import/commit', requireRole('manager'), async (req, res) => {
  const b = parse(importBody, req.body);
  const result = await tx(async (t) => {
    const out = await runImport(t, b.importId, b.mapping, b.options, req.user.id, true);
    await audit(t, req.user.id, 'product.import', 'import', b.importId, { created: out.created, updated: out.updated, errors: out.errors.length });
    return out;
  });
  res.json(result);
});

export default r;
