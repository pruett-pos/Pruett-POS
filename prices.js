// Price agent: documents, batches, approvals.
import { Router } from 'express';
import multer from 'multer';
import { query, tx } from '../db.js';
import { requireRole } from '../auth.js';
import { parse, z, HttpError } from '../http.js';
import { config } from '../config.js';
import { receiveDocument, enqueue, checkInbox } from '../services/priceAgent/intake.js';
import { decideItems, changeBatchColumn } from '../services/priceAgent/batches.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
r.param('id', (req, _res, next, id) => (/^\d+$/.test(id) ? next() : next(new HttpError(404, 'Not found'))));
r.use(requireRole('manager'));

r.get('/status', async (_req, res) => {
  const { rows: [c] } = await query(`SELECT count(*) FILTER (WHERE status IN ('pending','partially_approved')) AS waiting FROM price_batches`);
  res.json({
    aiConfigured: Boolean(config.anthropicApiKey), model: config.anthropicModel,
    inbox: config.imapUser || null, inboxConfigured: Boolean(config.imapUser && config.imapPassword),
    notify: config.notifyEmails, waiting: c.waiting,
  });
});

r.get('/batches', async (req, res) => {
  const { rows } = await query(
    `SELECT b.id, b.status, b.kind, b.created_at, b.effective_date, b.summary, v.name AS vendor, d.filename, d.subject, d.source,
       count(i.id) AS items, count(i.id) FILTER (WHERE i.decision = 'pending') AS pending,
       count(i.id) FILTER (WHERE cardinality(i.flags) > 0 AND i.decision = 'pending') AS flagged
     FROM price_batches b LEFT JOIN vendors v ON v.id = b.vendor_id LEFT JOIN price_documents d ON d.id = b.document_id
     LEFT JOIN price_batch_items i ON i.batch_id = b.id
     GROUP BY b.id, v.name, d.filename, d.subject, d.source ORDER BY b.created_at DESC LIMIT 100`);
  res.json(rows);
});

r.get('/batches/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [b] } = await query(
    `SELECT b.*, v.name AS vendor, v.price_prefix, d.filename, d.subject, d.sender, d.source, d.document_type, d.id AS document_id,
       d.extracted->'price_columns' AS price_columns, d.extracted->>'notes' AS notes
     FROM price_batches b LEFT JOIN vendors v ON v.id = b.vendor_id LEFT JOIN price_documents d ON d.id = b.document_id WHERE b.id = $1`, [id]);
  if (!b) throw new HttpError(404, 'Batch not found');
  const { rows: items } = await query(
    `SELECT i.id, i.product_id, p.sku, p.description, p.description2, p.price_override, i.match_method, i.match_confidence, i.vendor_item_no,
       i.vendor_desc, i.vendor_line->'prices' AS vendor_prices, i.vendor_line->>'pack_qty' AS pack_qty, i.vendor_line->>'uom' AS uom,
       i.old_cost_cents, i.new_cost_cents, i.old_retail_cents, i.new_retail_cents, i.flags, i.decision, i.price_key, i.divisor,
       i.increase_pct, i.applied_at, p.cost_cents AS current_cost_cents, p.retail_cents AS current_retail_cents
     FROM price_batch_items i JOIN products p ON p.id = i.product_id WHERE i.batch_id = $1
     ORDER BY cardinality(i.flags) DESC, abs(i.new_cost_cents - i.old_cost_cents)::float / greatest(i.old_cost_cents, 1) DESC`, [id]);
  // Column families (e.g. Rollex volume tiers) the manager can switch between.
  const keys = (b.price_columns || []).map((c) => c.key);
  const families = [...new Set(keys.filter((k) => k.includes('_')).map((k) => k.slice(0, k.lastIndexOf('_'))))];
  res.json({ ...b, items, families: families.length > 1 ? families : [] });
});

r.post('/batches/:id/decide', async (req, res) => {
  const b = parse(z.object({ item_ids: z.array(z.number().int()).min(1).max(5000), decision: z.enum(['approved', 'rejected', 'not_a_match']) }), req.body);
  res.json(await tx((db) => decideItems(db, Number(req.params.id), b.item_ids, b.decision, req.user)));
});

r.post('/batches/:id/column', async (req, res) => {
  const b = parse(z.object({ from: z.string().min(1).max(30), to: z.string().min(1).max(30) }), req.body);
  res.json({ changed: await tx((db) => changeBatchColumn(db, Number(req.params.id), b.from, b.to, req.user.id)) });
});

r.get('/documents', async (_req, res) => {
  const { rows } = await query(
    `SELECT d.id, d.source, d.sender, d.subject, d.filename, d.received_at, d.document_type, d.effective_date, d.status, d.error,
       v.name AS vendor, (SELECT id FROM price_batches b WHERE b.document_id = d.id ORDER BY id DESC LIMIT 1) AS batch_id,
       jsonb_array_length(COALESCE(d.extracted->'items', '[]'::jsonb)) AS lines
     FROM price_documents d LEFT JOIN vendors v ON v.id = d.vendor_id ORDER BY d.received_at DESC LIMIT 100`);
  res.json(rows);
});

r.get('/documents/:id/file', async (req, res) => {
  const { rows: [d] } = await query('SELECT filename, mime_type, file_data FROM price_documents WHERE id = $1', [Number(req.params.id)]);
  if (!d?.file_data) throw new HttpError(404, 'No file stored for this document');
  res.set('Content-Type', d.mime_type || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${(d.filename || 'document').replace(/"/g, '')}"`);
  res.send(d.file_data);
});

r.post('/documents/:id/retry', async (req, res) => {
  const id = Number(req.params.id);
  await query(`UPDATE price_documents SET status = 'received', error = NULL,
    extracted = CASE WHEN extracted ? 'items' THEN NULL ELSE extracted END WHERE id = $1`, [id]);
  enqueue(id);
  res.json({ ok: true });
});

r.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  if (!/\.(pdf|xlsx|csv|tsv|png|jpe?g)$/i.test(req.file.originalname)) throw new HttpError(400, 'Upload a PDF, Excel (.xlsx), CSV or photo');
  const id = await receiveDocument({
    source: 'upload', buffer: req.file.buffer, filename: req.file.originalname, mimeType: req.file.mimetype,
    subject: req.body?.note || null, userId: req.user.id,
  });
  res.status(202).json({ documentId: id });
});

// A vendor announced "+6% on vinyl siding" without a sheet: enter it by hand.
r.post('/notice', async (req, res) => {
  const b = parse(z.object({
    vendor_name: z.string().trim().min(1).max(80),
    product_line: z.string().trim().max(200).default(''),
    pct: z.number().min(-50).max(100),
    effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  }), req.body);
  const extracted = {
    vendor_name: b.vendor_name, document_type: 'increase_notice', effective_date: b.effective_date || null, price_columns: [], items: [],
    increases: [{ product_line: b.product_line, pct: b.pct, effective_date: b.effective_date || null }], notes: 'Entered by hand',
  };
  const { rows: [d] } = await query(
    `INSERT INTO price_documents (source, subject, filename, extracted, status, created_by) VALUES ('upload', $1, '(entered by hand)', $2, 'extracted', $3) RETURNING id`,
    [`${b.vendor_name} ${b.pct}% ${b.product_line}`, extracted, req.user.id]);
  enqueue(d.id);
  res.status(202).json({ documentId: d.id });
});

r.post('/check-inbox', async (_req, res) => {
  if (!config.imapUser || !config.imapPassword) throw new HttpError(400, 'The price inbox is not set up yet (PRICE_INBOX_USER / PRICE_INBOX_APP_PASSWORD)');
  res.json({ queued: await checkInbox() });
});

export default r;
