ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_vendor_id_id_household_id_key
  UNIQUE (vendor_id, id, household_id);

ALTER TABLE subscription_revisions
  ADD CONSTRAINT subscription_revisions_schedule_projection_key
  UNIQUE (vendor_id, subscription_id, id, product_id, unit_id, delivery_slot_id);

ALTER TABLE route_assignments
  ADD CONSTRAINT route_assignments_schedule_projection_key
  UNIQUE (vendor_id, id, service_date, delivery_slot_id);

CREATE TABLE scheduled_deliveries (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  subscription_revision_id UUID NOT NULL,
  household_id UUID NOT NULL,
  product_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  delivery_slot_id UUID NOT NULL,
  route_assignment_id UUID,
  service_date DATE NOT NULL,
  planned_quantity NUMERIC(18,3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  cancelled_at TIMESTAMPTZ(6),
  cancellation_reason TEXT,
  finalized_at TIMESTAMPTZ(6),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT scheduled_deliveries_pkey PRIMARY KEY (id),
  CONSTRAINT scheduled_deliveries_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT scheduled_deliveries_business_key
    UNIQUE (vendor_id, subscription_id, service_date, delivery_slot_id),
  CONSTRAINT scheduled_deliveries_vendor_id_fkey
    FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT scheduled_deliveries_subscription_household_fkey
    FOREIGN KEY (vendor_id, subscription_id, household_id)
    REFERENCES subscriptions(vendor_id, id, household_id),
  CONSTRAINT scheduled_deliveries_household_fkey
    FOREIGN KEY (vendor_id, household_id) REFERENCES households(vendor_id, id),
  CONSTRAINT scheduled_deliveries_revision_projection_fkey
    FOREIGN KEY (
      vendor_id, subscription_id, subscription_revision_id,
      product_id, unit_id, delivery_slot_id
    ) REFERENCES subscription_revisions(
      vendor_id, subscription_id, id, product_id, unit_id, delivery_slot_id
    ),
  CONSTRAINT scheduled_deliveries_product_unit_fkey
    FOREIGN KEY (vendor_id, product_id, unit_id)
    REFERENCES products(vendor_id, id, default_unit_id),
  CONSTRAINT scheduled_deliveries_delivery_slot_fkey
    FOREIGN KEY (vendor_id, delivery_slot_id) REFERENCES delivery_slots(vendor_id, id),
  CONSTRAINT scheduled_deliveries_route_assignment_fkey
    FOREIGN KEY (vendor_id, route_assignment_id, service_date, delivery_slot_id)
    REFERENCES route_assignments(vendor_id, id, service_date, delivery_slot_id),
  CONSTRAINT scheduled_deliveries_status_consistency_check CHECK (
    (status = 'scheduled' AND cancelled_at IS NULL AND cancellation_reason IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL
      AND cancellation_reason IS NOT NULL
      AND cancellation_reason = btrim(cancellation_reason)
      AND char_length(cancellation_reason) BETWEEN 3 AND 500)
  ),
  CONSTRAINT scheduled_deliveries_planned_quantity_check CHECK (planned_quantity > 0),
  CONSTRAINT scheduled_deliveries_version_check CHECK (version > 0)
);

CREATE UNIQUE INDEX scheduled_deliveries_finalized_subscription_date_key
  ON scheduled_deliveries (vendor_id, subscription_id, service_date)
  WHERE finalized_at IS NOT NULL;
CREATE INDEX scheduled_deliveries_vendor_date_status_id_idx
  ON scheduled_deliveries (vendor_id, service_date, status, id);
CREATE INDEX scheduled_deliveries_assignment_date_status_id_idx
  ON scheduled_deliveries (vendor_id, route_assignment_id, service_date, status, id);
CREATE INDEX scheduled_deliveries_household_date_status_id_idx
  ON scheduled_deliveries (vendor_id, household_id, service_date, status, id);

ALTER TABLE scheduled_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_deliveries_tenant_policy ON scheduled_deliveries
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

GRANT SELECT, INSERT ON scheduled_deliveries TO milktrack_app;
GRANT UPDATE (
  subscription_revision_id, household_id, product_id, unit_id,
  route_assignment_id, planned_quantity, status, cancelled_at,
  cancellation_reason, version, updated_at
) ON scheduled_deliveries TO milktrack_app;
