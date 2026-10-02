// Reading vendor documents with Claude.
//   extractDocument() turns a PDF / spreadsheet / email body into structured price lines.
//   verifyMatches()   double-checks doubtful item matches (different numbering, odd price ratios).
// Requires ANTHROPIC_API_KEY. Without it, uploads are stored and marked failed with a clear message.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { readSheet } from '../importer.js';

let client = null;
export function claude() {
  if (!config.anthropicApiKey) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY is not set — the price agent cannot read documents yet'), { status: 503 });
  }
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}
/** Tests can inject a fake client. */
export function setClaudeClient(c) { client = c; }

const DOC_SCHEMA = {
  type: 'object',
  required: ['vendor_name', 'document_type', 'items', 'price_columns', 'increases'],
  properties: {
    vendor_name: { type: 'string', description: 'Company that issued the prices (the manufacturer or distributor), not Pruett.' },
    document_type: {
      type: 'string',
      enum: ['price_list', 'quote', 'order_confirmation', 'invoice', 'increase_notice', 'other'],
      description: 'other = not about product prices (statements, payroll, marketing, receipts).',
    },
    effective_date: { type: ['string', 'null'], description: 'YYYY-MM-DD when these prices take effect (or the order/quote date). null if unknown.' },
    price_columns: {
      type: 'array',
      description: 'Every price column in the document. Use short stable snake_case keys. For volume or color tiers, prefix the tier: e.g. "20k_unit", "20k_carton", "2_5k_carton", "color_sq", "deluxe_sq", "premium_pc".',
      items: {
        type: 'object', required: ['key', 'label', 'unit'],
        properties: {
          key: { type: 'string' },
          label: { type: 'string', description: 'Column heading as printed, including tier' },
          unit: { type: 'string', enum: ['piece', 'carton', 'box', 'square', 'square_or_piece', 'bundle', 'roll', 'lb', 'foot', 'uom', 'other'] },
        },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object', required: ['item_nos', 'description', 'prices'],
        properties: {
          item_nos: {
            type: 'array', items: { type: 'string' },
            description: 'Vendor item/product numbers exactly as printed (keep trailing "-" if printed). If one row lists several ("40 & 41", "56A/56B"), list each.',
          },
          description: { type: 'string' },
          uom: { type: ['string', 'null'], description: 'Unit of measure printed for the row (EA, PK, CTN, SQ, ...)' },
          pack_qty: { type: ['number', 'null'], description: 'Pieces per carton/box/pack for this row, if printed (e.g. "Pcs/Ctn 16", "(4/Pk-140)" -> 4).' },
          prices: { type: 'object', additionalProperties: { type: 'number' }, description: 'price_column key -> number. Omit blank, "-", "call" cells.' },
        },
      },
    },
    increases: {
      type: 'array',
      description: 'For notices that announce a percentage change instead of listing prices.',
      items: {
        type: 'object', required: ['product_line', 'pct'],
        properties: {
          product_line: { type: 'string' },
          pct: { type: 'number', description: 'Percent change, e.g. 6 for +6%, -3 for a 3% decrease' },
          effective_date: { type: ['string', 'null'] },
        },
      },
    },
    notes: { type: 'string', description: 'Anything a buyer should know: freight surcharges, items priced monthly, terms.' },
  },
};

const SYSTEM = `You read vendor pricing documents for Pruett Home Improvement Supply, a building-materials store in West Plains, MO
(siding, soffit, gutters, trim, LP SmartSide / DiamondKote, CertainTeed, Rollex, Lynch Aluminum...).
Extract every priced row exactly as printed. Never invent or round numbers. Never skip rows because they look similar.
Rows that say "call for pricing" or are blank are left out. Section headings are not items.
Report what the document says; do not convert units yourself.`;

function fileBlock({ buffer, mimeType, filename }) {
  const name = filename || 'document';
  if (/pdf/i.test(mimeType) || /\.pdf$/i.test(name)) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  if (/^image\/(png|jpe?g|gif|webp)$/i.test(mimeType)) {
    return { type: 'image', source: { type: 'base64', media_type: mimeType.toLowerCase().replace('jpg', 'jpeg'), data: buffer.toString('base64') } };
  }
  return null;
}

async function spreadsheetText(buffer, filename) {
  const { headers, rows } = await readSheet(buffer, filename);
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [headers, ...rows.slice(0, 6000)].map((r) => r.map(esc).join(',')).join('\n');
}

/**
 * Extract one document.
 * input: { buffer, mimeType, filename } and/or { emailText, subject, sender }
 */
export async function extractDocument(input) {
  const content = [];
  const block = input.buffer ? fileBlock(input) : null;
  if (block) content.push(block);
  else if (input.buffer) {
    content.push({ type: 'text', text: `Spreadsheet "${input.filename}" as CSV:\n\n${await spreadsheetText(input.buffer, input.filename)}` });
  }
  const context = [
    input.sender && `From: ${input.sender}`,
    input.subject && `Subject: ${input.subject}`,
    input.filename && `Attachment: ${input.filename}`,
    input.emailText && `Email text:\n${String(input.emailText).slice(0, 20000)}`,
  ].filter(Boolean).join('\n');
  content.push({ type: 'text', text: `${context}\n\nRecord this document by calling the record_price_document tool (always call it, even for non-price documents).` });

  const stream = claude().messages.stream({
    model: config.anthropicModel,
    max_tokens: 64000,
    system: SYSTEM,
    tools: [{ name: 'record_price_document', description: 'Save the extracted vendor pricing.', input_schema: DOC_SCHEMA }],
    // Newer models don't allow forcing a tool, so we ask for it and fall back to JSON in the text.
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'max_tokens') throw new Error('Document too long to read in one pass — split it and upload the parts');
  return normalizeExtraction(toolInput(msg, 'record_price_document'));
}

/** The tool call's input, or JSON the model wrote as text instead. */
function toolInput(msg, name) {
  const use = msg.content.find((c) => c.type === 'tool_use' && (!c.name || c.name === name));
  if (use) return use.input;
  const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* fall through */ }
  }
  throw new Error('Claude did not return structured data');
}

/** Clean up what the model returned so the matcher can trust the shape. */
export function normalizeExtraction(d) {
  const out = {
    vendor_name: String(d.vendor_name || '').trim() || 'Unknown vendor',
    document_type: d.document_type || 'other',
    effective_date: /^\d{4}-\d{2}-\d{2}$/.test(d.effective_date || '') ? d.effective_date : null,
    price_columns: Array.isArray(d.price_columns) ? d.price_columns.filter((c) => c && c.key) : [],
    items: [],
    increases: Array.isArray(d.increases) ? d.increases.filter((x) => x && Number.isFinite(Number(x.pct))).map((x) => ({
      product_line: String(x.product_line || ''), pct: Number(x.pct),
      effective_date: /^\d{4}-\d{2}-\d{2}$/.test(x.effective_date || '') ? x.effective_date : null,
    })) : [],
    notes: d.notes || '',
  };
  for (const it of d.items || []) {
    const nos = (Array.isArray(it.item_nos) ? it.item_nos : [it.item_nos]).map((n) => String(n ?? '').trim()).filter(Boolean);
    const prices = {};
    for (const [k, v] of Object.entries(it.prices || {})) {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
      if (Number.isFinite(n) && n > 0) prices[k] = n;
    }
    if (!nos.length && !it.description) continue;
    out.items.push({ item_nos: nos, description: String(it.description || '').trim(), uom: it.uom || null, pack_qty: Number(it.pack_qty) > 0 ? Number(it.pack_qty) : null, prices });
  }
  return out;
}

/**
 * Ask Claude whether doubtful pairs are really the same product, and how many vendor units make one Pruett unit.
 * pairs: [{ id, vendor: {item_no, description, uom, pack_qty, price}, pruett: {sku, description, cost} }]
 * returns Map id -> { same: boolean, divisor: number|null, reason }
 */
export async function verifyMatches(pairs) {
  if (!pairs.length) return new Map();
  const msg = await claude().messages.create({
    model: config.anthropicModel,
    max_tokens: 8000,
    system: 'You check whether a vendor price-sheet line and a store inventory item are the same product (same size, gauge, profile; colors may differ if the vendor price covers all colors). Be strict: different dimensions or different product types are not the same.',
    tools: [{
      name: 'record_verdicts',
      description: 'Verdict for each pair',
      input_schema: {
        type: 'object', required: ['verdicts'],
        properties: {
          verdicts: {
            type: 'array',
            items: {
              type: 'object', required: ['id', 'same'],
              properties: {
                id: { type: 'string' },
                same: { type: 'boolean' },
                divisor: { type: ['number', 'null'], description: 'If same: how many store units are in one vendor price unit (e.g. vendor prices a 4-pack, store sells each -> 4). 1 if equal.' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
    }],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: `${JSON.stringify(pairs)}\n\nCall record_verdicts with a verdict for every pair.` }],
  });
  return new Map((toolInput(msg, 'record_verdicts')?.verdicts || []).map((v) => [String(v.id), v]));
}
