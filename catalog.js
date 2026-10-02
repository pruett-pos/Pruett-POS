import { retailFromCost } from '../pricing.js';
import { getSettings } from '../settings.js';
import { HttpError } from '../http.js';

export const PRODUCT_COLUMNS = `p.id, p.sku, p.upc, p.description, p.category_id, c.name AS category, c.margin_pct,
  p.vendor_id, v.name AS vendor, p.vendor_sku, p.unit, p.cost_cents, p.retail_cents, p.price_override,
  p.target_margin_pct, p.description2, p.needs_review,
  p.taxable, p.on_hand, p.reorder_point, p.reorder_qty, p.location, p.active, p.updated_at`;

export const PRODUCT_FROM = `products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN vendors v ON v.id = p.vendor_id`;

export async function getProduct(db, id) {
  const { rows } = await db.query(`SELECT ${PRODUCT_COLUMNS} FROM ${PRODUCT_FROM} WHERE p.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Product not found');
  return rows[0];
}

/** Exact lookup by SKU, UPC, or alternate barcode (what the scanner sends). */
export async function findByCode(db, code) {
  const c = String(code).trim();
  const { rows } = await db.query(
    `SELECT ${PRODUCT_COLUMNS} FROM ${PRODUCT_FROM}
     WHERE p.active AND (lower(p.sku) = lower($1) OR p.upc = $1
       OR p.id = (SELECT product_id FROM product_barcodes WHERE barcode = $1))
     ORDER BY (lower(p.sku) = lower($1)) DESC LIMIT 1`,
    [c],
  );
  return rows[0] || null;
}

export async function searchProducts(db, { q = '', categoryId, lowStock, needsReview, includeInactive, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];
  if (!includeInactive) where.push('p.active');
  if (q) {
    params.push(`%${q}%`, q);
    where.push(`(p.sku ILIKE $${params.length - 1} OR p.upc = $${params.length} OR p.vendor_sku ILIKE $${params.length - 1}
      OR p.description ILIKE $${params.length - 1} OR p.description2 ILIKE $${params.length - 1}
      OR p.id IN (SELECT product_id FROM product_barcodes WHERE barcode = $${params.length})
      OR similarity(p.description, $${params.length}) > 0.3)`);
  }
  if (categoryId) { params.push(categoryId); where.push(`p.category_id = $${params.length}`); }
  if (lowStock) where.push('p.reorder_point IS NOT NULL AND p.on_hand <= p.reorder_point');
  if (needsReview) where.push('p.needs_review IS NOT NULL');
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(Math.min(limit, 500), offset);
  const order = q ? `ORDER BY (lower(p.sku) = lower($2)) DESC, similarity(p.description, $2) DESC, p.description` : 'ORDER BY p.description';
  const { rows } = await db.query(
    `SELECT ${PRODUCT_COLUMNS}, count(*) OVER() AS total FROM ${PRODUCT_FROM} ${w} ${order}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

async function marginFor(db, categoryId, settings) {
  if (!categoryId) return settings.default_margin_pct;
  const { rows } = await db.query('SELECT margin_pct FROM categories WHERE id = $1', [categoryId]);
  if (!rows[0]) throw new HttpError(400, 'Unknown category');
  return rows[0].margin_pct;
}

/**
 * Work out the retail price for a product given cost/category, honoring manual overrides.
 * input.retail_cents is only used when price_override is true.
 */
export async function computeRetail(db, { cost_cents, category_id, price_override, retail_cents, target_margin_pct, _exactRetail }, settings) {
  settings ||= await getSettings(db);
  if (_exactRetail != null) return _exactRetail; // import: keep today's price exactly
  if (price_override) {
    if (retail_cents == null) throw new HttpError(400, 'Manual price requires a retail price');
    return retail_cents;
  }
  const margin = target_margin_pct ?? (await marginFor(db, category_id, settings));
  return retailFromCost(cost_cents, Number(margin), settings.price_rounding_cents);
}

/** The margin that drives an item's price: its own target, else its category, else the store default. */
export async function effectiveMargin(db, product, settings) {
  if (product.target_margin_pct != null) return Number(product.target_margin_pct);
  return Number(await marginFor(db, product.category_id, settings || (await getSettings(db))));
}

export async function recordPriceChange(db, { productId, oldCost, newCost, oldRetail, newRetail, source, batchId, userId }) {
  if (oldCost === newCost && oldRetail === newRetail) return;
  await db.query(
    `INSERT INTO price_history (product_id, old_cost_cents, new_cost_cents, old_retail_cents, new_retail_cents, source, batch_id, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [productId, oldCost, newCost, oldRetail, newRetail, source, batchId ?? null, userId ?? null],
  );
}

export async function createProduct(db, data, userId) {
  const settings = await getSettings(db);
  const retail = await computeRetail(db, data, settings);
  const { rows } = await db.query(
    `INSERT INTO products (sku, upc, description, category_id, vendor_id, vendor_sku, unit, cost_cents, retail_cents,
       price_override, taxable, on_hand, reorder_point, reorder_qty, location, active, paladin_id, target_margin_pct, description2, needs_review)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [data.sku, data.upc || null, data.description, data.category_id || null, data.vendor_id || null, data.vendor_sku || null,
      data.unit || 'EA', data.cost_cents, retail, !!data.price_override, data.taxable ?? true, data.on_hand ?? 0,
      data.reorder_point ?? null, data.reorder_qty ?? null, data.location || null, data.active ?? true, data.paladin_id || null,
      data.target_margin_pct ?? null, data.description2 || null, data.needs_review || null],
  );
  const id = rows[0].id;
  await recordPriceChange(db, { productId: id, oldCost: null, newCost: data.cost_cents, oldRetail: null, newRetail: retail, source: data._source || 'manual', userId });
  if (data.on_hand) {
    await db.query(`INSERT INTO inventory_movements (product_id, qty_change, reason, ref, user_id) VALUES ($1,$2,$3,$4,$5)`,
      [id, data.on_hand, data._source === 'import' ? 'import' : 'adjust', 'initial', userId ?? null]);
  }
  return id;
}

export async function updateProduct(db, id, patch, userId, source = 'manual', batchId = null) {
  const current = await getProduct(db, id);
  const merged = { ...current, ...patch };
  const settings = await getSettings(db);
  // Only re-price when something that drives the price changed, so editing a description never moves a price.
  const keys = ['cost_cents', 'category_id', 'price_override', 'target_margin_pct', '_exactRetail', ...(merged.price_override ? ['retail_cents'] : [])];
  const pricingChanged = keys.some((k) => k in patch && String(patch[k] ?? '') !== String(current[k] ?? ''));
  const retail = pricingChanged ? await computeRetail(db, merged, settings) : current.retail_cents;
  await db.query(
    `UPDATE products SET sku=$2, upc=$3, description=$4, category_id=$5, vendor_id=$6, vendor_sku=$7, unit=$8,
       cost_cents=$9, retail_cents=$10, price_override=$11, taxable=$12, reorder_point=$13, reorder_qty=$14,
       location=$15, active=$16, target_margin_pct=$17, description2=$18, needs_review=$19, updated_at=now() WHERE id=$1`,
    [id, merged.sku, merged.upc || null, merged.description, merged.category_id || null, merged.vendor_id || null,
      merged.vendor_sku || null, merged.unit || 'EA', merged.cost_cents, retail, !!merged.price_override, merged.taxable,
      merged.reorder_point ?? null, merged.reorder_qty ?? null, merged.location || null, merged.active,
      merged.target_margin_pct ?? null, merged.description2 || null, merged.needs_review || null],
  );
  await recordPriceChange(db, { productId: id, oldCost: current.cost_cents, newCost: merged.cost_cents, oldRetail: current.retail_cents, newRetail: retail, source, batchId, userId });
  return getProduct(db, id);
}

/** Inventory adjustment / receiving. qtyChange may be negative. */
export async function adjustInventory(db, { productId, qtyChange, reason, ref, userId }) {
  const { rowCount } = await db.query('UPDATE products SET on_hand = on_hand + $2, updated_at = now() WHERE id = $1', [productId, qtyChange]);
  if (!rowCount) throw new HttpError(404, 'Product not found');
  await db.query(`INSERT INTO inventory_movements (product_id, qty_change, reason, ref, user_id) VALUES ($1,$2,$3,$4,$5)`,
    [productId, qtyChange, reason, ref ?? null, userId ?? null]);
}

/**
 * Recalculate retail prices for every non-override product in a category after a margin change.
 * With apply=false it only returns the preview.
 */
export async function repriceCategory(db, categoryId, { apply = false, userId } = {}) {
  const settings = await getSettings(db);
  const margin = await marginFor(db, categoryId, settings);
  const { rows } = await db.query(
    `SELECT id, sku, description, cost_cents, retail_cents FROM products
     WHERE category_id IS NOT DISTINCT FROM $1 AND NOT price_override AND target_margin_pct IS NULL AND active ORDER BY description`,
    [categoryId],
  );
  const changes = [];
  for (const p of rows) {
    const next = retailFromCost(p.cost_cents, margin, settings.price_rounding_cents);
    if (next !== p.retail_cents) changes.push({ ...p, new_retail_cents: next });
  }
  if (apply) {
    for (const c of changes) {
      await db.query('UPDATE products SET retail_cents = $2, updated_at = now() WHERE id = $1', [c.id, c.new_retail_cents]);
      await recordPriceChange(db, { productId: c.id, oldCost: c.cost_cents, newCost: c.cost_cents, oldRetail: c.retail_cents, newRetail: c.new_retail_cents, source: 'category_margin', userId });
    }
  }
  return { margin, changes };
}
