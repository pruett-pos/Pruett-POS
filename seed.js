import { fileURLToPath } from 'node:url';
import { pool, query, tx } from './db.js';
import { hashPassword } from './auth.js';
import { migrate } from './migrate.js';
import { createProduct } from './services/catalog.js';
import { setSetting } from './settings.js';

// Starter categories. These margins are PLACEHOLDERS — set Pruett's real margins in Settings → Categories.
export const STARTER_CATEGORIES = [
  ['Lumber & Sheet Goods', 25], ['Roofing', 28], ['Siding & Trim', 30], ['Windows & Doors', 25], ['Insulation', 30],
  ['Hardware', 45], ['Fasteners', 50], ['Paint & Sundries', 40], ['Plumbing', 40], ['Electrical', 40], ['Tools', 35],
  ['Concrete & Masonry', 30], ['Lawn & Garden', 40],
];

/** First boot: create the admin account from ADMIN_USERNAME / ADMIN_PASSWORD and starter categories. */
export async function ensureAdmin() {
  const { rows: [{ n }] } = await query('SELECT count(*) AS n FROM users');
  if (n > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error('First start: set ADMIN_PASSWORD (10+ characters) so the admin account can be created.');
  }
  await query(`INSERT INTO users (username, name, role, password_hash) VALUES ($1, $2, 'admin', $3)`,
    [username, process.env.ADMIN_NAME || 'Administrator', await hashPassword(password)]);
  const { rows: [{ c }] } = await query('SELECT count(*) AS c FROM categories');
  if (c === 0) {
    for (const [name, m] of STARTER_CATEGORIES) await query('INSERT INTO categories (name, margin_pct) VALUES ($1,$2)', [name, m]);
  }
  console.log(`Created admin user "${username}".`);
}

/** Training data: a handful of products and customers. */
export async function seedDemo() {
  await tx(async (db) => {
    const { rows: cats } = await db.query('SELECT id, name FROM categories');
    const cat = (n) => cats.find((c) => c.name === n)?.id ?? null;
    const { rows: [v] } = await db.query(`INSERT INTO vendors (name) VALUES ('Demo Distributor') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
    const items = [
      ['2X4-8', '012345000017', '2x4x8 SPF Stud', 'Lumber & Sheet Goods', 389, 400],
      ['OSB-716', '012345000024', '7/16 OSB 4x8 Sheet', 'Lumber & Sheet Goods', 1450, 120],
      ['GAF-HDZ-CH', '012345000031', 'GAF Timberline HDZ Charcoal (bundle)', 'Roofing', 3600, 200],
      ['SYN-UL-10', '012345000048', 'Synthetic Underlayment 10sq Roll', 'Roofing', 8900, 30],
      ['DRIP-WH', '012345000055', 'Drip Edge White 10ft', 'Roofing', 520, 150],
      ['VS-D4-WH', '012345000062', 'Vinyl Siding D4 White (square)', 'Siding & Trim', 9500, 40],
      ['JCH-WH', '012345000079', 'J-Channel White 12ft6in', 'Siding & Trim', 610, 100],
      ['NAIL-RF-114', '012345000086', 'Roofing Nails 1-1/4in Coil 7200ct', 'Fasteners', 4200, 25],
      ['SCR-DK-3', '012345000093', 'Deck Screws #10 x 3in 5lb', 'Fasteners', 2700, 40],
      ['CAULK-WH', '012345000109', 'Siliconized Acrylic Caulk White', 'Paint & Sundries', 310, 200],
    ];
    for (const [sku, upc, description, c, cost, onHand] of items) {
      const { rows } = await db.query('SELECT 1 FROM products WHERE sku = $1', [sku]);
      if (rows.length) continue;
      await createProduct(db, { sku, upc, description, category_id: cat(c), vendor_id: v.id, cost_cents: cost, on_hand: onHand, reorder_point: Math.round(onHand / 5), reorder_qty: onHand }, null);
    }
    const { rows: [{ n }] } = await db.query('SELECT count(*) AS n FROM customers');
    if (n === 0) {
      await db.query(`INSERT INTO customers (name, company, phone, price_level_id, charge_account, credit_limit_cents, terms_days)
        VALUES ('A&A Crew Account', 'A&A Quality Roofing LLC', '', (SELECT id FROM price_levels WHERE name = 'CONTRACTOR'), true, 2500000, 30),
               ('Walk-in Test Customer', NULL, '555-0100', NULL, false, 0, 30)`);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    await migrate();
    await ensureAdmin();
    if (process.argv.includes('--demo')) {
      await seedDemo();
      if (process.argv.includes('--tax')) await setSetting({ query }, 'tax_rate_pct', Number(process.argv[process.argv.indexOf('--tax') + 1]));
      console.log('Demo data loaded.');
    }
    await pool.end();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
