import { query } from './db.js';

export const DEFAULT_SETTINGS = {
  store: { name: 'Pruett Home Improvement Supply', address: '', phone: '' },
  tax_rate_pct: null,              // must be set by the owner before selling
  price_rounding_cents: 5,
  default_margin_pct: 35,          // used for products with no category
  receipt_footer: 'Thank you for shopping local!',
  require_manager_for_price_override: true,
  large_change_flag_pct: 10,       // price agent flags changes bigger than this
};

export async function getSettings(db = { query }) {
  const { rows } = await db.query('SELECT key, value FROM settings');
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) s[r.key] = r.value;
  return s;
}

export async function setSetting(db, key, value) {
  if (!(key in DEFAULT_SETTINGS)) throw Object.assign(new Error(`Unknown setting ${key}`), { status: 400 });
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
