// End-to-end price agent: upload -> (fake) Claude extraction -> match -> batch -> approve -> prices change.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshDb, startServer, client, pool, query } from './helpers.js';
import { setClaudeClient } from '../src/services/priceAgent/extract.js';
import { queueIdle } from '../src/services/priceAgent/intake.js';
import { tx } from '../src/db.js';
import { applyDueChanges } from '../src/services/priceAgent/batches.js';

const fixture = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/price-sheets/${n}`, import.meta.url)));

// Fake Claude: the "PDF" bytes name the fixture to return; verification rejects pairs whose descriptions share no words.
let nextDoc = null;
const calls = { extract: 0, verify: 0 };
setClaudeClient({
  messages: {
    stream: () => ({ finalMessage: async () => { calls.extract++; return { stop_reason: 'tool_use', content: [{ type: 'tool_use', input: nextDoc }] }; } }),
    create: async ({ messages }) => {
      calls.verify++;
      const pairs = JSON.parse(messages[0].content.split('\n\n')[0]);
      const verdicts = pairs.map((p) => ({ id: p.id, same: !/TILE|SCREW|UNDERSILL/.test(p.pruett.description), divisor: null, reason: 'test' }));
      return { content: [{ type: 'tool_use', input: { verdicts } }] };
    },
  },
});

let srv;
let admin;
const ids = {};

async function uploadFixture(name, filename = 'sheet.pdf') {
  nextDoc = fixture(name);
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(`%PDF fake ${name}`)], { type: 'application/pdf' }), filename);
  const { documentId } = await admin.post('/api/prices/upload', fd);
  await queueIdle();
  const docs = await admin.get('/api/prices/documents');
  const d = docs.find((x) => x.id === documentId);
  assert.notEqual(d.status, 'failed', d.error);
  return d;
}

before(async () => {
  await freshDb();
  srv = await startServer();
  admin = client(srv.base);
  await admin.login('admin', 'admin-password-123');
  const mk = async (sku, description, cost, extra = {}) => {
    const p = await admin.post('/api/products', { sku, description, cost_cents: Math.round(cost * 100), ...extra });
    ids[sku] = p.id;
    return p;
  };
  await mk('20 BL', "DSPTS 2X3 10' BLACK", 10.26, { target_margin_pct: 45.45 });
  await mk('20 AL', "DSPTS 2X3 10'  ALMOND", 13.39);
  await mk('07', "4X5 10/6' DSPT", 55.44);
  await mk('23 TILE ADPT', '2X3 TILE ADAPTER BLACK', 4.28);
  await mk('A-SYS312L-9', 'SYSTEM 3-12 LANCED BRONZE', 21.50);
  await mk('40110', 'AMERICAN LEGEND D4 WG', 112.14);
  await mk('SIDING-X', 'VINYL SIDING D4 WHITE', 100.00);
});
after(async () => {
  srv.server.close();
  await pool.end();
});

test('status reports what is configured', async () => {
  const s = await admin.get('/api/prices/status');
  assert.equal(s.aiConfigured, true);
  assert.equal(s.inboxConfigured, false);
});

test('Lynch sheet: batch with flagged items, doubtful match removed by verification, approve applies prices', async () => {
  const d = await uploadFixture('lynch-preferred-2026-06.json', 'Preferred.pdf');
  assert.equal(d.vendor, 'Lynch Aluminum Mfg. Co.');
  const batch = await admin.get(`/api/prices/batches/${d.batch_id}`);
  assert.equal(batch.status, 'pending');
  const by = Object.fromEntries(batch.items.map((i) => [i.sku, i]));
  assert.equal(by['20 BL'].new_cost_cents, 1433);
  assert.equal(by['20 BL'].new_retail_cents, 2625);            // 14.33 / (1 - .4545) = 26.27 -> 26.25
  assert.ok(by['20 BL'].flags.includes('large_change'));
  assert.ok(!by['23 TILE ADPT'], 'verification dropped the wrong match');
  assert.ok(!by['07'], 'unchanged items are not in the batch');
  assert.ok(calls.verify >= 1);
  assert.ok(batch.summary.dropped_by_check >= 1);
  assert.ok(batch.items.every((i) => !i.flags.includes('check_match') || !i.flags.includes('ai_verified')));

  // Nothing changes until approval
  assert.equal((await admin.get(`/api/products/${ids['20 BL']}`)).cost_cents, 1026);
  const res = await admin.post(`/api/prices/batches/${batch.id}/decide`, { item_ids: [by['20 BL'].id], decision: 'approved' });
  assert.equal(res.applied, 1);
  assert.equal(res.status, 'partially_approved');
  const p = await admin.get(`/api/products/${ids['20 BL']}`);
  assert.equal(p.cost_cents, 1433);
  assert.equal(p.retail_cents, 2625);
  assert.equal(p.vendor, 'Lynch Aluminum Mfg. Co.');
  assert.equal(p.vendor_sku, '20');
  assert.equal(p.history[0].source, 'price_agent');
  // Reject the rest
  const rest = batch.items.filter((i) => i.sku !== '20 BL').map((i) => i.id);
  const r2 = await admin.post(`/api/prices/batches/${batch.id}/decide`, { item_ids: rest, decision: 'rejected' });
  assert.equal(r2.status, 'partially_approved');
  assert.equal((await admin.get(`/api/products/${ids['20 AL']}`)).cost_cents, 1339);
});

test('same sheet again: learned link, nothing left to change for the approved item', async () => {
  const d = await uploadFixture('lynch-preferred-2026-06.json', 'Preferred-again.pdf');
  const batch = await admin.get(`/api/prices/batches/${d.batch_id}`);
  assert.ok(!batch.items.find((i) => i.sku === '20 BL'));
});

test('not a match is remembered', async () => {
  const d = await uploadFixture('lynch-preferred-2026-06.json', 'Preferred-3.pdf');
  const batch = await admin.get(`/api/prices/batches/${d.batch_id}`);
  const al = batch.items.find((i) => i.sku === '20 AL');
  await admin.post(`/api/prices/batches/${batch.id}/decide`, { item_ids: [al.id], decision: 'not_a_match' });
  const d2 = await uploadFixture('lynch-preferred-2026-06.json', 'Preferred-4.pdf');
  const b2 = await admin.get(`/api/prices/batches/${d2.batch_id}`);
  assert.ok(!b2.items.find((i) => i.sku === '20 AL'));
});

test('Rollex: switch the batch to another volume tier and the vendor remembers it', async () => {
  const d = await uploadFixture('rollex-2026-04.json', 'Rollex.pdf');
  const batch = await admin.get(`/api/prices/batches/${d.batch_id}`);
  const soffit = batch.items.find((i) => i.sku === 'A-SYS312L-9');
  assert.ok([2129, 2163, 2212, 2232].includes(soffit.new_cost_cents), String(soffit.new_cost_cents));
  assert.ok(batch.families.includes('20k') && batch.families.includes('2_5k'));
  const fam = soffit.price_key.slice(0, soffit.price_key.lastIndexOf('_'));
  const { changed } = await admin.post(`/api/prices/batches/${batch.id}/column`, { from: fam, to: fam === '2_5k' ? '20k' : '2_5k' });
  assert.ok(changed >= 1);
  const target = fam === '2_5k' ? '20k' : '2_5k';
  const after2 = await admin.get(`/api/prices/batches/${batch.id}`);
  assert.equal(after2.items.find((i) => i.sku === 'A-SYS312L-9').new_cost_cents, target === '20k' ? 2129 : 2232);
  assert.equal(after2.price_prefix, target);
});

test('old CertainTeed sheet is flagged as old', async () => {
  const d = await uploadFixture('certainteed-vinyl-2025-01.json', 'TS16300.pdf');
  const batch = await admin.get(`/api/prices/batches/${d.batch_id}`);
  const al = batch.items.find((i) => i.sku === '40110');
  assert.equal(al.new_cost_cents, 9838);
  assert.ok(al.flags.includes('old_sheet'));
  assert.equal(batch.summary.old_sheet, true);
});

test('% increase notice with a future effective date is scheduled, then applied on the date', async () => {
  // Tie the siding item to Alside first.
  const { rows: [v] } = await query(`INSERT INTO vendors (name) VALUES ('Alside') RETURNING id`);
  await query('UPDATE products SET vendor_id = $1 WHERE id = $2', [v.id, ids['SIDING-X']]);
  const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const { documentId } = await admin.post('/api/prices/notice', { vendor_name: 'Alside', product_line: 'Vinyl Siding, Soffit, and Accessories', pct: 6, effective_date: future });
  await queueIdle();
  const docs = await admin.get('/api/prices/documents');
  const batch = await admin.get(`/api/prices/batches/${docs.find((x) => x.id === documentId).batch_id}`);
  assert.equal(batch.kind, 'percent');
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0].new_cost_cents, 10600);
  const res = await admin.post(`/api/prices/batches/${batch.id}/decide`, { item_ids: [batch.items[0].id], decision: 'approved' });
  assert.equal(res.applied, 0);
  assert.equal(res.status, 'scheduled');
  assert.equal((await admin.get(`/api/products/${ids['SIDING-X']}`)).cost_cents, 10000);
  await query('UPDATE price_batches SET effective_date = current_date - 1 WHERE id = $1', [batch.id]);
  assert.equal(await tx((db) => applyDueChanges(db)), 1);
  assert.equal((await admin.get(`/api/products/${ids['SIDING-X']}`)).cost_cents, 10600);
  assert.equal((await admin.get(`/api/prices/batches/${batch.id}`)).status, 'approved');
});

test('non-price emails are ignored; cashiers cannot see the price agent', async () => {
  const d = await uploadFixture('lynch-preferred-2026-06.json', 'x.pdf').catch(() => null);
  assert.ok(d);
  nextDoc = { vendor_name: 'Briggs & Stratton', document_type: 'other', price_columns: [], items: [], increases: [] };
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('%PDF statement')], { type: 'application/pdf' }), 'statement.pdf');
  const { documentId } = await admin.post('/api/prices/upload', fd);
  await queueIdle();
  const doc = (await admin.get('/api/prices/documents')).find((x) => x.id === documentId);
  assert.equal(doc.status, 'ignored');
  await admin.post('/api/admin/users', { username: 'cash', name: 'Cash', role: 'cashier', password: '1234' });
  const c = client(srv.base);
  await c.login('cash', '1234');
  assert.equal((await c.get('/api/prices/batches', { raw: true })).status, 403);
});

test('extraction: spreadsheets are sent as text, model output is cleaned up', async () => {
  const { extractDocument } = await import('../src/services/priceAgent/extract.js');
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Prices').addRows([['Item', 'Description', 'Price'], ['A1', 'Widget', 9.5]]);
  let seen = null;
  setClaudeClient({ messages: { stream: (req) => { seen = req; return { finalMessage: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', input: {
    vendor_name: ' Acme ', document_type: 'price_list', effective_date: '6/1/26', price_columns: [{ key: 'price', label: 'Price', unit: 'piece' }],
    items: [{ item_nos: 'A1', description: 'Widget', prices: { price: '$9.50', blank: '' } }], increases: [{ product_line: 'x', pct: 'abc' }],
  } }] }) }; } } });
  const out = await extractDocument({ buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: 'acme.xlsx', mimeType: 'application/vnd.ms-excel' });
  assert.match(seen.messages[0].content[0].text, /A1,Widget,9\.5/);
  assert.equal(out.vendor_name, 'Acme');
  assert.equal(out.effective_date, null);
  assert.deepEqual(out.items[0], { item_nos: ['A1'], description: 'Widget', uom: null, pack_qty: null, prices: { price: 9.5 } });
  assert.equal(out.increases.length, 0);
});
