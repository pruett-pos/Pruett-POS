// Pricing rules for Pruett.
//   Retail     = cost / (1 - category margin), rounded to the nearest $0.05
//   Price levels (Contractor, Builder, Wholesale...) = retail minus a % (or cost plus a %), never below cost
//   An item's own target margin (set at import) wins over its category margin.
// All values are integer cents.

export function roundToIncrement(cents, increment = 5) {
  if (!increment || increment <= 1) return Math.round(cents);
  return Math.round(cents / increment) * increment;
}

/** Round up to the increment (used so a floor price never lands under cost). */
export function roundUpToIncrement(cents, increment = 5) {
  if (!increment || increment <= 1) return Math.ceil(cents);
  return Math.ceil(cents / increment) * increment;
}

export function retailFromCost(costCents, marginPct, increment = 5) {
  if (!Number.isFinite(costCents) || costCents < 0) throw new Error('cost must be >= 0');
  if (!(marginPct >= 0 && marginPct < 100)) throw new Error('margin must be between 0 and 99.99');
  const raw = costCents / (1 - marginPct / 100);
  return roundToIncrement(raw, increment);
}

/** Actual margin % achieved by a price (for reports and approval screens). */
export function marginPct(priceCents, costCents) {
  if (!priceCents) return 0;
  return Math.round(((priceCents - costCents) / priceCents) * 10000) / 100;
}

/**
 * Price for a customer's price level (Paladin "pricing plan").
 *   level = null                         -> retail
 *   level.kind 'discount',  pct 10       -> retail - 10%
 *   level.kind 'cost_plus', pct 0        -> cost (COST plan)
 *   level.pct null (not configured yet)  -> retail, levelNotSet=true
 * Never below cost (rounded up to the price increment), never above retail.
 */
export function levelPrice({ retailCents, costCents = 0, level = null, increment = 5 }) {
  const out = (priceCents, extra = {}) => ({ priceCents, flooredAtCost: false, levelNotSet: false, ...extra });
  if (!level) return out(retailCents);
  if (level.pct === null || level.pct === undefined) return out(retailCents, { levelNotSet: true });
  const pct = Number(level.pct);
  let price = level.kind === 'cost_plus'
    ? roundUpToIncrement(costCents * (1 + pct / 100), increment)
    : roundToIncrement(retailCents * (1 - pct / 100), increment);
  if (price > retailCents) price = retailCents;
  if (costCents > 0 && price < costCents) {
    return out(Math.min(retailCents, roundUpToIncrement(costCents, increment)), { flooredAtCost: true });
  }
  return out(price);
}

/** Back-compat helper used in older tests: flat contractor % off retail. */
export function tierPrice({ retailCents, costCents = 0, tier = 'retail', contractorDiscountPct = 0, increment = 5 }) {
  const level = tier === 'contractor' ? { kind: 'discount', pct: contractorDiscountPct } : null;
  const { priceCents, flooredAtCost } = levelPrice({ retailCents, costCents, level, increment });
  return { priceCents, flooredAtCost };
}

/** Half-up rounding of tax on a taxable amount. */
export function taxFor(taxableCents, ratePct) {
  const t = (Math.abs(taxableCents) * ratePct) / 100;
  const rounded = Math.round(t + 1e-9);
  return taxableCents < 0 ? -rounded : rounded;
}

export function lineTotal(qty, unitPriceCents) {
  return Math.round(qty * unitPriceCents);
}

/** Totals for a set of lines: [{qty, unitPriceCents, taxable}] */
export function computeTotals(lines, taxRatePct, { taxExempt = false } = {}) {
  let subtotal = 0;
  let taxable = 0;
  for (const l of lines) {
    const t = lineTotal(l.qty, l.unitPriceCents);
    subtotal += t;
    if (l.taxable && !taxExempt) taxable += t;
  }
  const tax = taxFor(taxable, taxRatePct);
  return { subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax };
}

/** Parse "$1,234.56" / "12.5" / 12.5 into cents. Returns null if not a number. */
export function parseMoney(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  const s = String(v).trim().replace(/[$,\s]/g, '');
  if (s === '') return null;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100);
}
