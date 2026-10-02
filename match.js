// Matching vendor price-sheet lines to Pruett items, and choosing which price column applies.
//
// How Pruett's part numbers relate to vendor item numbers (learned from Lynch, Rollex, CertainTeed, Wausau):
//   - exact:        Wausau 139710993           -> Pruett 139710993
//   - color suffix: Lynch 20                   -> Pruett "20 AL", "20 BZ" ... (space + color code)
//                   Rollex A-SYS312L-          -> Pruett A-SYS312L-9 (item ends in "-" + color code)
//   - tier suffix:  CertainTeed 33110          -> Pruett 33110 (color price) and 33110D (deluxe price)
// Unit/column: Pruett's cost may be the vendor's piece price, carton price ÷ pieces, or square price.
// We pick the column whose value is closest to the item's current cost, prefer the column most
// lines from this vendor use (so a whole sheet stays on one volume tier), and remember the choice
// once a manager approves it.

const PCT = (a, b) => (b ? (a - b) / b : null);

export function normCode(s) {
  return String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/** Does Pruett sku belong to vendor item number `item` by the prefix rules above? */
export function skuMatchesItem(sku, item) {
  const s = normCode(sku);
  const it = normCode(item);
  if (!it || !s) return false;
  if (s === it) return true;
  if (it.length < 2 || !s.startsWith(it)) return false;
  if (it.endsWith('-')) return s.length > it.length;           // Rollex: item- + color code
  const next = s[it.length];
  if (next === ' ' || next === '-') return true;                // Lynch: "20 AL"
  // CertainTeed tier/finish suffix: 33110D, 30137P (short letter suffix after an all-digit item)
  if (/^\d{4,}$/.test(it) && /^[A-Z]{1,2}$/.test(s.slice(it.length))) return true;
  return false;
}

/** All price options for a vendor line: each column, and per-piece (÷ pack) for carton/box columns. */
export function priceOptions(line, columns = []) {
  const unitOf = Object.fromEntries((columns || []).map((c) => [c.key, c.unit]));
  const opts = [];
  for (const [key, v] of Object.entries(line.prices || {})) {
    if (!(typeof v === 'number' && v > 0)) continue;
    opts.push({ key, divisor: 1, value: v });
    const unit = unitOf[key] || '';
    const pack = Number(line.pack_qty);
    if (pack > 1 && !/^(piece|square|each|lb|foot)$/i.test(unit) && !/_(pc|piece|sq|unit)$/i.test(key)) {
      opts.push({ key, divisor: pack, value: v / pack });
    }
  }
  return opts;
}

const optId = (o) => `${o.key}/${o.divisor}`;

// Color/finish tiers used by siding manufacturers (CertainTeed: White, Color, Deluxe, Premium).
const TIERS = ['white', 'color', 'standard', 'deluxe', 'premium'];
const BASE_TIERS = new Set(['white', 'color', 'standard']);
const tierOf = (key) => TIERS.find((t) => key.startsWith(`${t}_`)) || null;
export function productTier(p) {
  const text = `${p.description || ''} ${p.description2 || ''}`.toUpperCase();
  if (/DELUX|DELEUX|\bDEL\b/.test(text)) return 'deluxe';
  if (/PREMIUM|\bPREM\b/.test(text)) return 'premium';
  return 'base';
}

/** Restrict options to the item's tier; base items may only use a premium/deluxe column if it fits far better. */
function tierFilter(opts, product) {
  if (!opts.some((o) => tierOf(o.key))) return opts;
  const t = productTier(product);
  if (t !== 'base') {
    const own = opts.filter((o) => tierOf(o.key) === t);
    return own.length ? own : opts;
  }
  const base = opts.filter((o) => !tierOf(o.key) || BASE_TIERS.has(tierOf(o.key)));
  if (!base.length) return opts;
  const cost = product.cost_cents / 100;
  const bestBase = bestOption(base, cost);
  const bestAll = bestOption(opts, cost);
  if (bestBase && bestAll && fit(bestAll.value, cost) + Math.log(1.15) < fit(bestBase.value, cost)) return opts;
  return base;
}
const fit = (value, cost) => (cost > 0 ? Math.abs(Math.log(value / cost)) : Infinity);

// ---------- description similarity (fallback suggestions) ----------
const STOP = new Set(['the', 'and', 'with', 'w', 'for', 'of', 'in', 'ced', 'dk', 'pk', 'ea', 'pc', 'pcs', 'ct']);
const SYN = {
  dspt: 'downspout', dspts: 'downspout', ds: 'downspout', downspouts: 'downspout',
  elb: 'elbow', elbows: 'elbow', miters: 'miter', mitre: 'miter', crnrpst: 'cornerpost', crnr: 'corner',
  corners: 'corner', screens: 'screen', caps: 'cap', brackets: 'bracket', hangers: 'hanger',
  outlets: 'outlet', wht: 'white', blk: 'black', bl: 'black', brn: 'brown', vert: 'vertical', pnl: 'panel', calk: 'caulk',
};
function tokens(s) {
  const t = String(s || '').toLowerCase()
    .replace(/(\d)\s*(in|inch|")/g, '$1')
    .replace(/(\d)\s*(ft|')/g, '$1')
    .replace(/(\d)\s*x\s*(?=\d)/g, '$1x')            // 2" x 3" -> 2x3
    .replace(/\bj-channel/g, 'jchannel')
    .replace(/[^a-z0-9/.x]+/g, ' ')
    .split(/\s+/).map((w) => SYN[w] || w).filter((w) => w && !STOP.has(w));
  return new Set(t);
}
const dims = (set) => new Set([...set].filter((w) => /\d/.test(w) && /[x/]/.test(w)));
export function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const jac = inter / (A.size + B.size - inter);
  const dA = dims(A);
  const dB = dims(B);
  let dimScore = 0;
  if (dA.size && dB.size) {
    let di = 0;
    for (const w of dA) if (dB.has(w)) di++;
    dimScore = di / Math.max(dA.size, dB.size);
    if (di === 0) return jac * 0.3; // sizes disagree: almost certainly a different item
  }
  return Math.min(1, jac * 0.6 + dimScore * 0.6);
}

/**
 * Match one extracted document against the catalog.
 * products: [{id, sku, description, description2, cost_cents, vendor_id, vendor_sku, active}]
 * links:    [{vendor_item_no, product_id, price_key, divisor, blocked}] for this vendor
 * Returns { matches: [...], unmatched: [...], dominant }
 */
export function matchDocument(doc, { products, links = [], vendorId = null, suggest = true, preferredPrefix = null }) {
  const items = doc.items || [];
  const columns = doc.price_columns || [];
  const bySku = new Map(products.map((p) => [normCode(p.sku), p]));
  const blocked = new Set(links.filter((l) => l.blocked).map((l) => `${normCode(l.vendor_item_no)}|${l.product_id}`));
  const linkMap = new Map();
  for (const l of links.filter((x) => !x.blocked)) {
    const k = normCode(l.vendor_item_no);
    if (!linkMap.has(k)) linkMap.set(k, []);
    linkMap.get(k).push(l);
  }
  const productsById = new Map(products.map((p) => [p.id, p]));
  // A product already tied to another vendor is not matched by number rules (avoids cross-vendor collisions).
  const eligible = (p) => p.active !== false && (!vendorId || !p.vendor_id || p.vendor_id === vendorId);

  const raw = [];
  const matchedLines = new Set();
  items.forEach((line, lineIdx) => {
    const opts = priceOptions(line, columns);
    if (!opts.length) return;
    for (const itemNo of line.item_nos || []) {
      const key = normCode(itemNo);
      const found = new Map();
      for (const l of linkMap.get(key) || []) {
        const p = productsById.get(l.product_id);
        if (p) found.set(p.id, { product: p, method: 'learned', link: l });
      }
      // Number rules too (a learned link for "20 BL" must not hide "20 AL").
      const exact = bySku.get(key);
      if (exact && eligible(exact) && !found.has(exact.id)) found.set(exact.id, { product: exact, method: 'part_number' });
      for (const p of products) {
        if (found.has(p.id) || !eligible(p)) continue;
        if (p.vendor_sku && normCode(p.vendor_sku) === key) found.set(p.id, { product: p, method: 'vendor_part' });
        else if (skuMatchesItem(p.sku, key)) found.set(p.id, { product: p, method: 'part_number' });
      }
      for (const m of found.values()) {
        if (blocked.has(`${key}|${m.product.id}`)) continue;
        raw.push({ ...m, line, lineIdx, itemNo, opts: tierFilter(opts, m.product) });
        matchedLines.add(lineIdx);
      }
    }
  });

  // Vendor-wide preferred column = the best-fit choice most lines agree on.
  const votes = new Map();
  for (const r of raw) {
    if (r.link?.price_key) continue;
    const best = bestOption(r.opts, r.product.cost_cents / 100);
    if (best && fit(best.value, r.product.cost_cents / 100) < Math.log(1.25)) votes.set(optId(best), (votes.get(optId(best)) || 0) + 1);
  }
  let dominant = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  if (preferredPrefix) dominant = null; // a manager-chosen column family wins; applied per line below

  const matches = [];
  const seenProducts = new Set();
  for (const r of raw) {
    if (seenProducts.has(r.product.id)) continue; // same product listed twice (e.g. same item on two pages)
    seenProducts.add(r.product.id);
    const cost = r.product.cost_cents / 100;
    let choice = null;
    let how = 'best_fit';
    if (r.link?.price_key) {
      choice = r.opts.find((o) => o.key === r.link.price_key && Number(o.divisor) === Number(r.link.divisor));
      how = choice ? 'learned' : 'best_fit';
    }
    if (!choice && preferredPrefix) {
      const pref = r.opts.filter((o) => o.key.startsWith(`${preferredPrefix}_`));
      const bp = bestOption(pref, cost) || pref[0];
      if (bp) { choice = bp; how = 'vendor_setting'; }
    }
    if (!choice) {
      const best = bestOption(r.opts, cost);
      const dom = dominant && r.opts.find((o) => optId(o) === dominant);
      // Prefer the vendor's usual column unless another column fits this item clearly better (>3%).
      if (dom && best && fit(dom.value, cost) <= fit(best.value, cost) + Math.log(1.03)) { choice = dom; how = 'vendor_usual'; }
      else if (best) choice = best;
      else if (dom) { choice = dom; how = 'vendor_usual'; }
      else { choice = r.opts[0]; how = 'first_column'; }
    }
    matches.push({
      product: r.product, method: r.method, lineIdx: r.lineIdx, line: r.line, itemNo: r.itemNo,
      priceKey: choice.key, divisor: choice.divisor, columnChoice: how,
      newCostCents: Math.round(choice.value * 100),
    });
  }

  // Lines nothing matched: suggest by description (needs confirmation), only when it's a strong, mutual best match.
  const unmatched = items.map((line, i) => ({ line, i })).filter(({ line, i }) => !matchedLines.has(i) && priceOptions(line, columns).length);
  const orderDoc = ['order_confirmation', 'quote', 'invoice'].includes(doc.document_type);
  if (suggest && orderDoc && unmatched.length) {
    const free = products.filter((p) => eligible(p) && !seenProducts.has(p.id));
    const bestForLine = new Map();
    const bestForProduct = new Map();
    for (const { line, i } of unmatched) {
      for (const p of free) {
        const s = similarity(line.description, `${p.description} ${p.description2 || ''}`);
        if (s < 0.5) continue;
        if ((bestForLine.get(i)?.score ?? 0) < s) bestForLine.set(i, { p, score: s });
        if ((bestForProduct.get(p.id)?.score ?? 0) < s) bestForProduct.set(p.id, { i, score: s });
      }
    }
    for (const [i, { p, score }] of bestForLine) {
      if (bestForProduct.get(p.id)?.i !== i) continue;
      const line = items[i];
      if ((line.item_nos || []).some((n) => blocked.has(`${normCode(n)}|${p.id}`))) continue;
      const opts = priceOptions(line, columns);
      const choice = bestOption(opts, p.cost_cents / 100) || opts[0];
      matches.push({
        product: p, method: 'description', confidence: Math.round(score * 100) / 100, lineIdx: i, line, itemNo: line.item_nos?.[0],
        priceKey: choice.key, divisor: choice.divisor, columnChoice: 'best_fit', newCostCents: Math.round(choice.value * 100),
      });
      matchedLines.add(i);
      seenProducts.add(p.id);
    }
  }
  return {
    matches,
    unmatched: items.filter((_, i) => !matchedLines.has(i)),
    dominant,
  };
}

function bestOption(opts, cost) {
  if (!opts.length) return null;
  if (!(cost > 0)) return null;
  return [...opts].sort((a, b) => fit(a.value, cost) - fit(b.value, cost))[0];
}

/** Flags shown on the approval screen. */
export function flagsFor(m, { largePct = 10 } = {}) {
  const flags = [];
  const old = m.product.cost_cents;
  const neu = m.newCostCents;
  const change = PCT(neu, old);
  if (!(old > 0)) flags.push('no_current_cost');
  else if (change !== null) {
    if (neu / old > 1.8 || neu / old < 0.55) flags.push('check_unit');
    else if (Math.abs(change) * 100 > largePct) flags.push('large_change');
    if (change < 0) flags.push('decrease');
  }
  if (m.method === 'description') flags.push('confirm_match');
  // Short codes like Lynch "23" or "ZIP" collide with unrelated Pruett part numbers; long codes (A-SYS312L-, 33110) are reliable.
  else if (m.method === 'part_number' && normCode(m.itemNo).length <= 4 && (flags.includes('check_unit') || flags.includes('large_change'))
    && similarity(m.line?.description, `${m.product.description} ${m.product.description2 || ''}`) < 0.12) flags.push('check_match');
  if (m.oldSheet) flags.push('old_sheet');
  if (m.product.price_override) flags.push('manual_price');
  if (m.product.needs_review) flags.push('item_needs_review');
  return flags;
}
