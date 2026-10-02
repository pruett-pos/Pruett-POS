// Turning an extracted vendor document into a price-change batch, and applying approved changes.

import { audit } from '../../db.js';
import { getSettings } from '../../settings.js';
import { retailFromCost } from '../../pricing.js';
import { config } from '../../config.js';
import { HttpError } from '../../http.js';
import { updateProduct } from '../catalog.js';
import { matchDocument, flagsFor, normCode } from './match.js';
import { verifyMatches } from './extract.js';

const OLD_SHEET_DAYS = 365; // price lists are usually annual
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

const normName = (s) => String(s || '').toLowerCase().replace(/\b(inc|llc|co|corp|corporation|company|mfg|manufacturing|the)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const domainOf = (email) => (/@([^>\s]+)/.exec(email || '')?.[1] || '').toLowerCase();
const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com', 'icloud.com']);

/** Find the vendor by name, alias or sender address; create it if new. */
export async function findOrCreateVendor(db, name, sender) {
  const { rows } = await db.query('SELECT * FROM vendors');
  const n = normName(name);
  const hit = rows.find((v) => n && (normName(v.name) === n || v.aliases.some((a) => normName(a) === n)))
    || rows.find((v) => n && (normName(v.name).includes(n) || n.includes(normName(v.name))) && normName(v.name).length > 3)
    || (sender && rows.find((v) => v.email && v.email.toLowerCase() === (/<?([^<>\s]+@[^<>\s]+)>?/.exec(sender)?.[1] || '').toLowerCase()))
    || (sender && !FREE_MAIL.has(domainOf(sender)) && rows.find((v) => v.email && domainOf(v.email) === domainOf(sender)));
  if (hit) {
    if (name && !hit.aliases.includes(name) && normName(hit.name) !== n) {
      await db.query('UPDATE vendors SET aliases = array_append(aliases, $2) WHERE id = $1', [hit.id, name]);
    }
    return hit;
  }
  const email = /<?([^<>\s]+@[^<>\s]+)>?/.exec(sender || '')?.[1] || null;
  const { rows: [v] } = await db.query('INSERT INTO vendors (name, email, aliases) VALUES ($1, $2, $3) RETURNING *', [name || 'Unknown vendor', email, [name].filter(Boolean)]);
  return v;
}

async function loadCatalog(db) {
  const { rows: products } = await db.query(
    `SELECT p.id, p.sku, p.description, p.description2, p.cost_cents, p.retail_cents, p.vendor_id, p.vendor_sku, p.active,
            p.price_override, p.needs_review, p.target_margin_pct, p.category_id, c.margin_pct AS category_margin
     FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.active`);
  return products;
}

function newRetail(p, newCostCents, settings) {
  if (p.price_override) return p.retail_cents;
  const margin = p.target_margin_pct ?? p.category_margin ?? settings.default_margin_pct;
  return retailFromCost(newCostCents, Number(margin), settings.price_rounding_cents);
}

/** Claude confirmed it's the same item: drop the "is this the right item?" flags. */
function verifiedFlags(m, flags) {
  if (!m.verified) return flags;
  return [...flags.filter((f) => f !== 'check_match' && f !== 'confirm_match'), 'ai_verified'];
}

/** Pick which % increase applies to an item when a notice lists several product lines. */
function increaseFor(product, increases) {
  if (increases.length === 1) return increases[0];
  const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3));
  const desc = words(`${product.description} ${product.description2 || ''}`);
  let best = null;
  let bestScore = 0;
  for (const inc of increases) {
    const score = [...words(inc.product_line)].filter((w) => desc.has(w) || desc.has(w.replace(/s$/, ''))).length;
    if (score > bestScore) { best = inc; bestScore = score; }
  }
  return best;
}

/**
 * Build a batch from a stored, extracted document.
 * Returns { batchId, summary }.
 */
export async function buildBatch(db, documentId, { verify = Boolean(config.anthropicApiKey) } = {}) {
  const { rows: [docRow] } = await db.query('SELECT * FROM price_documents WHERE id = $1', [documentId]);
  if (!docRow) throw new HttpError(404, 'Document not found');
  const doc = docRow.extracted;
  if (!doc) throw new HttpError(400, 'Document has not been read yet');
  if (doc.document_type === 'other') {
    await db.query(`UPDATE price_documents SET status = 'ignored' WHERE id = $1`, [documentId]);
    return { batchId: null, summary: { ignored: true } };
  }
  const settings = await getSettings(db);
  const vendor = await findOrCreateVendor(db, doc.vendor_name, docRow.sender);
  const products = await loadCatalog(db);
  const { rows: links } = await db.query('SELECT * FROM vendor_item_links WHERE vendor_id = $1', [vendor.id]);
  const effective = doc.effective_date || docRow.received_at.toISOString().slice(0, 10);
  const oldSheet = (Date.now() - new Date(effective).getTime()) / 86400000 > OLD_SHEET_DAYS;
  const kind = doc.increases?.length && !doc.items?.length ? 'percent' : 'sheet';

  let rowsOut = [];
  let summary = {};
  if (kind === 'sheet') {
    const result = matchDocument(doc, { products, links, vendorId: vendor.id, preferredPrefix: vendor.price_prefix || null });
    let matches = result.matches;

    // Let Claude double-check doubtful pairs (different-looking items, odd price ratios, description guesses).
    let verified = 0;
    let dropped = 0;
    if (verify) {
      const doubtful = matches.filter((m) => m.method !== 'learned' && flagsFor(m).some((f) => ['check_unit', 'check_match', 'confirm_match'].includes(f)));
      if (doubtful.length) {
        try {
          const verdicts = await verifyMatches(doubtful.slice(0, 150).map((m, i) => ({
            id: String(i),
            vendor: { item_no: m.itemNo, description: m.line.description, uom: m.line.uom, pack_qty: m.line.pack_qty, price: m.line.prices[m.priceKey], price_column: m.priceKey },
            pruett: { sku: m.product.sku, description: `${m.product.description} ${m.product.description2 || ''}`.trim(), current_cost: m.product.cost_cents / 100 },
          })));
          const drop = new Set();
          doubtful.slice(0, 150).forEach((m, i) => {
            const v = verdicts.get(String(i));
            if (!v) return;
            verified++;
            if (!v.same) { drop.add(m); dropped++; return; }
            m.verified = true;
            if (v.divisor && v.divisor > 0 && Number(v.divisor) !== Number(m.divisor)) {
              m.divisor = Number(v.divisor);
              m.newCostCents = Math.round((m.line.prices[m.priceKey] / m.divisor) * 100);
            }
          });
          matches = matches.filter((m) => !drop.has(m));
        } catch (err) {
          console.error('verifyMatches failed:', err.message);
        }
      }
    }

    let unchanged = 0;
    for (const m of matches) {
      m.oldSheet = oldSheet;
      if (m.newCostCents === m.product.cost_cents) { unchanged++; continue; }
      rowsOut.push({
        product: m.product, method: m.method, confidence: m.confidence ?? (m.verified ? 0.9 : null),
        vendorItemNo: m.itemNo, vendorDesc: m.line.description, vendorLine: m.line,
        priceKey: m.priceKey, divisor: m.divisor, newCost: m.newCostCents, flags: verifiedFlags(m, flagsFor(m, { largePct: settings.large_change_flag_pct })),
      });
    }
    summary = {
      lines: doc.items.length, matched: matches.length, unchanged, changes: rowsOut.length,
      unmatched_lines: result.unmatched.length, verified, dropped_by_check: dropped, old_sheet: oldSheet,
      column_preference: vendor.price_prefix || result.dominant,
    };
  } else {
    // % notice: apply to this vendor's items (linked or assigned).
    const linked = new Set(links.filter((l) => !l.blocked).map((l) => l.product_id));
    const mine = products.filter((p) => p.vendor_id === vendor.id || linked.has(p.id));
    for (const p of mine) {
      const inc = increaseFor(p, doc.increases);
      if (!inc || !(p.cost_cents > 0)) continue;
      const newCost = Math.round(p.cost_cents * (1 + inc.pct / 100));
      if (newCost === p.cost_cents) continue;
      rowsOut.push({
        product: p, method: 'percent', vendorItemNo: p.vendor_sku, vendorDesc: inc.product_line,
        vendorLine: { increase: inc }, increasePct: inc.pct, newCost,
        flags: flagsFor({ product: p, newCostCents: newCost, method: 'percent', oldSheet }, { largePct: settings.large_change_flag_pct }),
      });
    }
    summary = { increases: doc.increases, vendor_items: mine.length, changes: rowsOut.length };
  }

  const status = rowsOut.length ? 'pending' : 'empty';
  const { rows: [batch] } = await db.query(
    `INSERT INTO price_batches (vendor_id, source, source_ref, status, summary, document_id, kind, effective_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [vendor.id, docRow.source, docRow.filename || docRow.subject, status, summary, documentId, kind, effective],
  );
  for (const r of rowsOut) {
    await db.query(
      `INSERT INTO price_batch_items (batch_id, product_id, match_method, match_confidence, vendor_line, old_cost_cents, new_cost_cents,
         old_retail_cents, new_retail_cents, flags, vendor_item_no, vendor_desc, price_key, divisor, increase_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [batch.id, r.product.id, r.method, r.confidence, r.vendorLine, r.product.cost_cents, r.newCost, r.product.retail_cents,
        newRetail(r.product, r.newCost, settings), r.flags, r.vendorItemNo, r.vendorDesc, r.priceKey || null, r.divisor || 1, r.increasePct ?? null],
    );
  }
  await db.query(`UPDATE price_documents SET status = 'batched', vendor_id = $2, document_type = $3, effective_date = $4 WHERE id = $1`,
    [documentId, vendor.id, doc.document_type, effective]);
  return { batchId: batch.id, summary, vendor };
}

/** Switch a batch to another price column family (e.g. Rollex 20K tier -> 2.5K tier) and remember it for the vendor. */
export async function changeBatchColumn(db, batchId, from, to, userId) {
  const { rows: [batch] } = await db.query('SELECT * FROM price_batches WHERE id = $1', [batchId]);
  if (!batch) throw new HttpError(404, 'Batch not found');
  const settings = await getSettings(db);
  const { rows: items } = await db.query(
    `SELECT i.*, p.cost_cents, p.retail_cents, p.price_override, p.target_margin_pct, c.margin_pct AS category_margin
     FROM price_batch_items i JOIN products p ON p.id = i.product_id LEFT JOIN categories c ON c.id = p.category_id
     WHERE i.batch_id = $1 AND i.decision = 'pending'`, [batchId]);
  let changed = 0;
  for (const it of items) {
    if (!it.price_key?.startsWith(`${from}_`)) continue;
    const key = `${to}_${it.price_key.slice(from.length + 1)}`;
    const v = it.vendor_line?.prices?.[key];
    if (!(v > 0)) continue;
    const newCost = Math.round((v / Number(it.divisor || 1)) * 100);
    const p = { ...it, cost_cents: it.cost_cents };
    await db.query('UPDATE price_batch_items SET price_key = $2, new_cost_cents = $3, new_retail_cents = $4 WHERE id = $1',
      [it.id, key, newCost, newRetail(p, newCost, settings)]);
    changed++;
  }
  await db.query(`UPDATE vendors SET price_prefix = $2 WHERE id = $1`, [batch.vendor_id, to]);
  await audit(db, userId, 'price_batch.column', 'price_batch', batchId, { from, to, changed });
  return changed;
}

async function refreshBatchStatus(db, batchId) {
  const { rows: [s] } = await db.query(
    `SELECT count(*) FILTER (WHERE decision = 'pending') AS pending,
            count(*) FILTER (WHERE decision = 'approved') AS approved,
            count(*) FILTER (WHERE decision = 'approved' AND applied_at IS NULL) AS waiting,
            count(*) AS total FROM price_batch_items WHERE batch_id = $1`, [batchId]);
  let status = 'pending';
  if (s.total === 0) status = 'empty';
  else if (s.pending > 0) status = s.approved > 0 ? 'partially_approved' : 'pending';
  else if (s.waiting > 0) status = 'scheduled';
  else if (s.approved === s.total) status = 'approved';
  else if (s.approved > 0) status = 'partially_approved';
  else status = 'rejected';
  await db.query('UPDATE price_batches SET status = $2 WHERE id = $1', [batchId, status]);
  return status;
}

async function applyItem(db, it, userId) {
  const { rows: [p] } = await db.query('SELECT vendor_id, vendor_sku FROM products WHERE id = $1 FOR UPDATE', [it.product_id]);
  await updateProduct(db, it.product_id, { cost_cents: it.new_cost_cents }, userId, 'price_agent', it.batch_id);
  if (p && (!p.vendor_id || !p.vendor_sku) && it.vendor_item_no) {
    await db.query('UPDATE products SET vendor_id = COALESCE(vendor_id, $2), vendor_sku = COALESCE(vendor_sku, $3) WHERE id = $1',
      [it.product_id, it.vendor_id, it.vendor_item_no]);
  }
  await db.query('UPDATE price_batch_items SET applied_at = now() WHERE id = $1', [it.id]);
}

/**
 * Record decisions. decision: 'approved' | 'rejected' | 'not_a_match'.
 * Approved items apply now, or on the batch's effective date if that is in the future.
 */
export async function decideItems(db, batchId, itemIds, decision, user) {
  const { rows: [batch] } = await db.query('SELECT * FROM price_batches WHERE id = $1 FOR UPDATE', [batchId]);
  if (!batch) throw new HttpError(404, 'Batch not found');
  const { rows: items } = await db.query(
    `SELECT i.*, b.vendor_id FROM price_batch_items i JOIN price_batches b ON b.id = i.batch_id
     WHERE i.batch_id = $1 AND i.id = ANY($2) AND i.decision = 'pending'`, [batchId, itemIds]);
  const future = batch.effective_date && batch.effective_date.toISOString().slice(0, 10) > todayISO();
  let applied = 0;
  for (const it of items) {
    await db.query('UPDATE price_batch_items SET decision = $2, decided_by = $3, decided_at = now() WHERE id = $1', [it.id, decision, user.id]);
    if (decision === 'approved') {
      if (it.vendor_item_no && it.match_method !== 'percent') {
        await db.query(
          `INSERT INTO vendor_item_links (vendor_id, vendor_item_no, product_id, price_key, divisor, blocked, confirmed_by)
           VALUES ($1,$2,$3,$4,$5,false,$6)
           ON CONFLICT (vendor_id, vendor_item_no, product_id) DO UPDATE SET price_key = EXCLUDED.price_key, divisor = EXCLUDED.divisor,
             blocked = false, confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()`,
          [it.vendor_id, normCode(it.vendor_item_no), it.product_id, it.price_key, it.divisor, user.id]);
      }
      if (!future) { await applyItem(db, it, user.id); applied++; }
    } else if (decision === 'not_a_match' && it.vendor_item_no) {
      await db.query(
        `INSERT INTO vendor_item_links (vendor_id, vendor_item_no, product_id, blocked, confirmed_by) VALUES ($1,$2,$3,true,$4)
         ON CONFLICT (vendor_id, vendor_item_no, product_id) DO UPDATE SET blocked = true, confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()`,
        [it.vendor_id, normCode(it.vendor_item_no), it.product_id, user.id]);
    }
  }
  const status = await refreshBatchStatus(db, batchId);
  await db.query('UPDATE price_batches SET reviewed_by = $2, reviewed_at = now() WHERE id = $1', [batchId, user.id]);
  await audit(db, user.id, `price_batch.${decision}`, 'price_batch', batchId, { items: items.length, applied, scheduled: future });
  return { decided: items.length, applied, scheduled: future ? items.filter(() => decision === 'approved').length : 0, status };
}

/** Apply approved changes whose effective date has arrived (runs hourly). */
export async function applyDueChanges(db) {
  const { rows } = await db.query(
    `SELECT i.*, b.vendor_id FROM price_batch_items i JOIN price_batches b ON b.id = i.batch_id
     WHERE i.decision = 'approved' AND i.applied_at IS NULL AND (b.effective_date IS NULL OR b.effective_date <= $1::date)`,
    [todayISO()]);
  const batches = new Set();
  for (const it of rows) {
    await applyItem(db, it, it.decided_by);
    batches.add(it.batch_id);
  }
  for (const b of batches) await refreshBatchStatus(db, b);
  return rows.length;
}
