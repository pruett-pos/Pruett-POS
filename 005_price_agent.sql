-- AI price agent: incoming vendor documents, learned vendor-item links, richer batch items.

CREATE TABLE price_documents (
  id             serial PRIMARY KEY,
  vendor_id      integer REFERENCES vendors(id),
  source         text NOT NULL CHECK (source IN ('email', 'upload')),
  source_ref     text,                 -- email Message-ID
  sender         text,
  subject        text,
  filename       text,
  mime_type      text,
  file_data      bytea,                -- original file, for viewing from the approval screen
  received_at    timestamptz NOT NULL DEFAULT now(),
  document_type  text,                 -- price_list | quote | order_confirmation | increase_notice | other
  effective_date date,
  status         text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'extracted', 'batched', 'ignored', 'failed')),
  error          text,
  extracted      jsonb,
  created_by     integer REFERENCES users(id)
);
CREATE INDEX price_documents_received_idx ON price_documents(received_at DESC);
CREATE UNIQUE INDEX price_documents_email_idx ON price_documents(source_ref, filename) WHERE source = 'email';

-- What the agent has learned: vendor item -> Pruett product, and which price column/unit to use.
CREATE TABLE vendor_item_links (
  id             serial PRIMARY KEY,
  vendor_id      integer NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  vendor_item_no text NOT NULL,
  product_id     integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price_key      text,                 -- e.g. 'piece', '2_5k_carton', 'deluxe_sq'
  divisor        numeric(10,3) NOT NULL DEFAULT 1,   -- e.g. carton price / 16 pieces
  blocked        boolean NOT NULL DEFAULT false,     -- "not a match" — never suggest again
  confirmed_by   integer REFERENCES users(id),
  confirmed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, vendor_item_no, product_id)
);
CREATE INDEX vendor_item_links_product_idx ON vendor_item_links(product_id);

ALTER TABLE vendors ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';
ALTER TABLE vendors ADD COLUMN price_prefix text;   -- preferred price column family, e.g. Rollex '2_5k'

ALTER TABLE price_batches
  ADD COLUMN document_id    integer REFERENCES price_documents(id),
  ADD COLUMN kind           text NOT NULL DEFAULT 'sheet' CHECK (kind IN ('sheet', 'percent')),
  ADD COLUMN effective_date date,
  ADD COLUMN notified_at    timestamptz;
ALTER TABLE price_batches DROP CONSTRAINT price_batches_status_check;
ALTER TABLE price_batches ADD CONSTRAINT price_batches_status_check
  CHECK (status IN ('pending', 'approved', 'partially_approved', 'rejected', 'scheduled', 'empty'));

ALTER TABLE price_batch_items
  ADD COLUMN vendor_item_no   text,
  ADD COLUMN vendor_desc      text,
  ADD COLUMN price_key        text,
  ADD COLUMN divisor          numeric(10,3) NOT NULL DEFAULT 1,
  ADD COLUMN increase_pct     numeric(6,2),
  ADD COLUMN applied_at       timestamptz,
  ADD COLUMN decided_by       integer REFERENCES users(id),
  ADD COLUMN decided_at       timestamptz;
ALTER TABLE price_batch_items DROP CONSTRAINT price_batch_items_decision_check;
ALTER TABLE price_batch_items ADD CONSTRAINT price_batch_items_decision_check
  CHECK (decision IN ('pending', 'approved', 'rejected', 'not_a_match'));
CREATE INDEX price_batch_items_batch_idx ON price_batch_items(batch_id);
