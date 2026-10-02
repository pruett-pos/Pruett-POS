-- Pruett POS: initial schema
-- All money is stored as integer cents. Percentages are stored as numeric (e.g. 25.00 = 25%).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- Settings & users ----------

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  name          text NOT NULL,
  email         text,
  role          text NOT NULL CHECK (role IN ('admin', 'manager', 'cashier')),
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token      text PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- ---------- Catalog ----------

CREATE TABLE categories (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  margin_pct numeric(5,2) NOT NULL CHECK (margin_pct >= 0 AND margin_pct < 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendors (
  id           serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  email        text,          -- address price sheets arrive from (used by the price agent)
  account_no   text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id             serial PRIMARY KEY,
  sku            text NOT NULL UNIQUE,
  upc            text,
  description    text NOT NULL,
  category_id    integer REFERENCES categories(id),
  vendor_id      integer REFERENCES vendors(id),
  vendor_sku     text,
  unit           text NOT NULL DEFAULT 'EA',
  cost_cents     integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  retail_cents   integer NOT NULL DEFAULT 0 CHECK (retail_cents >= 0),
  -- When true the retail price was set by hand and is NOT recalculated from cost/margin.
  price_override boolean NOT NULL DEFAULT false,
  taxable        boolean NOT NULL DEFAULT true,
  on_hand        numeric(12,3) NOT NULL DEFAULT 0,
  reorder_point  numeric(12,3),
  reorder_qty    numeric(12,3),
  location       text,
  active         boolean NOT NULL DEFAULT true,
  paladin_id     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_upc_idx ON products(upc) WHERE upc IS NOT NULL;
CREATE INDEX products_vendor_sku_idx ON products(vendor_id, vendor_sku);
CREATE INDEX products_desc_trgm ON products USING gin (description gin_trgm_ops);

-- Extra barcodes (case packs, alternate UPCs)
CREATE TABLE product_barcodes (
  barcode    text PRIMARY KEY,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE price_history (
  id                serial PRIMARY KEY,
  product_id        integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  old_cost_cents    integer,
  new_cost_cents    integer,
  old_retail_cents  integer,
  new_retail_cents  integer,
  source            text NOT NULL,        -- 'manual', 'import', 'category_margin', 'price_agent'
  batch_id          integer,
  user_id           integer REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_history_product_idx ON price_history(product_id, created_at DESC);

-- ---------- Customers ----------

CREATE TABLE customers (
  id                  serial PRIMARY KEY,
  name                text NOT NULL,
  company             text,
  phone               text,
  email               text,
  address             text,
  tier                text NOT NULL DEFAULT 'retail' CHECK (tier IN ('retail', 'contractor')),
  charge_account      boolean NOT NULL DEFAULT false,
  credit_limit_cents  integer NOT NULL DEFAULT 0,
  terms_days          integer NOT NULL DEFAULT 30,
  balance_cents       integer NOT NULL DEFAULT 0,   -- open charge-account balance
  tax_exempt          boolean NOT NULL DEFAULT false,
  tax_exempt_cert     text,
  qbo_customer_id     text,
  notes               text,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_name_trgm ON customers USING gin ((name || ' ' || coalesce(company, '') || ' ' || coalesce(phone, '')) gin_trgm_ops);

-- ---------- Sales ----------

CREATE SEQUENCE sale_number_seq START 100001;

CREATE TABLE sales (
  id               serial PRIMARY KEY,
  number           integer NOT NULL UNIQUE DEFAULT nextval('sale_number_seq'),
  kind             text NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale', 'return')),
  status           text NOT NULL CHECK (status IN ('pending', 'completed', 'voided')),
  original_sale_id integer REFERENCES sales(id),     -- for returns
  customer_id      integer REFERENCES customers(id),
  user_id          integer NOT NULL REFERENCES users(id),
  register         text,
  tier             text NOT NULL DEFAULT 'retail',
  po_number        text,
  subtotal_cents   integer NOT NULL,
  tax_cents        integer NOT NULL,
  total_cents      integer NOT NULL,
  tax_rate_pct     numeric(6,3) NOT NULL,
  tax_exempt       boolean NOT NULL DEFAULT false,
  notes            text,
  qbo_sync_status  text NOT NULL DEFAULT 'pending' CHECK (qbo_sync_status IN ('pending', 'synced', 'error', 'skip')),
  qbo_ref          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  voided_at        timestamptz,
  voided_by        integer REFERENCES users(id)
);
CREATE INDEX sales_created_idx ON sales(created_at DESC);
CREATE INDEX sales_customer_idx ON sales(customer_id);

CREATE TABLE sale_lines (
  id                  serial PRIMARY KEY,
  sale_id             integer NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  original_line_id    integer REFERENCES sale_lines(id),  -- for return lines
  product_id          integer REFERENCES products(id),
  sku                 text,
  description         text NOT NULL,
  qty                 numeric(12,3) NOT NULL,
  unit_price_cents    integer NOT NULL,     -- price actually charged
  list_price_cents    integer NOT NULL,     -- retail before tier / manual discount
  cost_cents          integer NOT NULL,
  taxable             boolean NOT NULL,
  line_total_cents    integer NOT NULL,
  price_overridden_by integer REFERENCES users(id)
);
CREATE INDEX sale_lines_sale_idx ON sale_lines(sale_id);
CREATE INDEX sale_lines_original_idx ON sale_lines(original_line_id);

CREATE TABLE payments (
  id                 serial PRIMARY KEY,
  sale_id            integer NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method             text NOT NULL CHECK (method IN ('cash', 'check', 'card', 'charge')),
  amount_cents       integer NOT NULL,       -- negative for refunds
  tendered_cents     integer,                -- cash handed over
  change_cents       integer,
  check_number       text,
  stripe_payment_intent text,
  stripe_refund      text,
  card_brand         text,
  card_last4         text,
  status             text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_sale_idx ON payments(sale_id);
CREATE UNIQUE INDEX payments_pi_idx ON payments(stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL AND amount_cents > 0;

-- Card payments in progress on a Stripe reader (before the sale is completed)
CREATE TABLE card_attempts (
  id                    serial PRIMARY KEY,
  payment_intent_id     text NOT NULL UNIQUE,
  reader_id             text,
  amount_cents          integer NOT NULL,
  status                text NOT NULL DEFAULT 'processing',  -- processing | succeeded | failed | canceled | used
  failure_message       text,
  card_brand            text,
  card_last4            text,
  user_id               integer REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------- Inventory ----------

CREATE TABLE inventory_movements (
  id          serial PRIMARY KEY,
  product_id  integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty_change  numeric(12,3) NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('sale', 'return', 'void', 'receive', 'adjust', 'import')),
  ref         text,
  user_id     integer REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_product_idx ON inventory_movements(product_id, created_at DESC);

-- ---------- Price agent (phase 3; tables created now) ----------

CREATE TABLE price_batches (
  id            serial PRIMARY KEY,
  vendor_id     integer REFERENCES vendors(id),
  source        text NOT NULL,           -- 'email', 'upload'
  source_ref    text,                    -- email message id / filename
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'partially_approved', 'rejected')),
  summary       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_by   integer REFERENCES users(id),
  reviewed_at   timestamptz
);

CREATE TABLE price_batch_items (
  id                 serial PRIMARY KEY,
  batch_id           integer NOT NULL REFERENCES price_batches(id) ON DELETE CASCADE,
  product_id         integer REFERENCES products(id),
  match_method       text,               -- 'vendor_sku', 'upc', 'sku', 'ai_description', 'unmatched'
  match_confidence   numeric(4,3),
  vendor_line        jsonb NOT NULL,     -- raw row from the vendor sheet
  old_cost_cents     integer,
  new_cost_cents     integer,
  old_retail_cents   integer,
  new_retail_cents   integer,
  flags              text[] NOT NULL DEFAULT '{}',
  decision           text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected'))
);

-- ---------- Audit ----------

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    integer REFERENCES users(id),
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
