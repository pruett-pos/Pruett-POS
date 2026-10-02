import fs from 'node:fs';
import pg from 'pg';
import { matchDocument, flagsFor } from '../server/src/services/priceAgent/match.js';
const c = new pg.Client(process.env.DATABASE_URL || 'postgres://pruett:pruett@localhost/pruett_pos'); await c.connect();
const { rows: products } = await c.query('select id, sku, description, description2, cost_cents, vendor_id, vendor_sku, active, price_override, needs_review from products');
const dir = new URL('../server/test/fixtures/price-sheets', import.meta.url).pathname;
for (const f of fs.readdirSync(dir)) {
  const doc = JSON.parse(fs.readFileSync(`${dir}/${f}`));
  const r = matchDocument(doc, { products });
  const flags = {}; const methods = {}; const cols = {};
  let unchanged = 0;
  for (const m of r.matches) {
    methods[m.method] = (methods[m.method] || 0) + 1;
    cols[`${m.priceKey}/${m.divisor}`] = (cols[`${m.priceKey}/${m.divisor}`] || 0) + 1;
    if (m.newCostCents === m.product.cost_cents) unchanged++;
    for (const fl of flagsFor(m)) flags[fl] = (flags[fl] || 0) + 1;
  }
  console.log(`\n== ${f}: lines ${doc.items.length}, matched products ${r.matches.length}, unchanged ${unchanged}, unmatched lines ${r.unmatched.length}, dominant ${r.dominant}`);
  console.log('  methods', JSON.stringify(methods), 'cols', JSON.stringify(cols));
  console.log('  flags', JSON.stringify(flags));
  for (const m of r.matches.filter((x) => (process.argv.includes('-v') && x.newCostCents !== x.product.cost_cents) || flagsFor(x).some((fl) => ['check_unit', 'confirm_match'].includes(fl))).slice(0, Number(process.env.N || 12))) {
    console.log(`   ${m.product.sku.padEnd(16)} ${m.product.description.slice(0, 28).padEnd(28)} ${String(m.product.cost_cents / 100).padStart(8)} -> ${(m.newCostCents / 100).toFixed(2).padStart(8)} [${m.itemNo} ${m.priceKey}/${m.divisor} ${m.method}${m.confidence ? ' ' + m.confidence : ''}] ${m.line.description.slice(0, 40)}`);
  }
}
await c.end();
