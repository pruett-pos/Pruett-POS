// Sales, returns and voids. The server always re-prices from the database —
// the register only sends product ids, quantities and (optional) manager-approved price overrides.

import { tx, audit, query } from '../db.js';
import { getSettings } from '../settings.js';
import { levelPrice, computeTotals, lineTotal } from '../pricing.js';
import { HttpError } from '../http.js';
import { isManager, useApproval } from '../auth.js';
import { cards } from './cardPayments.js';

function requireTaxRate(settings) {
  if (settings.tax_rate_pct === null || settings.tax_rate_pct === undefined) {
    throw new HttpError(400, 'Sales tax rate is not set. A manager must set it in Settings before selling.');
  }
  return Number(settings.tax_rate_pct);
}

async function loadCustomer(db, id, lock = false) {
  if (!id) return null;
  const { rows } = await db.query(
    `SELECT c.*, pl.name AS level_name, pl.kind AS level_kind, pl.pct AS level_pct
     FROM customers c LEFT JOIN price_levels pl ON pl.id = c.price_level_id
     WHERE c.id = $1 AND c.active ${lock ? 'FOR UPDATE OF c' : ''}`, [id]);
  if (!rows[0]) throw new HttpError(400, 'Customer not found');
  return rows[0];
}

/** The customer's price level as { name, kind, pct } or null for retail. */
function levelOf(customer) {
  if (!customer?.price_level_id) return null;
  return { name: customer.level_name, kind: customer.level_kind, pct: customer.level_pct };
}

/** Lazily consume one manager approval for the whole transaction. */
function approvalGate(user, token) {
  let approvedBy = null;
  return (why) => {
    if (isManager(user)) return user.id;
    if (approvedBy) return approvedBy;
    try {
      approvedBy = useApproval(token);
    } catch {
      throw new HttpError(403, `Manager approval required: ${why}`, { needsApproval: true });
    }
    return approvedBy;
  };
}

/** Price the cart without saving anything (used by the register to show totals). */
export async function priceCart(db, { customer_id, lines }) {
  const settings = await getSettings(db);
  const taxRate = settings.tax_rate_pct == null ? 0 : Number(settings.tax_rate_pct);
  const customer = await loadCustomer(db, customer_id);
  const level = levelOf(customer);
  const priced = [];
  for (const l of lines) priced.push(await priceLine(db, l, level, settings));
  const totals = computeTotals(priced, taxRate, { taxExempt: !!customer?.tax_exempt });
  return { tier: level?.name || 'Retail', levelNotSet: priced.some((p) => p.levelNotSet), taxRatePct: taxRate, taxRateMissing: settings.tax_rate_pct == null, lines: priced, ...totals };
}

async function priceLine(db, l, level, settings) {
  if (!l.product_id) {
    // Misc / non-stock item keyed in at the counter.
    if (!l.description || l.unit_price_cents == null) throw new HttpError(400, 'Misc items need a description and price');
    return {
      product_id: null, sku: 'MISC', description: l.description, qty: l.qty, cost_cents: 0,
      listPriceCents: l.unit_price_cents, tierPriceCents: l.unit_price_cents, unitPriceCents: l.unit_price_cents,
      taxable: l.taxable ?? true, overridden: false, flooredAtCost: false,
    };
  }
  const { rows } = await db.query('SELECT id, sku, description, cost_cents, retail_cents, taxable, active FROM products WHERE id = $1', [l.product_id]);
  const p = rows[0];
  if (!p || !p.active) throw new HttpError(400, `Product ${l.product_id} is not available`);
  const { priceCents, flooredAtCost, levelNotSet } = levelPrice({
    retailCents: p.retail_cents, costCents: p.cost_cents, level, increment: settings.price_rounding_cents,
  });
  const overridden = l.unit_price_cents != null && l.unit_price_cents !== priceCents;
  return {
    product_id: p.id, sku: p.sku, description: p.description, qty: l.qty, cost_cents: p.cost_cents,
    listPriceCents: p.retail_cents, tierPriceCents: priceCents, unitPriceCents: overridden ? l.unit_price_cents : priceCents,
    taxable: p.taxable, overridden, flooredAtCost, levelNotSet,
  };
}

/**
 * Complete a sale.
 * input: { customer_id, lines:[{product_id|null, qty, unit_price_cents?, description?, taxable?}],
 *          payments:[{method, amount_cents, tendered_cents?, check_number?, payment_intent_id?}],
 *          po_number?, notes?, register?, approval_token? }
 */
export async function completeSale(input, user) {
  const pendingCaptures = [];
  const sale = await tx(async (db) => {
    const settings = await getSettings(db);
    const taxRate = requireTaxRate(settings);
    const needApproval = approvalGate(user, input.approval_token);
    const customer = await loadCustomer(db, input.customer_id, true);
    const level = levelOf(customer);
    const tier = level?.name || 'Retail';
    if (customer?.require_po && !input.po_number) throw new HttpError(400, `${customer.name} requires a PO / job number`);

    if (!input.lines?.length) throw new HttpError(400, 'Cart is empty');
    const lines = [];
    let overrideBy = null;
    for (const l of input.lines) {
      if (!(l.qty > 0)) throw new HttpError(400, 'Quantities must be greater than zero (use Returns for refunds)');
      const pl = await priceLine(db, l, level, settings);
      if (pl.product_id && pl.unitPriceCents === 0) throw new HttpError(400, `${pl.sku} has no price — tap its price to enter one`);
      if (pl.overridden && settings.require_manager_for_price_override) overrideBy = needApproval(`price change on ${pl.sku}`);
      else if (pl.overridden) overrideBy = user.id;
      lines.push({ ...pl, overrideBy: pl.overridden ? overrideBy : null });
    }
    const totals = computeTotals(lines, taxRate, { taxExempt: !!customer?.tax_exempt });

    // ----- payments -----
    const payments = input.payments || [];
    if (!payments.length) throw new HttpError(400, 'No payment entered');
    const paid = payments.reduce((s, p) => s + p.amount_cents, 0);
    if (paid !== totals.totalCents) {
      throw new HttpError(400, `Payments ($${(paid / 100).toFixed(2)}) do not equal the total ($${(totals.totalCents / 100).toFixed(2)})`);
    }
    const paymentRows = [];
    for (const p of payments) {
      if (!(p.amount_cents > 0)) throw new HttpError(400, 'Payment amounts must be positive');
      const row = { method: p.method, amount_cents: p.amount_cents, tendered_cents: null, change_cents: null, check_number: null, pi: null, brand: null, last4: null };
      if (p.method === 'cash') {
        const tendered = p.tendered_cents ?? p.amount_cents;
        if (tendered < p.amount_cents) throw new HttpError(400, 'Cash tendered is less than the amount');
        row.tendered_cents = tendered;
        row.change_cents = tendered - p.amount_cents;
      } else if (p.method === 'check') {
        row.check_number = p.check_number || null;
      } else if (p.method === 'charge') {
        if (!customer?.charge_account) throw new HttpError(400, 'This customer does not have a charge account');
        const newBal = customer.balance_cents + p.amount_cents;
        if (customer.credit_limit_cents > 0 && newBal > customer.credit_limit_cents) {
          needApproval(`charge exceeds ${customer.name}'s credit limit`);
        }
        customer.balance_cents = newBal;
      } else if (p.method === 'card') {
        if (!p.payment_intent_id) throw new HttpError(400, 'Card payment is missing');
        const { rows } = await db.query('SELECT * FROM card_attempts WHERE payment_intent_id = $1 FOR UPDATE', [p.payment_intent_id]);
        const att = rows[0];
        if (!att) throw new HttpError(400, 'Unknown card payment');
        if (att.status === 'used') throw new HttpError(409, 'That card payment was already used on another sale');
        if (att.amount_cents !== p.amount_cents) throw new HttpError(400, 'Card amount does not match');
        const st = await cards().status(att.payment_intent_id, att.reader_id);
        if (st.status !== 'approved') throw new HttpError(409, `Card payment is ${st.status}`);
        row.pi = att.payment_intent_id;
        row.brand = st.brand;
        row.last4 = st.last4;
        pendingCaptures.push(att);
      } else {
        throw new HttpError(400, `Unknown payment method ${p.method}`);
      }
      paymentRows.push(row);
    }

    // ----- save -----
    const { rows: [s] } = await db.query(
      `INSERT INTO sales (kind, status, customer_id, user_id, register, tier, po_number, subtotal_cents, tax_cents, total_cents,
         tax_rate_pct, tax_exempt, notes, completed_at, qbo_sync_status)
       VALUES ('sale','completed',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),'pending') RETURNING *`,
      [customer?.id ?? null, user.id, input.register || null, tier, input.po_number || null, totals.subtotalCents, totals.taxCents,
        totals.totalCents, taxRate, !!customer?.tax_exempt, input.notes || null],
    );
    for (const l of lines) {
      await db.query(
        `INSERT INTO sale_lines (sale_id, product_id, sku, description, qty, unit_price_cents, list_price_cents, cost_cents, taxable,
           line_total_cents, price_overridden_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [s.id, l.product_id, l.sku, l.description, l.qty, l.unitPriceCents, l.listPriceCents, l.cost_cents, l.taxable,
          lineTotal(l.qty, l.unitPriceCents), l.overrideBy],
      );
      if (l.product_id) {
        await db.query('UPDATE products SET on_hand = on_hand - $2 WHERE id = $1', [l.product_id, l.qty]);
        await db.query(`INSERT INTO inventory_movements (product_id, qty_change, reason, ref, user_id) VALUES ($1,$2,'sale',$3,$4)`,
          [l.product_id, -l.qty, `sale ${s.number}`, user.id]);
      }
    }
    for (const r of paymentRows) {
      await db.query(
        `INSERT INTO payments (sale_id, method, amount_cents, tendered_cents, change_cents, check_number, stripe_payment_intent, card_brand, card_last4)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.id, r.method, r.amount_cents, r.tendered_cents, r.change_cents, r.check_number, r.pi, r.brand, r.last4],
      );
    }
    if (customer && paymentRows.some((r) => r.method === 'charge')) {
      await db.query('UPDATE customers SET balance_cents = $2 WHERE id = $1', [customer.id, customer.balance_cents]);
    }
    for (const att of pendingCaptures) {
      await db.query(`UPDATE card_attempts SET status = 'used', updated_at = now() WHERE id = $1`, [att.id]);
    }
    await audit(db, user.id, 'sale.complete', 'sale', s.id, { number: s.number, total: totals.totalCents, overrideBy });

    // Capture cards last, still inside the transaction: if a capture fails nothing is saved.
    for (const att of pendingCaptures) {
      try {
        await cards().capture(att.payment_intent_id);
      } catch (err) {
        throw new HttpError(502, `Card capture failed: ${err.message}. The sale was not saved.`);
      }
    }
    return s;
  });
  return getSale({ query }, sale.id);
}

/** Full sale with lines, payments, customer and how much of each line can still be returned. */
export async function getSale(db, id) {
  const { rows: [sale] } = await db.query(
    `SELECT s.*, u.name AS cashier, c.name AS customer_name, c.company AS customer_company,
       o.number AS original_number
     FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
     LEFT JOIN sales o ON o.id = s.original_sale_id WHERE s.id = $1`,
    [id],
  );
  if (!sale) throw new HttpError(404, 'Sale not found');
  const { rows: lines } = await db.query(
    `SELECT l.*, COALESCE((SELECT -sum(r.qty) FROM sale_lines r JOIN sales rs ON rs.id = r.sale_id
        WHERE r.original_line_id = l.id AND rs.status = 'completed'), 0) AS returned_qty
     FROM sale_lines l WHERE l.sale_id = $1 ORDER BY l.id`,
    [id],
  );
  const { rows: payments } = await db.query('SELECT * FROM payments WHERE sale_id = $1 ORDER BY id', [id]);
  return { ...sale, lines, payments };
}

export async function getSaleByNumber(db, number) {
  const { rows } = await db.query('SELECT id FROM sales WHERE number = $1', [number]);
  if (!rows[0]) throw new HttpError(404, `Receipt #${number} not found`);
  return getSale(db, rows[0].id);
}

/** How much can still be refunded to each card used on a sale. */
async function refundableCards(db, saleId) {
  const { rows } = await db.query(
    `SELECT p.stripe_payment_intent AS pi, p.amount_cents
       - COALESCE((SELECT -sum(r.amount_cents) FROM payments r JOIN sales rs ON rs.id = r.sale_id
                   WHERE r.stripe_payment_intent = p.stripe_payment_intent AND r.amount_cents < 0 AND rs.status = 'completed'), 0) AS remaining
     FROM payments p WHERE p.sale_id = $1 AND p.method = 'card' AND p.amount_cents > 0`,
    [saleId],
  );
  return rows.filter((r) => r.remaining > 0);
}

/**
 * Process a return.
 * input: { original_sale_id?, customer_id?, lines:[{original_line_id, qty} | {product_id, qty}],
 *          refund_method: 'original'|'cash'|'card'|'charge'|'check', restock?: true, approval_token?, notes?, register? }
 * Returns with a receipt refund at the original price and tax rate.
 * Returns without a receipt need a manager and refund at today's price.
 */
export async function createReturn(input, user) {
  const refundsToIssue = [];
  const ret = await tx(async (db) => {
    const settings = await getSettings(db);
    const needApproval = approvalGate(user, input.approval_token);
    const restock = input.restock !== false;
    if (!input.lines?.length) throw new HttpError(400, 'Nothing selected to return');

    let original = null;
    let customer = null;
    const lines = [];
    let taxRate;
    let taxExempt;

    if (input.original_sale_id) {
      original = await getSale(db, input.original_sale_id);
      if (original.status !== 'completed' || original.kind !== 'sale') throw new HttpError(400, 'That receipt cannot be returned');
      customer = await loadCustomer(db, original.customer_id, true);
      taxRate = Number(original.tax_rate_pct);
      taxExempt = original.tax_exempt;
      for (const r of input.lines) {
        const ol = original.lines.find((l) => l.id === r.original_line_id);
        if (!ol) throw new HttpError(400, 'Line is not on the original receipt');
        if (!(r.qty > 0)) continue;
        if (r.qty > Number(ol.qty) - Number(ol.returned_qty) + 1e-9) {
          throw new HttpError(400, `Only ${Number(ol.qty) - Number(ol.returned_qty)} of ${ol.sku} can still be returned`);
        }
        lines.push({ original_line_id: ol.id, product_id: ol.product_id, sku: ol.sku, description: ol.description, qty: r.qty,
          unitPriceCents: ol.unit_price_cents, listPriceCents: ol.list_price_cents, cost_cents: ol.cost_cents, taxable: ol.taxable });
      }
      const daysOld = (Date.now() - new Date(original.completed_at).getTime()) / 86400000;
      if (daysOld > 90) needApproval('receipt is older than 90 days');
    } else {
      needApproval('return without a receipt');
      taxRate = requireTaxRate(settings);
      customer = await loadCustomer(db, input.customer_id, true);
      taxExempt = !!customer?.tax_exempt;
      for (const r of input.lines) {
        if (!(r.qty > 0)) continue;
        const pl = await priceLine(db, { product_id: r.product_id, qty: r.qty }, levelOf(customer), settings);
        lines.push({ original_line_id: null, ...pl });
      }
    }
    if (!lines.length) throw new HttpError(400, 'Nothing selected to return');

    const totals = computeTotals(lines, taxRate, { taxExempt });
    const refund = totals.totalCents; // positive amount going back to the customer
    const method = input.refund_method || 'cash';

    // Work out where the refund goes: [{ method, amount }] plus card refunds to issue.
    const nonCard = []; // { method, amount }
    const toCard = async (amount) => {
      const cardsOnSale = await refundableCards(db, original.id);
      let left = amount;
      for (const c of cardsOnSale) {
        if (left <= 0) break;
        const amt = Math.min(left, c.remaining);
        refundsToIssue.push({ pi: c.pi, amount: amt });
        left -= amt;
      }
      return amount - left; // amount actually placed on cards
    };
    const toCharge = (amount) => {
      if (!customer?.charge_account) throw new HttpError(400, 'Customer has no charge account');
      customer.balance_cents -= amount;
      nonCard.push({ method: 'charge', amount });
    };

    if (method === 'original') {
      // Same way they paid: cards first (up to what's left on them), then charge account, then cash.
      if (!original) throw new HttpError(400, '"Original payment" needs the original receipt');
      let left = refund - (await toCard(refund));
      if (left > 0 && original.payments.some((p) => p.method === 'charge') && customer?.charge_account) {
        toCharge(left);
        left = 0;
      }
      if (left > 0) nonCard.push({ method: 'cash', amount: left });
    } else if (method === 'card') {
      if (!original) throw new HttpError(400, 'Card refunds need the original receipt');
      const placed = await toCard(refund);
      if (placed < refund) throw new HttpError(400, `Only $${(placed / 100).toFixed(2)} can be refunded to the card on that receipt`);
    } else if (method === 'charge') {
      toCharge(refund);
    } else if (method === 'cash' || method === 'check') {
      if (original && !original.payments.some((p) => p.method === 'cash' || p.method === 'check') && refund > 0) {
        needApproval('cash refund for a sale not paid in cash');
      }
      nonCard.push({ method, amount: refund });
    } else {
      throw new HttpError(400, 'Unknown refund method');
    }

    const { rows: [s] } = await db.query(
      `INSERT INTO sales (kind, status, original_sale_id, customer_id, user_id, register, tier, subtotal_cents, tax_cents, total_cents,
         tax_rate_pct, tax_exempt, notes, completed_at)
       VALUES ('return','completed',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) RETURNING *`,
      [original?.id ?? null, customer?.id ?? null, user.id, input.register || null, original?.tier || levelOf(customer)?.name || 'Retail',
        -totals.subtotalCents, -totals.taxCents, -totals.totalCents, taxRate, taxExempt, input.notes || null],
    );
    for (const l of lines) {
      await db.query(
        `INSERT INTO sale_lines (sale_id, original_line_id, product_id, sku, description, qty, unit_price_cents, list_price_cents, cost_cents,
           taxable, line_total_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [s.id, l.original_line_id, l.product_id, l.sku, l.description, -l.qty, l.unitPriceCents, l.listPriceCents, l.cost_cents,
          l.taxable, -lineTotal(l.qty, l.unitPriceCents)],
      );
      if (restock && l.product_id) {
        await db.query('UPDATE products SET on_hand = on_hand + $2 WHERE id = $1', [l.product_id, l.qty]);
        await db.query(`INSERT INTO inventory_movements (product_id, qty_change, reason, ref, user_id) VALUES ($1,$2,'return',$3,$4)`,
          [l.product_id, l.qty, `return ${s.number}`, user.id]);
      }
    }
    for (const p of nonCard) {
      if (p.amount > 0) await db.query('INSERT INTO payments (sale_id, method, amount_cents) VALUES ($1,$2,$3)', [s.id, p.method, -p.amount]);
    }
    if (nonCard.some((p) => p.method === 'charge')) await db.query('UPDATE customers SET balance_cents = $2 WHERE id = $1', [customer.id, customer.balance_cents]);

    // Card refunds go out last; if Stripe refuses, nothing is saved.
    for (const r of refundsToIssue) {
      const { refundId } = await cards().refund(r.pi, r.amount).catch((err) => {
        throw new HttpError(502, `Card refund failed: ${err.message}`);
      });
      await db.query(
        `INSERT INTO payments (sale_id, method, amount_cents, stripe_payment_intent, stripe_refund) VALUES ($1,'card',$2,$3,$4)`,
        [s.id, -r.amount, r.pi, refundId],
      );
    }
    await audit(db, user.id, 'sale.return', 'sale', s.id, { number: s.number, original: original?.number, refund });
    return s;
  });
  return getSale({ query }, ret.id);
}

/** Void a completed sale (manager). Reverses inventory, charge balance, and refunds cards in full. */
export async function voidSale(saleId, user, approvalToken, reason) {
  return tx(async (db) => {
    const needApproval = approvalGate(user, approvalToken);
    const approver = needApproval('void a sale');
    const sale = await getSale(db, saleId);
    if (sale.status !== 'completed') throw new HttpError(400, 'Sale is not completed');
    if (sale.kind !== 'sale') throw new HttpError(400, 'Returns cannot be voided');
    const { rows: [{ n }] } = await db.query(`SELECT count(*) AS n FROM sales WHERE original_sale_id = $1 AND status = 'completed'`, [saleId]);
    if (n > 0) throw new HttpError(400, 'Items from this sale were already returned — use Returns instead');
    await db.query(`SELECT 1 FROM sales WHERE id = $1 FOR UPDATE`, [saleId]);

    for (const l of sale.lines) {
      if (!l.product_id) continue;
      await db.query('UPDATE products SET on_hand = on_hand + $2 WHERE id = $1', [l.product_id, l.qty]);
      await db.query(`INSERT INTO inventory_movements (product_id, qty_change, reason, ref, user_id) VALUES ($1,$2,'void',$3,$4)`,
        [l.product_id, l.qty, `void ${sale.number}`, user.id]);
    }
    const charged = sale.payments.filter((p) => p.method === 'charge').reduce((s, p) => s + p.amount_cents, 0);
    if (charged) await db.query('UPDATE customers SET balance_cents = balance_cents - $2 WHERE id = $1', [sale.customer_id, charged]);
    await db.query(`UPDATE sales SET status = 'voided', voided_at = now(), voided_by = $2,
      qbo_sync_status = CASE WHEN qbo_sync_status = 'pending' THEN 'skip' ELSE qbo_sync_status END WHERE id = $1`, [saleId, approver]);
    await audit(db, user.id, 'sale.void', 'sale', saleId, { number: sale.number, approver, reason });
    for (const p of sale.payments.filter((x) => x.method === 'card' && x.amount_cents > 0)) {
      const { refundId } = await cards().refund(p.stripe_payment_intent, p.amount_cents).catch((err) => {
        throw new HttpError(502, `Card refund failed: ${err.message}`);
      });
      await db.query('UPDATE payments SET stripe_refund = $2 WHERE id = $1', [p.id, refundId]);
    }
    return getSale(db, saleId);
  });
}
