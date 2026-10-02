import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retailFromCost, tierPrice, computeTotals, parseMoney, taxFor, marginPct } from '../src/pricing.js';

test('retail = cost / (1 - margin), nearest nickel', () => {
  assert.equal(retailFromCost(1000, 25), 1335);   // 13.333 -> 13.35
  assert.equal(retailFromCost(389, 25), 520);     // 5.1867 -> 5.20
  assert.equal(retailFromCost(3600, 28), 5000);   // 50.00
  assert.equal(retailFromCost(0, 40), 0);
  assert.equal(retailFromCost(1000, 25, 1), 1333);
  assert.throws(() => retailFromCost(100, 100));
});

test('contractor price is flat % off retail and never below cost', () => {
  assert.deepEqual(tierPrice({ retailCents: 1335, costCents: 1000, tier: 'contractor', contractorDiscountPct: 10 }), { priceCents: 1200, flooredAtCost: false });
  assert.deepEqual(tierPrice({ retailCents: 1335, costCents: 1000, tier: 'retail', contractorDiscountPct: 10 }), { priceCents: 1335, flooredAtCost: false });
  // 5% margin item with 10% contractor discount would go under cost
  assert.deepEqual(tierPrice({ retailCents: 1055, costCents: 1001, tier: 'contractor', contractorDiscountPct: 10 }), { priceCents: 1005, flooredAtCost: true });
});

test('totals and tax', () => {
  const t = computeTotals([{ qty: 3, unitPriceCents: 520, taxable: true }, { qty: 1, unitPriceCents: 1000, taxable: false }], 8.5);
  assert.deepEqual(t, { subtotalCents: 2560, taxCents: 133, totalCents: 2693 });
  assert.equal(computeTotals([{ qty: 1, unitPriceCents: 1000, taxable: true }], 8.5, { taxExempt: true }).taxCents, 0);
  assert.equal(taxFor(-1560, 8.5), -133);
  assert.equal(computeTotals([{ qty: 2.5, unitPriceCents: 199, taxable: true }], 0).subtotalCents, 498);
});

test('money parsing', () => {
  assert.equal(parseMoney('$1,234.56'), 123456);
  assert.equal(parseMoney('12.5'), 1250);
  assert.equal(parseMoney(3.891), 389);
  assert.equal(parseMoney('(4.00)'), -400);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('n/a'), null);
  assert.equal(marginPct(1335, 1000), 25.09);
});
