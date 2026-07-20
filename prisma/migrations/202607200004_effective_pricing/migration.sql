CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE products
  ADD CONSTRAINT products_vendor_id_id_default_unit_id_key
  UNIQUE (vendor_id, id, default_unit_id);

CREATE TABLE global_prices (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  product_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  effective_from TIMESTAMPTZ(6) NOT NULL,
  effective_to TIMESTAMPTZ(6),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT global_prices_pkey PRIMARY KEY (id),
  CONSTRAINT global_prices_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT global_prices_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT global_prices_product_unit_fkey FOREIGN KEY (vendor_id, product_id, unit_id)
    REFERENCES products(vendor_id, id, default_unit_id),
  CONSTRAINT global_prices_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT global_prices_amount_minor_check CHECK (amount_minor >= 0),
  CONSTRAINT global_prices_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT global_prices_effective_period_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT global_prices_no_overlap EXCLUDE USING gist (
    vendor_id WITH =,
    product_id WITH =,
    unit_id WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);

CREATE TABLE customer_price_overrides (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  household_id UUID NOT NULL,
  product_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  effective_from TIMESTAMPTZ(6) NOT NULL,
  effective_to TIMESTAMPTZ(6),
  reason TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT customer_price_overrides_pkey PRIMARY KEY (id),
  CONSTRAINT customer_price_overrides_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT customer_price_overrides_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT customer_price_overrides_household_fkey FOREIGN KEY (vendor_id, household_id)
    REFERENCES households(vendor_id, id),
  CONSTRAINT customer_price_overrides_product_unit_fkey FOREIGN KEY (vendor_id, product_id, unit_id)
    REFERENCES products(vendor_id, id, default_unit_id),
  CONSTRAINT customer_price_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT customer_price_overrides_amount_minor_check CHECK (amount_minor >= 0),
  CONSTRAINT customer_price_overrides_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT customer_price_overrides_effective_period_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT customer_price_overrides_reason_check CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT customer_price_overrides_no_overlap EXCLUDE USING gist (
    vendor_id WITH =,
    household_id WITH =,
    product_id WITH =,
    unit_id WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);

CREATE INDEX global_prices_vendor_id_created_at_id_idx
  ON global_prices (vendor_id, created_at DESC, id DESC);
CREATE INDEX global_prices_resolution_idx
  ON global_prices (vendor_id, product_id, unit_id, effective_from DESC, effective_to);
CREATE INDEX customer_price_overrides_vendor_id_household_id_created_at_id_idx
  ON customer_price_overrides (vendor_id, household_id, created_at DESC, id DESC);
CREATE INDEX customer_price_overrides_resolution_idx
  ON customer_price_overrides (vendor_id, household_id, product_id, unit_id, effective_from DESC, effective_to);

ALTER TABLE global_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY global_prices_tenant_policy ON global_prices
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE customer_price_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_price_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_price_overrides_tenant_policy ON customer_price_overrides
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON global_prices, customer_price_overrides TO milktrack_app;
