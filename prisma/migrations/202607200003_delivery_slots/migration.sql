CREATE TABLE delivery_slots (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  start_local_time TIME(0) NOT NULL,
  end_local_time TIME(0) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT delivery_slots_pkey PRIMARY KEY (id),
  CONSTRAINT delivery_slots_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT delivery_slots_vendor_id_code_key UNIQUE (vendor_id, code),
  CONSTRAINT delivery_slots_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT delivery_slots_code_check CHECK (code ~ '^[A-Z0-9_-]{2,32}$'),
  CONSTRAINT delivery_slots_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT delivery_slots_time_range_check CHECK (start_local_time < end_local_time)
);

CREATE INDEX delivery_slots_vendor_id_active_created_at_id_idx
  ON delivery_slots (vendor_id, active, created_at DESC, id DESC);

ALTER TABLE delivery_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_slots_tenant_policy ON delivery_slots
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON delivery_slots TO milktrack_app;
