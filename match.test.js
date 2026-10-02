import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { skuMatchesItem, matchDocument, similarity, flagsFor } from '../src/services/priceAgent/match.js';

const fixture = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/price-sheets/${n}`, import.meta.url)));
let id = 0;
const P = (sku, description, cost, extra = {}) => ({ id: ++id, sku, description, cost_cents: Math.round(cost * 100), active: true, ...extra });

test('part-number rules', () => {
  assert.ok(skuMatchesItem('20 AL', '20'));          // Lynch color suffix
  assert.ok(!skuMatchesItem('20686', '20'));         // different item
  assert.ok(!skuMatchesItem('2068046531278', '20'));
  assert.ok(skuMatchesItem('A-SYS312L-9', 'A-SYS312L-')); // Rollex color code
  assert.ok(!skuMatchesItem('A-SYS312L-9', 'A-SYS312-'));
  assert.ok(skuMatchesItem('33110D', '33110'));      // CertainTeed deluxe
  assert.ok(!skuMatchesItem('331101', '33110'));
  assert.ok(skuMatchesItem('07', '07'));
  assert.ok(!skuMatchesItem('0710', '07'));
});

test('Lynch: color variants share the piece price; wrong-family items get flagged', () => {
  const products = [P('20 BL', "DSPTS 2X3 10' BLACK", 10.26), P('20 AL', "DSPTS 2X3 10'  ALMOND", 13.39), P('07', "4X5 10/6' DSPT", 55.44),
    P('23 TILE ADPT', '2X3 TILE ADAPTER BLACK', 4.28), P('20686', 'MSHXL1/4T MAGNETIC HEX LONG', 8.61)];
  const r = matchDocument(fixture('lynch-preferred-2026-06.json'), { products });
  const by = Object.fromEntries(r.matches.map((m) => [m.product.sku, m]));
  assert.equal(by['20 BL'].newCostCents, 1433);
  assert.equal(by['20 BL'].priceKey, 'piece');
  assert.equal(by['20 AL'].newCostCents, 1433);
  assert.equal(by['07'].newCostCents, 5544);
  assert.ok(!by['20686']);
  const tile = flagsFor(by['23 TILE ADPT']);
  assert.ok(tile.includes('check_unit') && tile.includes('check_match'), tile.join());
  assert.ok(flagsFor(by['20 BL']).includes('large_change'));
});

test('Rollex: carton price ÷ pieces, and a vendor column preference', () => {
  const products = [P('A-SYS312L-9', 'SYSTEM 3-12 LANCED BRONZE', 22.32), P('B-SL4WG-2', 'SL-4 FASCIA T/T  BROWN', 18.20)];
  const doc = fixture('rollex-2026-04.json');
  const r = matchDocument(doc, { products });
  const soffit = r.matches.find((m) => m.product.sku === 'A-SYS312L-9');
  assert.equal(soffit.newCostCents, 2232); // 357.08 / 16
  assert.equal(soffit.divisor, 16);
  const r2 = matchDocument(doc, { products, preferredPrefix: '20k' });
  assert.equal(r2.matches.find((m) => m.product.sku === 'A-SYS312L-9').newCostCents, 2129); // 340.56 / 16
  assert.equal(r2.matches.find((m) => m.product.sku === 'B-SL4WG-2').newCostCents, 1730);
});

test('CertainTeed: deluxe items use the deluxe column, base items stay on the color column', () => {
  const products = [P('33110', 'MONOGRAM D4 WG', 116.49), P('33110D', 'MONOGRAM D4 WG DEL', 132.80, { description2: 'DELUXE COLORS' }),
    P('40110', 'AMERICAN LEGEND D4 WG', 112.14), P('51401CL', "3/4\" OS CRNRPST-10' WG CLAY", 16.56)];
  const r = matchDocument(fixture('certainteed-vinyl-2025-01.json'), { products });
  const by = Object.fromEntries(r.matches.map((m) => [m.product.sku, m]));
  assert.equal(by['33110'].newCostCents, 11649);
  assert.equal(by['33110D'].newCostCents, 13280);
  assert.equal(by['40110'].newCostCents, 9838, 'base item must not jump to the deluxe column');
  assert.equal(by['51401CL'].newCostCents, 1562);
});

test('Wausau order: description match converts pack price to each', () => {
  const products = [P('DK 2IN TRIM', 'DK 5/4X2INX16 TRIM', 22.78), P('70920847', "DK 5/4X4X16' CED TRIM 2/PK", 66.69)];
  const r = matchDocument(fixture('wausau-order-2026-02.json'), { products });
  const trim = r.matches.find((m) => m.product.sku === 'DK 2IN TRIM');
  assert.equal(trim.method, 'description');
  assert.equal(trim.newCostCents, 2392); // 95.68 per 4-pack
  assert.ok(flagsFor(trim).includes('confirm_match'));
  assert.ok(similarity("Onyx 5/4x4x16' Ced DK Trim (2/Pk-120)", "DK 5/4X4X16' CED TRIM 2/PK") >= 0.5);
  assert.ok(similarity("3\" x 4\" .024 Gauge Downspout 11'", '2X3 TILE ADAPTER BLACK') < 0.12);
});

test('learned links and "not a match" blocks', () => {
  const products = [P('20 BL', "DSPTS 2X3 10' BLACK", 10.26)];
  const doc = fixture('lynch-preferred-2026-06.json');
  const learned = matchDocument(doc, { products, links: [{ vendor_item_no: '20', product_id: products[0].id, price_key: 'partial_piece', divisor: 1 }] });
  assert.equal(learned.matches[0].newCostCents, 1576);
  assert.equal(learned.matches[0].method, 'learned');
  const blocked = matchDocument(doc, { products, links: [{ vendor_item_no: '20', product_id: products[0].id, blocked: true }] });
  assert.equal(blocked.matches.length, 0);
});
