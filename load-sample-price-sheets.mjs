// Dev/demo helper: load the sample vendor sheets (already-extracted JSON + original PDFs) and build batches,
// exactly as if they had arrived by email. Usage: node scripts/load-sample-price-sheets.mjs [pdf-folder]
import fs from 'node:fs';
import path from 'node:path';
import { query, pool } from '../server/src/db.js';
import { migrate } from '../server/src/migrate.js';
import { processDocument } from '../server/src/services/priceAgent/intake.js';

const fixtures = new URL('../server/test/fixtures/price-sheets/', import.meta.url).pathname;
const pdfDir = process.argv[2];
const PDF = {
  'lynch-preferred-2026-06.json': ['Preferred.pdf', 'lynchaluminumsales@gmail.com', 'Pricing for Accessories (Updated)'],
  'rollex-2026-04.json': ['Rollex Distributor Price List April 2026.pdf', 'Rollex <customerservice@rollex.com>', 'Rollex price list April 2026'],
  'certainteed-vinyl-2025-01.json': ['TS16300_PRUETT HOME IMPROVEMENT-WEST P_20250113-VS.pdf', 'John.M.Stauffer@saint-gobain.com', 'CertainTeed siding price list'],
  'certainteed-metal-2026-04.json': ['TS16300_PRUETT HOME IMPROVEMENT-WEST P_20260401-CT.pdf', 'John.M.Stauffer@saint-gobain.com', 'CertainTeed metal price list'],
  'wausau-order-2025-10.json': ['smartsidebud.pdf', 'sales@wausausupply.com', 'Order Confirmation 1001863769'],
  'wausau-order-2026-02.json': ['lpsmartside.pdf', 'sales@wausausupply.com', 'Order Confirmation 1001954280'],
  'wausau-order-2026-05.json': ['Smartside.pdf', 'sales@wausausupply.com', 'Order Confirmation 1002042330'],
  'alside-increase-2026-08.json': [null, 'marketing@info.alside.com', 'Important: Vinyl & ASCEND Siding Pricing Update'],
};
await migrate({ log: () => {} });
for (const [f, [pdf, sender, subject]] of Object.entries(PDF)) {
  const extracted = JSON.parse(fs.readFileSync(path.join(fixtures, f)));
  let file = null;
  if (pdf && pdfDir) {
    const hit = fs.readdirSync(pdfDir).find((x) => x.replace(/[^a-z0-9]/gi, '').toLowerCase().endsWith(pdf.replace(/[^a-z0-9]/gi, '').toLowerCase()));
    if (hit) file = fs.readFileSync(path.join(pdfDir, hit));
  }
  const { rows: [d] } = await query(
    `INSERT INTO price_documents (source, sender, subject, filename, mime_type, file_data, extracted, status, document_type)
     VALUES ('email', $1, $2, $3, 'application/pdf', $4, $5, 'extracted', $6) RETURNING id`,
    [sender, subject, pdf || '(email body)', file, extracted, extracted.document_type]);
  const r = await processDocument(d.id);
  console.log(`${f}: batch ${r.batchId}`, JSON.stringify(r.summary));
}
await pool.end();
