// Customer import from Paladin's customer export (the "customer list" spreadsheet).
// Upserts by Paladin customer Id. Open balances are NOT imported here — they are loaded at cutover.

import fs from 'node:fs';
import path from 'node:path';
import { loadStaged, pending, DIR } from './importer.js';
import { HttpError } from '../http.js';

const PLAN_ALIASES = { cost: 'pruett' };

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const truthy = (v) => v === true || /^(true|yes|y|1)$/i.test(String(v ?? '').trim());

export function formatPhone(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return formatPhone(d.slice(1));
  return d ? clean(v) : null;
}

function titleCity(s) {
  return clean(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Turn one Paladin customer row (object keyed by header) into our customer record. */
export function toCustomer(r) {
  const name = clean(r.Name);
  const addr1 = clean(r.ContactAddress1);
  const addr2 = clean(r.ContactAddress2);
  const city = clean(r.ContactCity);
  const state = clean(r.ContactState).toUpperCase();
  const zip = clean(r.ContactZip);
  const cityLine = [city ? titleCity(city) : '', [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const address = [addr1, addr2, cityLine].filter(Boolean).join(', ') || null;
  const phone = formatPhone(r.Phone);
  const cell = formatPhone(r.CellPhone);
  const contact = [clean(r.FirstName), clean(r.LastName)].filter(Boolean).join(' ');
  const credit = Math.round((Number(r.CreditLimit) || 0) * 100);
  const stateTax = clean(r['State Tax']) || 'Default';
  const notes = [
    contact && contact.toUpperCase() !== name.toUpperCase() ? `Contact: ${contact}` : '',
    phone && cell && phone !== cell ? `Cell: ${cell}` : '',
    clean(r['Customer Type']) && clean(r['Customer Type']) !== 'None' ? `Type: ${clean(r['Customer Type'])}` : '',
    stateTax !== 'Default' ? `Paladin tax code: ${stateTax}` : '',
  ].filter(Boolean).join(' · ') || null;
  const balance = ['SinceLastStatement', 'StatementCurrent', 'StatementPastdue1', 'StatementPastdue2', 'StatementPastdue3']
    .reduce((s, k) => s + Math.round((Number(r[k]) || 0) * 100), 0);
  return {
    paladin_id: clean(r.Id) || null,
    deleted: truthy(r.Deleted),
    name,
    address,
    phone: phone || cell,
    email: clean(r.Email).toLowerCase() || null,
    email_statements: truthy(r.EmailStatements),
    charge_account: credit > 0,
    credit_limit_cents: credit,
    plan: clean(r.PricingPlan1) || null,
    tax_exempt: stateTax !== 'Default',
    require_po: truthy(r.RequirePO),
    checkout_note: clean(r.CheckoutNote) || null,
    notes,
    paladin_balance_cents: balance,
  };
}

export async function runCustomerImport(db, importId, userId, commit = false) {
  const staged = loadStaged(importId);
  const idx = Object.fromEntries(staged.headers.map((h, i) => [h, i]));
  for (const need of ['Id', 'Name']) {
    if (idx[need] === undefined) throw new HttpError(400, `This doesn't look like a Paladin customer export (no "${need}" column)`);
  }
  const { rows: levels } = await db.query('SELECT id, name, pct FROM price_levels');
  const levelByName = new Map(levels.map((l) => [l.name.toLowerCase(), l]));

  const result = { created: 0, updated: 0, skipped: [], warnings: [], byPlan: {}, taxExempt: [], newPlans: [], openBalances: [], total: staged.rows.length };
  for (let i = 0; i < staged.rows.length; i++) {
    const row = Object.fromEntries(staged.headers.map((h, j) => [h, staged.rows[i][j]]));
    const c = toCustomer(row);
    const rowNo = i + 2;
    if (!c.name) { result.skipped.push({ row: rowNo, name: '', reason: 'No name' }); continue; }
    if (c.deleted) { result.skipped.push({ row: rowNo, name: c.name, reason: 'Deleted in Paladin' }); continue; }
    if (/^retail$/i.test(c.name)) { result.skipped.push({ row: rowNo, name: c.name, reason: 'Paladin walk-in placeholder (no customer = retail here)' }); continue; }

    let level = null;
    if (c.plan) {
      // Paladin's COST plan was merged into Pruett (same rule: sell at cost).
      const planKey = PLAN_ALIASES[c.plan.toLowerCase()] || c.plan.toLowerCase();
      level = levelByName.get(planKey);
      if (!level) {
        level = { id: null, name: c.plan, pct: null };
        levelByName.set(c.plan.toLowerCase(), level);
        result.newPlans.push(c.plan);
        if (commit) {
          const { rows } = await db.query(
            `INSERT INTO price_levels (name, kind, pct, sort) VALUES ($1, 'discount', NULL, (SELECT COALESCE(max(sort),0)+10 FROM price_levels)) RETURNING id`, [c.plan]);
          level.id = rows[0].id;
        }
      }
    }
    const planName = level?.name || 'Retail';
    result.byPlan[planName] = (result.byPlan[planName] || 0) + 1;
    if (c.tax_exempt) result.taxExempt.push(c.name);
    if (c.paladin_balance_cents) result.openBalances.push({ name: c.name, balance_cents: c.paladin_balance_cents });

    const { rows: existing } = await db.query('SELECT id FROM customers WHERE paladin_id = $1', [c.paladin_id]);
    const vals = [c.name, c.address, c.phone, c.email, level?.id ?? null, c.charge_account, c.credit_limit_cents, c.tax_exempt,
      c.require_po, c.checkout_note, c.email_statements, c.notes];
    if (existing[0]) {
      result.updated++;
      if (commit) {
        await db.query(
          `UPDATE customers SET name=$2, address=$3, phone=$4, email=$5, price_level_id=$6, charge_account=$7, credit_limit_cents=$8,
             tax_exempt=$9, require_po=$10, checkout_note=$11, email_statements=$12, notes=$13, active=true WHERE id=$1`,
          [existing[0].id, ...vals]);
      }
    } else {
      result.created++;
      if (commit) {
        await db.query(
          `INSERT INTO customers (name, address, phone, email, price_level_id, charge_account, credit_limit_cents, tax_exempt,
             require_po, checkout_note, email_statements, notes, paladin_id, terms_days)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,30)`,
          [...vals, c.paladin_id]);
      }
    }
  }
  // Same name twice is allowed (different Paladin accounts) but worth a look.
  const names = {};
  for (const r of staged.rows) {
    const row = Object.fromEntries(staged.headers.map((h, j) => [h, r[j]]));
    if (truthy(row.Deleted)) continue;
    const n = clean(row.Name).toUpperCase();
    names[n] = (names[n] || 0) + 1;
  }
  for (const [n, count] of Object.entries(names)) if (count > 1 && n) result.warnings.push({ name: n, warning: `${count} Paladin accounts share this name` });
  result.openBalances.sort((a, b) => b.balance_cents - a.balance_cents);
  result.openBalanceTotal = result.openBalances.reduce((s, b) => s + b.balance_cents, 0);
  if (commit) {
    pending.delete(importId);
    fs.rmSync(path.join(DIR, `${importId}.json`), { force: true });
  }
  return result;
}
