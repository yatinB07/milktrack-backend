CREATE TABLE route_assignments (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  route_id UUID NOT NULL,
  delivery_slot_id UUID NOT NULL,
  agent_membership_id UUID NOT NULL,
  service_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned',
  created_by UUID NOT NULL,
  updated_by UUID NOT NULL,
  cancelled_at TIMESTAMPTZ(6),
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT route_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT route_assignments_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT route_assignments_vendor_id_route_id_service_date_key UNIQUE (vendor_id, route_id, service_date),
  CONSTRAINT route_assignments_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT route_assignments_route_fkey FOREIGN KEY (vendor_id, route_id, delivery_slot_id)
    REFERENCES routes(vendor_id, id, delivery_slot_id),
  CONSTRAINT route_assignments_agent_membership_fkey FOREIGN KEY (vendor_id, agent_membership_id)
    REFERENCES vendor_memberships(vendor_id, id),
  CONSTRAINT route_assignments_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT route_assignments_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id),
  CONSTRAINT route_assignments_status_consistency_check CHECK (
    (status = 'assigned' AND cancelled_at IS NULL AND cancellation_reason IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL
      AND cancellation_reason IS NOT NULL
      AND cancellation_reason = btrim(cancellation_reason)
      AND char_length(cancellation_reason) BETWEEN 3 AND 500)
  )
);

CREATE UNIQUE INDEX route_assignments_agent_slot_date_assigned_key
  ON route_assignments (vendor_id, agent_membership_id, delivery_slot_id, service_date)
  WHERE status = 'assigned';
CREATE INDEX route_assignments_vendor_route_date_id_idx
  ON route_assignments (vendor_id, route_id, service_date DESC, id DESC);
CREATE INDEX route_assignments_vendor_agent_date_id_idx
  ON route_assignments (vendor_id, agent_membership_id, service_date DESC, id DESC)
  WHERE status = 'assigned';

ALTER TABLE route_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY route_assignments_tenant_policy ON route_assignments
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

GRANT SELECT, INSERT ON route_assignments TO milktrack_app;
GRANT UPDATE (agent_membership_id, status, updated_by, cancelled_at, cancellation_reason, updated_at)
  ON route_assignments TO milktrack_app;
