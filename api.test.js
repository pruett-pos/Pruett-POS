import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, startServer, client, pool, query } from './helpers.js';

let srv;
let admin;
let cashier;
let base;
const ids = {};

before(async () => {
  await freshDb();
  srv = await startServer();
  base = srv.base;
  admin = client(base);
  await admin.login('admin', 'admin-password-123');
});
after(async () => {
  srv.server.close();
  await pool.end();
});

test('auth: bad login rejected, roles enforced', async () => {
  const anon = client(base);
  assert.equal((await anon.get('/api/products', { raw: true })).status, 401);
  assert.equal((await anon.login('admin', 'wrong').catch((e) => e)).status, 401);
  await admin.post('/api/admin/users', { username: 'kim', name: 'Kim Cashier', role: 'cashier', password: '1234' });
  await admin.post('/api/admin/users', { username: 'mgr', name: 'Store Manager', role: 'manager', password: 'manager-pass-1' });
  const weak = await admin.post('/api/admin/users', { username: 'm2', name: 'X', role: 'manager', password: 'short' }, { raw: true });
  assert.equal(weak.status, 400);
  cashier = client(base);
  await cashier.login('kim', '1234');
  const denied = await cashier.post('/api/admin/categories', { name: 'X', margin_pct: 10 }, { raw: true });
  assert.equal(denied.status, 403);
});

test('catalog: retail calculated from category margin; margin change reprices', async () => {
  const cats = await admin.get('/api/admin/categories');
  const lumber = cats.find((c) => c.name === 'Lumber & Sheet Goods');
  ids.lumber = lumber.id;
  const p = await admin.post('/api/products', { sku: '2X4-8', upc: '0001', description: '2x4x8 SPF', category_id: lumber.id, cost_cents: 389, on_hand: 100 });
  assert.equal(p.retail_cents, 520); // 25% margin
  ids.stud = p.id;
  const o = await admin.post('/api/products', { sku: 'HAMMER', description: 'Hammer', cost_cents: 1000, price_override: true, retail_cents: 1999, on_hand: 5 });
  assert.equal(o.retail_cents, 1999);
  ids.hammer = o.id;

  const preview = await admin.put(`/api/admin/categories/${lumber.id}`, { name: lumber.name, margin_pct: 30 });
  assert.equal(preview.preview, true);
  assert.equal(preview.changes[0].new_retail_cents, 555); // 389/0.7 = 5.557 -> 5.55
  assert.equal((await admin.get(`/api/products/${ids.stud}`)).retail_cents, 520, 'preview must not change price');
  const applied = await admin.put(`/api/admin/categories/${lumber.id}`, { name: lumber.name, margin_pct: 30, apply: true });
  assert.equal(applied.changeCount, 1);
  const after = await admin.get(`/api/products/${ids.stud}`);
  assert.equal(after.retail_cents, 555);
  assert.equal(after.history[0].source, 'category_margin');
  // Cost change recalculates
  const upd = await admin.put(`/api/products/${ids.stud}`, { cost_cents: 420 });
  assert.equal(upd.retail_cents, 600);
  // Lookup by UPC
  assert.equal((await cashier.get('/api/products/lookup/0001')).id, ids.stud);
});

test('sale: cash with change, contractor pricing, tax, inventory', async () => {
  const levels = await admin.get('/api/admin/price-levels');
  const plan = levels.find((l) => l.name === 'CONTRACTOR');
  assert.equal(plan.pct, 7, 'Pruett contractor plan is 7% off');
  await admin.put(`/api/admin/price-levels/${plan.id}`, { name: 'CONTRACTOR', kind: 'discount', pct: null });
  // A cashier can't put someone on contractor pricing
  const denied = await cashier.post('/api/customers', { name: 'Sneaky', price_level_id: plan.id }, { raw: true });
  assert.equal(denied.status, 403);
  const contractor = await admin.post('/api/customers', { name: 'Bob Builder', price_level_id: plan.id, charge_account: true, credit_limit_cents: 10000 });
  ids.contractor = contractor.id;
  // Plan % not set yet -> retail price, flagged
  const unset = await cashier.post('/api/sales/price', { customer_id: contractor.id, lines: [{ product_id: ids.stud, qty: 1 }] });
  assert.equal(unset.lines[0].unitPriceCents, 600);
  assert.equal(unset.levelNotSet, true);
  await admin.put(`/api/admin/price-levels/${plan.id}`, { name: 'CONTRACTOR', kind: 'discount', pct: 10 });
  const priced = await cashier.post('/api/sales/price', { customer_id: contractor.id, lines: [{ product_id: ids.stud, qty: 10 }] });
  assert.equal(priced.lines[0].unitPriceCents, 540); // 600 - 10% = 540
  assert.equal(priced.totalCents, 5400 + 459);

  const sale = await cashier.post('/api/sales', {
    lines: [{ product_id: ids.stud, qty: 2 }, { product_id: null, description: 'Key cut', qty: 1, unit_price_cents: 300, taxable: true }],
    payments: [{ method: 'cash', amount_cents: 1628, tendered_cents: 2000 }],
  });
  assert.equal(sale.total_cents, 1628);
  assert.equal(sale.payments[0].change_cents, 372);
  assert.equal((await admin.get(`/api/products/${ids.stud}`)).on_hand, 98);
  ids.cashSale = sale;

  const bad = await cashier.post('/api/sales', { lines: [{ product_id: ids.stud, qty: 1 }], payments: [{ method: 'cash', amount_cents: 1 }] }, { raw: true });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /do not equal/);
});

test('sale: price override requires manager approval', async () => {
  const body = { lines: [{ product_id: ids.hammer, qty: 1, unit_price_cents: 1500 }], payments: [{ method: 'cash', amount_cents: 1628 }] };
  const denied = await cashier.post('/api/sales', body, { raw: true });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.needsApproval, true);
  const wrong = await cashier.post('/api/auth/approve', { username: 'kim', password: '1234' }, { raw: true });
  assert.equal(wrong.status, 403);
  const { token } = await cashier.post('/api/auth/approve', { username: 'mgr', password: 'manager-pass-1' });
  const sale = await cashier.post('/api/sales', { ...body, approval_token: token });
  assert.equal(sale.lines[0].unit_price_cents, 1500);
  assert.ok(sale.lines[0].price_overridden_by);
  // token is single use
  assert.equal((await cashier.post('/api/sales', { ...body, approval_token: token }, { raw: true })).status, 403);
});

test('sale: charge account respects credit limit', async () => {
  const total = 5400 + 459;
  const ok = await cashier.post('/api/sales', { customer_id: ids.contractor, po_number: 'JOB-17', lines: [{ product_id: ids.stud, qty: 10 }], payments: [{ method: 'charge', amount_cents: total }] });
  assert.equal(ok.tier, 'CONTRACTOR');
  assert.equal(ok.qbo_sync_status, 'pending');
  const c = await admin.get(`/api/customers/${ids.contractor}`);
  assert.equal(c.balance_cents, total);
  const over = await cashier.post('/api/sales', { customer_id: ids.contractor, lines: [{ product_id: ids.stud, qty: 10 }], payments: [{ method: 'charge', amount_cents: total }] }, { raw: true });
  assert.equal(over.status, 403);
  assert.match(over.data.error, /credit limit/);
  const walkin = await cashier.post('/api/sales', { lines: [{ product_id: ids.stud, qty: 1 }], payments: [{ method: 'charge', amount_cents: 651 }] }, { raw: true });
  assert.equal(walkin.status, 400);
});

test('sale: card payment via (simulated) reader, split with cash, then partial return to card', async () => {
  const readers = await cashier.get('/api/sales/card/readers');
  assert.equal(readers.mode, 'simulated');
  // 3 hammers = 59.97 + 8.5% (5.10) = 65.07 ; pay 40 card + 25.07 cash
  const start = await cashier.post('/api/sales/card/start', { amount_cents: 4000, reader_id: readers.readers[0].id });
  const st = await cashier.get(`/api/sales/card/${start.payment_intent_id}`);
  assert.equal(st.status, 'approved');
  const sale = await cashier.post('/api/sales', {
    lines: [{ product_id: ids.hammer, qty: 3 }],
    payments: [{ method: 'card', amount_cents: 4000, payment_intent_id: start.payment_intent_id }, { method: 'cash', amount_cents: 2507 }],
  });
  assert.equal(sale.total_cents, 6507);
  assert.equal(sale.payments.find((p) => p.method === 'card').card_last4, '4242');
  // card payment cannot be reused
  const reuse = await cashier.post('/api/sales', { lines: [{ product_id: ids.hammer, qty: 2 }], payments: [{ method: 'card', amount_cents: 4000, payment_intent_id: start.payment_intent_id }, { method: 'cash', amount_cents: 338 }] }, { raw: true });
  assert.equal(reuse.status, 409);

  // Return 1 hammer to the card: 19.99 + 1.70 tax = 21.69
  const ret = await cashier.post('/api/sales/returns', { original_sale_id: sale.id, lines: [{ original_line_id: sale.lines[0].id, qty: 1 }], refund_method: 'card' });
  assert.equal(ret.total_cents, -2169);
  assert.equal(ret.payments[0].amount_cents, -2169);
  assert.ok(ret.payments[0].stripe_refund);
  const orig = await cashier.get(`/api/sales/${sale.id}`);
  assert.equal(orig.lines[0].returned_qty, 1);
  // Only 2 left to return
  const tooMany = await cashier.post('/api/sales/returns', { original_sale_id: sale.id, lines: [{ original_line_id: sale.lines[0].id, qty: 3 }], refund_method: 'cash' }, { raw: true });
  assert.equal(tooMany.status, 400);
  // Card can only take back what's left on it (40.00 - 21.69 = 18.31); 2 hammers = 43.38
  const overCard = await cashier.post('/api/sales/returns', { original_sale_id: sale.id, lines: [{ original_line_id: sale.lines[0].id, qty: 2 }], refund_method: 'card' }, { raw: true });
  assert.equal(overCard.status, 400);
  // "Same as paid": 2 hammers = 43.38 -> 18.31 back to the card, 25.07 cash
  const orig2 = await cashier.post('/api/sales/returns', { original_sale_id: sale.id, lines: [{ original_line_id: sale.lines[0].id, qty: 2 }], refund_method: 'original' });
  assert.equal(orig2.total_cents, -4338);
  const cardBack = orig2.payments.find((p) => p.method === 'card');
  const cashBack = orig2.payments.find((p) => p.method === 'cash');
  assert.equal(cardBack.amount_cents, -1831);
  assert.equal(cashBack.amount_cents, -2507);
  // Sales with returns can't be voided
  const { token } = await cashier.post('/api/auth/approve', { username: 'mgr', password: 'manager-pass-1' });
  assert.equal((await cashier.post(`/api/sales/${sale.id}/void`, { approval_token: token }, { raw: true })).status, 400);
});

test('void: reverses inventory and needs a manager', async () => {
  const before = (await admin.get(`/api/products/${ids.stud}`)).on_hand;
  const s = ids.cashSale;
  assert.equal((await cashier.post(`/api/sales/${s.id}/void`, {}, { raw: true })).status, 403);
  const voided = await admin.post(`/api/sales/${s.id}/void`, { reason: 'test' });
  assert.equal(voided.status, 'voided');
  assert.equal((await admin.get(`/api/products/${ids.stud}`)).on_hand, before + 2);
});

test('return without receipt needs manager; restocks', async () => {
  const before = (await admin.get(`/api/products/${ids.stud}`)).on_hand;
  const body = { lines: [{ product_id: ids.stud, qty: 1 }], refund_method: 'cash' };
  assert.equal((await cashier.post('/api/sales/returns', body, { raw: true })).status, 403);
  const { token } = await cashier.post('/api/auth/approve', { username: 'mgr', password: 'manager-pass-1' });
  const r = await cashier.post('/api/sales/returns', { ...body, approval_token: token });
  assert.equal(r.total_cents, -(600 + 51));
  assert.equal((await admin.get(`/api/products/${ids.stud}`)).on_hand, before + 1);
});

test('day summary', async () => {
  const s = await cashier.get('/api/sales/summary/day');
  assert.ok(s.totals.sales >= 3);
  assert.ok(s.tenders.find((t) => t.method === 'card'));
});

test('tax rate must be set before selling', async () => {
  await query(`DELETE FROM settings WHERE key = 'tax_rate_pct'`);
  const r = await cashier.post('/api/sales', { lines: [{ product_id: ids.stud, qty: 1 }], payments: [{ method: 'cash', amount_cents: 600 }] }, { raw: true });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /tax rate/i);
  await admin.put('/api/admin/settings', { tax_rate_pct: 8.5 });
});

test('Paladin import: auto-map, preview, commit, re-import updates', async () => {
  const csv = [
    'Part Number,Description,Dept,Vendor,Vendor Part Number,UPC,Repl Cost,Retail,QOH,Min,Max,UOM',
    'PAL-1,"Joist Hanger 2x6",Hardware,Simpson,LUS26,0712345,"$1.10",2.49,140,20,200,EA',
    'PAL-2,Treated 2x6x12,Lumber & Sheet Goods,Mill,T2612,,14.20,19.99,60,10,80,EA',
    'PAL-3,,Hardware,Simpson,X,,1.00,2.00,1,,,EA',
    '2X4-8,2x4x8 SPF Stud,Lumber & Sheet Goods,Mill,S248,0001,4.50,6.49,999,,,EA',
    'PAL-4,Mystery Item,New Dept,,,,5.00,,3,,,EA',
  ].join('\n');
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'paladin_export.csv');
  const staged = await admin.post('/api/products/import/upload', fd);
  assert.equal(staged.rowCount, 5);
  assert.equal(staged.mapping.sku, 0);
  assert.equal(staged.mapping.description, 1);
  assert.equal(staged.mapping.category, 2);
  assert.equal(staged.mapping.vendor_sku, 4);
  assert.equal(staged.mapping.upc, 5);
  assert.equal(staged.mapping.cost, 6);
  assert.equal(staged.mapping.retail, 7);
  assert.equal(staged.mapping.on_hand, 8);
  assert.equal(staged.mapping.reorder_point, 9);
  assert.equal(staged.mapping.max_qty, 10);

  const preview = await admin.post('/api/products/import/preview', { importId: staged.importId, mapping: staged.mapping });
  assert.equal(preview.created, 3);
  assert.equal(preview.updated, 1);
  assert.equal(preview.errors.length, 1);
  assert.deepEqual(preview.newCategories, ['New Dept']);
  assert.ok(preview.priceImpact.length > 0);
  assert.equal((await query(`SELECT count(*) AS n FROM products WHERE sku LIKE 'PAL-%'`)).rows[0].n, 0, 'preview must not write');

  const res = await admin.post('/api/products/import/commit', { importId: staged.importId, mapping: staged.mapping, options: { priceMode: 'margin' } });
  assert.equal(res.created, 3);
  const { items } = await admin.get('/api/products?q=PAL-1');
  const hanger = items[0];
  assert.equal(hanger.cost_cents, 110);
  assert.equal(hanger.retail_cents, 200); // 1.10 / (1 - .45) = 2.00
  assert.equal(hanger.vendor, 'Simpson');
  assert.equal(hanger.reorder_point, 20);
  assert.equal(hanger.reorder_qty, 180);
  assert.equal(hanger.on_hand, 140);
  const stud = await admin.get(`/api/products/${ids.stud}`);
  assert.equal(stud.cost_cents, 450);
  assert.notEqual(stud.on_hand, 999, 'existing on-hand not overwritten by default');
  const mystery = (await admin.get('/api/products?q=PAL-4')).items[0];
  assert.equal(mystery.category, 'New Dept');
  assert.equal(mystery.retail_cents, 770); // default 35% margin: 5/.65 = 7.69 -> 7.70
});

test('Paladin import from .xlsx with keep-prices mode', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Items');
  ws.addRow(['Inventory Report']);
  ws.addRow([]);
  ws.addRow(['Item Number', 'Item Description', 'Department', 'Avg Cost', 'Price', 'On Hand']);
  ws.addRow(['XL-1', 'Shop Vac', 'Tools', 50, 89.99, 4]);
  const buf = await wb.xlsx.writeBuffer();
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'items.xlsx');
  const staged = await admin.post('/api/products/import/upload', fd);
  assert.deepEqual(staged.headers.slice(0, 3), ['Item Number', 'Item Description', 'Department']);
  assert.equal(staged.mapping.sku, 0);
  assert.equal(staged.mapping.description, 1);
  await admin.post('/api/products/import/commit', { importId: staged.importId, mapping: staged.mapping, options: { priceMode: 'keep' } });
  const p = (await admin.get('/api/products?q=XL-1')).items[0];
  assert.equal(p.retail_cents, 8999);
  assert.equal(p.price_override, false);
  assert.ok(Math.abs(p.target_margin_pct - 44.438) < 0.01);
});

test('price levels: cost-plus plan and require-PO customers', async () => {
  const levels = await admin.get('/api/admin/price-levels');
  const cost = levels.find((l) => l.name === 'Pruett');
  assert.ok(!levels.find((l) => l.name === 'COST'), 'COST merged into Pruett');
  const c = await admin.post('/api/customers', { name: 'Employee', price_level_id: cost.id, require_po: true, checkout_note: 'Get OK from Tyler' });
  const priced = await cashier.post('/api/sales/price', { customer_id: c.id, lines: [{ product_id: ids.stud, qty: 1 }] });
  assert.equal(priced.lines[0].unitPriceCents, 450); // cost 4.50 + 0%
  const noPo = await cashier.post('/api/sales', { customer_id: c.id, lines: [{ product_id: ids.stud, qty: 1 }], payments: [{ method: 'cash', amount_cents: 488 }] }, { raw: true });
  assert.equal(noPo.status, 400);
  assert.match(noPo.data.error, /requires a PO/);
  const ok = await cashier.post('/api/sales', { customer_id: c.id, po_number: 'P1', lines: [{ product_id: ids.stud, qty: 1 }], payments: [{ method: 'cash', amount_cents: 488 }] });
  assert.equal(ok.tier, 'Pruett');
});

test('keep-prices import: item keeps exact price, its margin becomes the target, bad rows go to review', async () => {
  const csv = [
    'PART NUMBER,PRIMARY ALTERNATE,DESCRIPTION 1,DESCRIPTION 2,LOCATION NAME,PRICE 1,MARGIN ACTUAL,ORDER QUANTITY,MIN STOCK,MAX STOCK,AVG COST,LAST COST,SOH',
    '0570,,5" E-Z STEP-DOWN SCREEN,,None,4.89,46,1,0,999,2.64,2.64,873',
    '098342008945,S103,5LB SDNG NAIL 1-1/2,5LB SIDING NAILS,None,28.59,30,1,0,999,20,20,30',
    'HANGFAST,,6IN HANGFAST,,None,2.83,-1,1,0,999,988,988,5',
    'NOPRICE,,FREIGHT,,None,0,0,1,0,999,0,0,0',
    'NEG,,NEGATIVE STOCK,,None,10,50,1,5,20,5,5,-3',
  ].join('\n');
  const fd = new FormData();
  fd.append('file', new Blob([csv]), 'inventoryforupload.csv');
  const staged = await admin.post('/api/products/import/upload', fd);
  for (const [k, col] of Object.entries({ sku: 0, alt_code: 1, description: 2, description2: 3, retail: 5, cost: 10, on_hand: 12, reorder_point: 8, max_qty: 9 })) {
    assert.equal(staged.mapping[k], col, k);
  }
  const res = await admin.post('/api/products/import/commit', { importId: staged.importId, mapping: staged.mapping, options: { priceMode: 'keep' } });
  assert.equal(res.created, 5);
  assert.deepEqual(res.review.map((r) => r.reason).sort(), ['No price', 'Price below cost']);
  const screen = (await admin.get('/api/products?q=0570')).items[0];
  assert.equal(screen.retail_cents, 489, 'exact price kept (not rounded to 4.90)');
  assert.equal(screen.price_override, false);
  assert.ok(Math.abs(screen.target_margin_pct - 46.012) < 0.01);
  assert.equal(screen.reorder_point, null, 'min 0 / max 999 means no reorder settings');
  // Editing the description does not move the price
  await admin.put(`/api/products/${screen.id}`, { description: '5in EZ step-down screen' });
  assert.equal((await admin.get(`/api/products/${screen.id}`)).retail_cents, 489);
  // A cost change re-prices at the item's own margin: 3.00 / (1 - .46012) = 5.557 -> 5.55
  assert.equal((await admin.put(`/api/products/${screen.id}`, { cost_cents: 300 })).retail_cents, 555);
  // Alternate part number scans
  assert.equal((await cashier.get('/api/products/lookup/S103')).sku, '098342008945');
  const nails = (await admin.get('/api/products?q=SIDING NAILS')).items[0];
  assert.equal(nails.description2, '5LB SIDING NAILS');
  const review = await admin.get('/api/products?needs_review=1');
  assert.deepEqual(review.items.map((p) => p.sku).sort(), ['HANGFAST', 'NOPRICE']);
  const hang = review.items.find((p) => p.sku === 'HANGFAST');
  assert.equal(hang.retail_cents, 283);
  assert.equal(hang.price_override, true);
  const noPrice = review.items.find((p) => p.sku === 'NOPRICE');
  const zero = await cashier.post('/api/sales', { lines: [{ product_id: noPrice.id, qty: 1 }], payments: [{ method: 'cash', amount_cents: 0 }] }, { raw: true });
  assert.equal(zero.status, 400);
  assert.match(zero.data.error, /has no price/);
  const neg = (await admin.get('/api/products?q=NEG')).items[0];
  assert.equal(neg.on_hand, -3);
  assert.equal(neg.reorder_point, 5);
  assert.equal(neg.reorder_qty, 15);
});

test('Paladin customer import', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const H = ['Deleted', 'Id', 'Name', 'ContactAddress1', 'ContactAddress2', 'ContactCity', 'ContactState', 'ContactZip', 'Phone', 'CellPhone', 'Email',
    'EmailStatements', 'CheckoutNote', 'CreditLimit', 'SinceLastStatement', 'StatementCurrent', 'StatementPastdue1', 'StatementPastdue2', 'StatementPastdue3',
    'RequirePO', 'FirstName', 'LastName', 'PricingPlan1', 'State Tax', 'Customer Type'];
  ws.addRow(H);
  ws.addRow([false, 3388407, 'K T ROOFING', '414 ST. JOHN', '', 'Thayer', 'MO', '65791', '4172563016', '          ', 'ktroofing@gmail.com', true, '', 3000, 0, 2678.07, 13.83, 0, 0, false, '', '', 'CONTRACTOR', 'Default', 'Other Contractor']);
  ws.addRow([false, 3382551, 'RETAIL', '', '', '', '  ', '', '', '', '', false, '', 0, 0, 0, 0, 0, 0, false, '', '', '', 'Default', 'None']);
  ws.addRow([true, 3399999, 'SKYRIDGE', '', '', '', '', '', '', '', '', false, '', 0, 0, 0, 0, 0, 0, false, '', '', '', 'Default', 'None']);
  ws.addRow([false, 3390001, 'COVER LUMBER CO', '', '', 'WEST PLAINS ', 'MO', '65775', '', '4172477454', '', false, 'MAKE SURE TO GET AN OK', 25000, 0, 0, 0, 0, 0, true, 'Glen', 'Allen', 'Wholesale', 'wholesale', 'Other Business']);
  ws.addRow([false, 3390003, 'COST PLAN GUY', '', '', '', '', '', '', '', '', false, '', 0, 0, 0, 0, 0, 0, false, '', '', 'COST', 'Default', 'Employee']);
  ws.addRow([false, 3390002, 'NEW PLAN GUY', '', '', '', '', '', '', '', '', false, '', 0, 0, 0, 0, 0, 0, false, '', '', 'Platinum', 'Default', 'None']);
  const fd = new FormData();
  fd.append('file', new Blob([await wb.xlsx.writeBuffer()]), 'customer list.xlsx');
  const up = await admin.post('/api/customers/import/upload', fd);
  assert.equal(up.preview.created, 4);
  assert.equal(up.preview.skipped.length, 2);
  assert.deepEqual(up.preview.newPlans, ['Platinum']);
  assert.equal(up.preview.openBalanceTotal, 269190);
  const done = await admin.post('/api/customers/import/commit', { importId: up.importId });
  assert.equal(done.created, 4);
  assert.equal((await admin.get('/api/customers?q=COST PLAN'))[0].level_name, 'Pruett');
  const kt = (await admin.get('/api/customers?q=K T ROOFING'))[0];
  assert.equal(kt.phone, '(417) 256-3016');
  assert.equal(kt.address, '414 ST. JOHN, Thayer, MO 65791');
  assert.equal(kt.level_name, 'CONTRACTOR');
  assert.equal(kt.charge_account, true);
  assert.equal(kt.credit_limit_cents, 300000);
  assert.equal(kt.balance_cents, 0, 'balances come over at cutover');
  assert.equal(kt.email_statements, true);
  const cover = (await admin.get('/api/customers?q=COVER'))[0];
  assert.equal(cover.tax_exempt, true);
  assert.equal(cover.require_po, true);
  assert.equal(cover.phone, '(417) 247-7454');
  assert.equal(cover.checkout_note, 'MAKE SURE TO GET AN OK');
  assert.match(cover.notes, /Contact: Glen Allen/);
  // Re-import updates, doesn't duplicate
  const fd2 = new FormData();
  fd2.append('file', new Blob([await wb.xlsx.writeBuffer()]), 'customer list.xlsx');
  const up2 = await admin.post('/api/customers/import/upload', fd2);
  assert.equal(up2.preview.created, 0);
  assert.equal(up2.preview.updated, 4);
});
