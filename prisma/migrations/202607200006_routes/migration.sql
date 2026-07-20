CREATE TABLE routes (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  delivery_slot_id UUID NOT NULL,
  status "CatalogStatus" NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ(6),
  deleted_by UUID,
  deletion_reason TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT routes_pkey PRIMARY KEY (id),
  CONSTRAINT routes_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT routes_vendor_id_id_delivery_slot_id_key UNIQUE (vendor_id, id, delivery_slot_id),
  CONSTRAINT routes_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT routes_delivery_slot_fkey FOREIGN KEY (vendor_id, delivery_slot_id)
    REFERENCES delivery_slots(vendor_id, id),
  CONSTRAINT routes_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES users(id),
  CONSTRAINT routes_code_check CHECK (code ~ '^[A-Z0-9_-]{2,32}$'),
  CONSTRAINT routes_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT routes_status_check CHECK (status IN ('active', 'inactive')),
  CONSTRAINT routes_version_check CHECK (version > 0),
  CONSTRAINT routes_deletion_check CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL AND deletion_reason IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL
      AND deletion_reason = btrim(deletion_reason) AND char_length(deletion_reason) BETWEEN 3 AND 500)
  )
);

CREATE UNIQUE INDEX routes_vendor_id_code_visible_key
  ON routes (vendor_id, code) WHERE deleted_at IS NULL;
CREATE INDEX routes_vendor_id_status_created_at_id_idx
  ON routes (vendor_id, status, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX routes_vendor_id_delivery_slot_id_status_idx
  ON routes (vendor_id, delivery_slot_id, status) WHERE deleted_at IS NULL;

ALTER TABLE routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes FORCE ROW LEVEL SECURITY;
CREATE POLICY routes_tenant_policy ON routes
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

GRANT SELECT, INSERT ON routes TO milktrack_app;
GRANT UPDATE (name, status, version, deleted_at, deleted_by, deletion_reason, updated_at)
  ON routes TO milktrack_app;
