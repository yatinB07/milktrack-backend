CREATE TYPE "CatalogStatus" AS ENUM ('active', 'inactive');

CREATE TABLE units (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  decimal_scale INTEGER NOT NULL,
  status "CatalogStatus" NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT units_pkey PRIMARY KEY (id),
  CONSTRAINT units_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT units_vendor_id_code_key UNIQUE (vendor_id, code),
  CONSTRAINT units_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT units_code_check CHECK (code ~ '^[A-Z0-9_-]{2,32}$'),
  CONSTRAINT units_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT units_decimal_scale_check CHECK (decimal_scale BETWEEN 0 AND 3)
);

CREATE TABLE products (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  default_unit_id UUID NOT NULL,
  status "CatalogStatus" NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ(6),
  deleted_by UUID,
  deletion_reason TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT products_pkey PRIMARY KEY (id),
  CONSTRAINT products_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT products_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT products_default_unit_fkey FOREIGN KEY (vendor_id, default_unit_id)
    REFERENCES units(vendor_id, id),
  CONSTRAINT products_code_check CHECK (code ~ '^[A-Z0-9_-]{2,32}$'),
  CONSTRAINT products_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 160),
  CONSTRAINT products_version_check CHECK (version > 0),
  CONSTRAINT products_deletion_check CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_reason IS NULL)
    OR (
      deleted_at IS NOT NULL
      AND deleted_by IS NOT NULL
      AND deletion_reason IS NOT NULL
      AND char_length(btrim(deletion_reason)) BETWEEN 1 AND 500
    )
  )
);

CREATE INDEX units_vendor_id_status_created_at_id_idx
  ON units (vendor_id, status, created_at DESC, id DESC);
CREATE UNIQUE INDEX products_non_deleted_code_key
  ON products (vendor_id, code) WHERE deleted_at IS NULL;
CREATE INDEX products_vendor_id_status_created_at_id_idx
  ON products (vendor_id, status, created_at DESC, id DESC) WHERE deleted_at IS NULL;

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE units FORCE ROW LEVEL SECURITY;
CREATE POLICY units_tenant_policy ON units
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY products_tenant_policy ON products
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON units, products TO milktrack_app;
