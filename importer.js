// Product import from a Paladin export (CSV or Excel).
// Paladin lets you choose which columns to export, so instead of assuming exact names we auto-map
// columns by common names and let the user correct the mapping on the preview screen.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { parseMoney, retailFromCost, marginPct } from '../pricing.js';
import { getSettings } from '../settings.js';
import { createProduct, updateProduct } from './catalog.js';
import { HttpError } from '../http.js';

export const TARGETS = {
  sku: ['part number', 'part #', 'part no', 'partnumber', 'item number', 'item #', 'item no', 'sku', 'item code', 'stock number', 'item'],
  description: ['description', 'item description', 'desc', 'description 1', 'name', 'item name'],
  description2: ['description 2', 'desc 2', 'extended description'],
  alt_code: ['primary alternate', 'alternate part number', 'alt part number', 'alternate'],
  upc: ['upc', 'upc code', 'barcode', 'bar code', 'ean', 'gtin'],
  cost: ['replacement cost', 'repl cost', 'unit cost', 'cost', 'avg cost', 'average cost', 'last cost', 'current cost'],
  retail: ['retail', 'retail price', 'price', 'sell price', 'selling price', 'list price', 'price 1', 'level 1'],
  on_hand: ['soh', 'stock on hand', 'on hand', 'qty on hand', 'quantity on hand', 'qoh', 'onhand', 'stock', 'quantity', 'qty'],
  category: ['department', 'dept', 'category', 'class', 'product class', 'group', 'dept name', 'department name'],
  vendor: ['vendor', 'primary vendor', 'supplier', 'vendor name', 'supplier name'],
  vendor_sku: ['vendor part number', 'vendor part', 'vendor item', 'vendor sku', 'mfg part number', 'mfg part', 'supplier part', 'manufacturer part'],
  unit: ['uom', 'unit', 'stocking unit', 'unit of measure', 'sell unit', 'stocking uom'],
  reorder_point: ['min', 'min stock', 'minimum', 'reorder point', 'order point', 'min qty'],
  max_qty: ['max', 'max stock', 'maximum', 'max qty'],
  location: ['location', 'bin', 'bin location', 'aisle', 'location name'],
  taxable: ['taxable', 'tax', 'tax code'],
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

export function autoMap(headers) {
  const mapping = {};
  const used = new Set();
  // Exact matches first, then "contains" matches, in priority order of synonyms.
  for (const pass of ['exact', 'contains']) {
    for (const [target, syns] of Object.entries(TARGETS)) {
      if (mapping[target] !== undefined) continue;
      for (const syn of syns) {
        // "contains" matching only for multi-word names, so e.g. "supplier" can't grab "SUPPLIER RATIO".
        const idx = headers.findIndex((h, i) => !used.has(i) && (pass === 'exact' ? norm(h) === syn : syn.includes(' ') && norm(h).includes(syn)));
        if (idx >= 0) { mapping[target] = idx; used.add(idx); break; }
      }
    }
  }
  return mapping;
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return String(v.text);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

/** Read a CSV/XLSX buffer into { headers, rows } (rows are arrays of strings). */
export async function readSheet(buffer, filename) {
  let grid;
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    // Use the sheet with the most rows.
    const ws = wb.worksheets.reduce((a, b) => (b.actualRowCount > (a?.actualRowCount ?? -1) ? b : a), null);
    if (!ws) throw new HttpError(400, 'The workbook has no sheets');
    grid = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellText(row.getCell(c).value));
      grid.push(vals);
    });
  } else if (/\.(csv|txt|tsv)$/i.test(filename)) {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    const delimiter = /\.tsv$/i.test(filename) || (text.split('\n')[0].split('\t').length > text.split('\n')[0].split(',').length) ? '\t' : ',';
    try {
      // relax_quotes: inch marks like 5" E-Z STEP-DOWN are common in item descriptions
      grid = parseCsv(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true });
    } catch (err) {
      throw new HttpError(400, `Could not read the CSV file: ${err.message}`);
    }
  } else if (/\.xls$/i.test(filename)) {
    throw new HttpError(400, 'Old .xls files are not supported — open it in Excel and "Save As" .xlsx or .csv');
  } else {
    throw new HttpError(400, 'Upload a .csv or .xlsx file');
  }
  // Header row = first row within the first 15 that has at least 3 non-empty text cells.
  const headerIdx = Math.max(0, grid.slice(0, 15).findIndex((r) => r.filter((c) => c && Number.isNaN(Number(c))).length >= 3));
  const headers = grid[headerIdx].map((h, i) => h || `Column ${i + 1}`);
  const rows = grid.slice(headerIdx + 1).filter((r) => r.some((c) => c !== ''));
  return { headers, rows };
}

export const pending = new Map(); // importId -> { headers, rows, filename, created }
export const DIR = path.join(os.tmpdir(), 'pruett-imports');

export async function stageImport(buffer, filename) {
  const sheet = await readSheet(buffer, filename);
  const id = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify({ ...sheet, filename }));
  pending.set(id, { ...sheet, filename });
  return { importId: id, headers: sheet.headers, rowCount: sheet.rows.length, mapping: autoMap(sheet.headers), sample: sheet.rows.slice(0, 5) };
}

export function loadStaged(id) {
  if (!/^[a-f0-9]{16}$/.test(id || '')) throw new HttpError(400, 'Bad import id');
  if (pending.has(id)) return pending.get(id);
  const f = path.join(DIR, `${id}.json`);
  if (!fs.existsSync(f)) throw new HttpError(404, 'Import expired — upload the file again');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

const parseQty = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const parseBool = (v) => (v === '' || v == null ? null : !/^(n|no|false|0|exempt|non|nt)/i.test(String(v).trim()));

/** Turn one sheet row into a product record using the mapping. */
function toRecord(row, mapping) {
  const get = (k) => (mapping[k] === undefined || mapping[k] === null ? undefined : row[mapping[k]]);
  let min = parseQty(get('reorder_point'));
  let max = parseQty(get('max_qty'));
  if (max != null && max >= 999) max = null;           // Paladin uses 999 for "no max"
  if (min === 0 && max == null) min = null;
  const loc = (get('location') || '').trim();
  return {
    sku: (get('sku') || '').trim(),
    description: (get('description') || '').trim(),
    description2: (get('description2') || '').trim() || null,
    alt_code: (get('alt_code') || '').trim() || null,
    upc: (get('upc') || '').replace(/\s/g, '') || null,
    cost_cents: parseMoney(get('cost')),
    paladin_retail_cents: parseMoney(get('retail')),
    on_hand: parseQty(get('on_hand')),
    category: (get('category') || '').trim() || null,
    vendor: (get('vendor') || '').trim() || null,
    vendor_sku: (get('vendor_sku') || '').trim() || null,
    unit: (get('unit') || '').trim().toUpperCase() || null,
    reorder_point: min,
    reorder_qty: max != null && min != null && max > min ? max - min : null,
    location: loc && !/^none$/i.test(loc) ? loc : null,
    taxable: parseBool(get('taxable')),
  };
}

/**
 * Preview or commit an import.
 * options.priceMode: 'margin' (recalculate retail from cost + category margin — Pruett's rule)
 *                    'keep'   (keep Paladin's retail price as a manual override)
 * options.updateOnHand: overwrite on-hand counts for existing products
 */
export async function runImport(db, importId, mapping, options = {}, userId, commit = false) {
  const staged = loadStaged(importId);
  if (mapping.sku === undefined || mapping.description === undefined) throw new HttpError(400, 'Map at least the part number and description columns');
  const settings = await getSettings(db);
  const priceMode = options.priceMode === 'keep' ? 'keep' : 'margin';

  const { rows: cats } = await db.query('SELECT id, name, margin_pct FROM categories');
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c]));
  const { rows: vends } = await db.query('SELECT id, name FROM vendors');
  const vendByName = new Map(vends.map((v) => [v.name.toLowerCase(), v]));

  const result = { created: 0, updated: 0, skipped: 0, errors: [], warnings: [], review: [], newCategories: [], newVendors: [], priceImpact: [], total: staged.rows.length };
  const seen = new Set();
  const altCodes = [];
  for (let i = 0; i < staged.rows.length; i++) {
    const rowNo = i + 2;
    const r = toRecord(staged.rows[i], mapping);
    if (!r.sku) { result.skipped++; continue; }
    if (seen.has(r.sku.toLowerCase())) { result.errors.push({ row: rowNo, sku: r.sku, error: 'Duplicate part number in file' }); continue; }
    seen.add(r.sku.toLowerCase());
    if (!r.description) { result.errors.push({ row: rowNo, sku: r.sku, error: 'Missing description' }); continue; }
    if (r.cost_cents == null && r.paladin_retail_cents == null) { result.errors.push({ row: rowNo, sku: r.sku, error: 'No cost or price' }); continue; }

    // Category / vendor (created on commit)
    let cat = r.category ? catByName.get(r.category.toLowerCase()) : null;
    if (r.category && !cat) {
      cat = { id: null, name: r.category, margin_pct: settings.default_margin_pct };
      catByName.set(r.category.toLowerCase(), cat);
      result.newCategories.push(r.category);
      if (commit) {
        const { rows } = await db.query('INSERT INTO categories (name, margin_pct) VALUES ($1,$2) RETURNING id', [r.category, settings.default_margin_pct]);
        cat.id = rows[0].id;
      }
    }
    let vend = r.vendor ? vendByName.get(r.vendor.toLowerCase()) : null;
    if (r.vendor && !vend) {
      vend = { id: null, name: r.vendor };
      vendByName.set(r.vendor.toLowerCase(), vend);
      result.newVendors.push(r.vendor);
      if (commit) {
        const { rows } = await db.query('INSERT INTO vendors (name) VALUES ($1) RETURNING id', [r.vendor]);
        vend.id = rows[0].id;
      }
    }

    const margin = cat ? cat.margin_pct : settings.default_margin_pct;
    const cost = Math.max(0, r.cost_cents ?? 0);
    const paladin = r.paladin_retail_cents;
    let useOverride = false;
    let targetMargin = null;
    let review = null;
    let newRetail;
    if (priceMode === 'keep') {
      // Keep today's price. A healthy item keeps its current margin as its own target margin, so when the
      // price agent updates the cost later the price moves to hold that margin. Problem items keep their
      // price as a manual price and go on the review list.
      if (!paladin || paladin <= 0) { review = 'No price'; useOverride = true; newRetail = 0; }
      else if (cost <= 0) { review = 'No cost'; useOverride = true; newRetail = paladin; }
      else if (paladin < cost) { review = 'Price below cost'; useOverride = true; newRetail = paladin; }
      else {
        targetMargin = Math.round(((paladin - cost) / paladin) * 100000) / 1000;
        if (targetMargin >= 95) { review = 'Margin over 95% — check cost'; useOverride = true; targetMargin = null; }
        newRetail = paladin;
      }
    } else {
      newRetail = retailFromCost(cost, margin, settings.price_rounding_cents);
      if (cost <= 0) review = 'No cost';
    }
    if (review) result.review.push({ row: rowNo, sku: r.sku, description: r.description, reason: review, cost_cents: cost, price_cents: paladin ?? 0 });
    if (paladin != null && newRetail !== paladin) {
      result.priceImpact.push({ sku: r.sku, description: r.description, cost_cents: cost, paladin_retail_cents: r.paladin_retail_cents,
        new_retail_cents: newRetail, paladin_margin: marginPct(r.paladin_retail_cents, cost), new_margin: marginPct(newRetail, cost) });
    }

    const { rows: existing } = await db.query('SELECT id FROM products WHERE lower(sku) = lower($1)', [r.sku]);
    const record = {
      sku: r.sku, description: r.description, upc: r.upc, category_id: cat?.id ?? null, vendor_id: vend?.id ?? null,
      vendor_sku: r.vendor_sku, unit: r.unit || 'EA', cost_cents: cost, price_override: useOverride, retail_cents: newRetail,
      reorder_point: r.reorder_point, reorder_qty: r.reorder_qty, location: r.location, taxable: r.taxable ?? true,
      target_margin_pct: targetMargin, description2: r.description2, needs_review: review,
    };
    // Keep the exact current price (the margin math alone could round it by a cent).
    if (priceMode === 'keep' && !useOverride) record._exactRetail = newRetail;
    let productId = existing[0]?.id;
    if (existing[0]) {
      result.updated++;
      if (commit) {
        await updateProduct(db, existing[0].id, record, userId, 'import');
        if (options.updateOnHand && r.on_hand != null) {
          const { rows: [cur] } = await db.query('SELECT on_hand FROM products WHERE id = $1', [existing[0].id]);
          const delta = r.on_hand - cur.on_hand;
          if (delta) {
            await db.query('UPDATE products SET on_hand = $2 WHERE id = $1', [existing[0].id, r.on_hand]);
            await db.query(`INSERT INTO inventory_movements (product_id, qty_change, reason, ref, user_id) VALUES ($1,$2,'import',$3,$4)`,
              [existing[0].id, delta, staged.filename, userId]);
          }
        }
      }
    } else {
      result.created++;
      if (commit) productId = await createProduct(db, { ...record, on_hand: r.on_hand ?? 0, _source: 'import' }, userId);
    }
    if (r.alt_code && r.alt_code.toLowerCase() !== r.sku.toLowerCase()) altCodes.push({ row: rowNo, sku: r.sku, code: r.alt_code, productId });
  }
  // Alternate part numbers become extra barcodes, unless they clash with another item's part number.
  const allSkus = new Set(staged.rows.map((row) => String(row[mapping.sku] ?? '').trim().toLowerCase()));
  const altSeen = new Set();
  for (const a of altCodes) {
    const key = a.code.toLowerCase();
    if (allSkus.has(key) || altSeen.has(key)) {
      result.warnings.push({ row: a.row, sku: a.sku, warning: `Alternate "${a.code}" is also used by another item — not added as a barcode` });
      continue;
    }
    altSeen.add(key);
    if (commit) {
      const { rows: [hit] } = await db.query('SELECT 1 FROM products WHERE lower(sku) = $1', [key]);
      if (hit) { result.warnings.push({ row: a.row, sku: a.sku, warning: `Alternate "${a.code}" matches an existing part number` }); continue; }
      await db.query(`INSERT INTO product_barcodes (barcode, product_id) VALUES ($1,$2)
        ON CONFLICT (barcode) DO UPDATE SET product_id = EXCLUDED.product_id`, [a.code, a.productId]);
    }
  }
  result.altCodes = altCodes.length;
  result.priceImpact.sort((a, b) => Math.abs(b.new_retail_cents - b.paladin_retail_cents) - Math.abs(a.new_retail_cents - a.paladin_retail_cents));
  result.priceChanges = result.priceImpact.length;
  result.priceImpact = result.priceImpact.slice(0, 200);
  if (commit) {
    pending.delete(importId);
    fs.rmSync(path.join(DIR, `${importId}.json`), { force: true });
  }
  return result;
}
