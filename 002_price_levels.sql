-- Price levels (Paladin "pricing plans"), per-item target margins, review flags, customer extras.

CREATE TABLE price_levels (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  -- 'discount'  : retail minus pct %
  -- 'cost_plus' : cost plus pct % (COST plan = cost + 0%)
  kind       text NOT NULL DEFAULT 'discount' CHECK (kind IN ('discount', 'cost_plus')),
  pct        numeric(6,2) CHECK (pct IS NULL OR (pct >= 0 AND pct <= 300)),   -- NULL = not set yet (charges retail)
  sort       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Pruett's Paladin plans. Percentages are NOT known yet (NULL) except COST.
INSERT INTO price_levels (name, kind, pct, sort) VALUES
  ('CONTRACTOR',   'discount',  NULL, 10),
  ('Contractor 2', 'discount',  NULL, 20),
  ('Builder',      'discount',  NULL, 30),
  ('Wholesale',    'discount',  NULL, 40),
  ('Pruett',       'discount',  NULL, 50),
  ('COST',         'cost_plus', 0,    60);

ALTER TABLE customers ADD COLUMN price_level_id integer REFERENCES price_levels(id);
UPDATE customers SET price_level_id = (SELECT id FROM price_levels WHERE name = 'CONTRACTOR') WHERE tier = 'contractor';
ALTER TABLE customers DROP COLUMN tier;
ALTER TABLE customers
  ADD COLUMN require_po       boolean NOT NULL DEFAULT false,
  ADD COLUMN checkout_note    text,
  ADD COLUMN email_statements boolean NOT NULL DEFAULT false,
  ADD COLUMN paladin_id       text UNIQUE;

-- sales.tier now holds the price level name ('Retail', 'CONTRACTOR', ...)
ALTER TABLE sales ALTER COLUMN tier SET DEFAULT 'Retail';
UPDATE sales SET tier = CASE WHEN tier = 'contractor' THEN 'CONTRACTOR' ELSE 'Retail' END;

-- Item-level target margin: when set it wins over the category margin.
-- Imported items get their current Paladin margin so prices don't move on day one.
ALTER TABLE products
  ADD COLUMN target_margin_pct numeric(7,3) CHECK (target_margin_pct IS NULL OR (target_margin_pct >= 0 AND target_margin_pct < 100)),
  ADD COLUMN description2      text,
  ADD COLUMN needs_review      text;    -- reason, NULL when fine
CREATE INDEX products_review_idx ON products((needs_review IS NOT NULL)) WHERE needs_review IS NOT NULL;
CREATE UNIQUE INDEX products_paladin_idx ON products(paladin_id) WHERE paladin_id IS NOT NULL;

DELETE FROM settings WHERE key = 'contractor_discount_pct';
