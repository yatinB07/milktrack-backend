ALTER TABLE vendors
  ADD COLUMN late_leave_policy TEXT NOT NULL DEFAULT 'approval',
  ADD COLUMN capture_agent_location_evidence BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT vendors_late_leave_policy_check
    CHECK (late_leave_policy IN ('reject', 'approval'));

ALTER TABLE scheduled_deliveries
  DROP CONSTRAINT scheduled_deliveries_status_consistency_check,
  ADD CONSTRAINT scheduled_deliveries_status_consistency_check CHECK (
    (status = 'scheduled' AND cancelled_at IS NULL AND cancellation_reason IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL
      AND cancellation_reason = btrim(cancellation_reason)
      AND char_length(cancellation_reason) BETWEEN 3 AND 500
      AND finalized_at IS NULL)
    OR (status IN ('delivered', 'skipped_by_customer', 'skipped_by_agent', 'missed')
      AND cancelled_at IS NULL AND cancellation_reason IS NULL AND finalized_at IS NOT NULL)
  );

DROP INDEX scheduled_deliveries_finalized_subscription_date_key;
CREATE UNIQUE INDEX scheduled_deliveries_finalized_occurrence_key
  ON scheduled_deliveries (vendor_id, subscription_id, service_date, delivery_slot_id)
  WHERE finalized_at IS NOT NULL;

CREATE TABLE leave_requests (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  household_id UUID NOT NULL,
  status TEXT NOT NULL,
  current_revision_id UUID,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT leave_requests_pkey PRIMARY KEY (id),
  CONSTRAINT leave_requests_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT leave_requests_vendor_id_id_current_revision_id_key
    UNIQUE (vendor_id, id, current_revision_id),
  CONSTRAINT leave_requests_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT leave_requests_household_fkey FOREIGN KEY (vendor_id, household_id)
    REFERENCES households(vendor_id, id),
  CONSTRAINT leave_requests_status_check CHECK (
    status IN ('pending_approval', 'partially_pending', 'accepted', 'rejected', 'cancelled')
  ),
  CONSTRAINT leave_requests_version_check CHECK (version > 0)
);

CREATE TABLE leave_request_revisions (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  leave_request_id UUID NOT NULL,
  action TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  source TEXT NOT NULL,
  created_by UUID NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  decided_by UUID,
  decided_at TIMESTAMPTZ(6),
  decision_reason TEXT,
  previous_revision_id UUID,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT leave_request_revisions_pkey PRIMARY KEY (id),
  CONSTRAINT leave_request_revisions_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT leave_request_revisions_vendor_id_leave_request_id_id_key
    UNIQUE (vendor_id, leave_request_id, id),
  CONSTRAINT leave_request_revisions_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT leave_request_revisions_request_fkey FOREIGN KEY (vendor_id, leave_request_id)
    REFERENCES leave_requests(vendor_id, id),
  CONSTRAINT leave_request_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT leave_request_revisions_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES users(id),
  CONSTRAINT leave_request_revisions_previous_fkey
    FOREIGN KEY (vendor_id, leave_request_id, previous_revision_id)
    REFERENCES leave_request_revisions(vendor_id, leave_request_id, id),
  CONSTRAINT leave_request_revisions_action_check CHECK (action IN ('create', 'amend', 'cancel')),
  CONSTRAINT leave_request_revisions_range_check CHECK (start_date <= end_date),
  CONSTRAINT leave_request_revisions_source_check CHECK (source IN ('customer', 'vendor_admin', 'system')),
  CONSTRAINT leave_request_revisions_status_check CHECK (
    status IN ('pending_approval', 'partially_pending', 'accepted', 'rejected', 'cancelled')
  ),
  CONSTRAINT leave_request_revisions_note_check CHECK (
    note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 500)
  ),
  CONSTRAINT leave_request_revisions_decision_check CHECK (
    (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decision_reason = btrim(decision_reason)
      AND char_length(decision_reason) BETWEEN 3 AND 500)
  )
);

ALTER TABLE leave_requests
  ADD CONSTRAINT leave_requests_current_revision_fkey
    FOREIGN KEY (vendor_id, id, current_revision_id)
    REFERENCES leave_request_revisions(vendor_id, leave_request_id, id);

CREATE TABLE leave_revision_subscriptions (
  vendor_id UUID NOT NULL,
  leave_request_revision_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  CONSTRAINT leave_revision_subscriptions_pkey
    PRIMARY KEY (vendor_id, leave_request_revision_id, subscription_id),
  CONSTRAINT leave_revision_subscriptions_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT leave_revision_subscriptions_revision_fkey
    FOREIGN KEY (vendor_id, leave_request_revision_id)
    REFERENCES leave_request_revisions(vendor_id, id),
  CONSTRAINT leave_revision_subscriptions_subscription_fkey
    FOREIGN KEY (vendor_id, subscription_id) REFERENCES subscriptions(vendor_id, id)
);

CREATE TABLE leave_occurrence_decisions (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  leave_request_revision_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  service_date DATE NOT NULL,
  delivery_slot_id UUID NOT NULL,
  previous_effective_status TEXT NOT NULL,
  requested_effective_status TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by UUID,
  decided_at TIMESTAMPTZ(6),
  decision_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT leave_occurrence_decisions_pkey PRIMARY KEY (id),
  CONSTRAINT leave_occurrence_decisions_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT leave_occurrence_decisions_occurrence_key
    UNIQUE (vendor_id, leave_request_revision_id, subscription_id, service_date, delivery_slot_id),
  CONSTRAINT leave_occurrence_decisions_revision_subscription_fkey
    FOREIGN KEY (vendor_id, leave_request_revision_id, subscription_id)
    REFERENCES leave_revision_subscriptions(vendor_id, leave_request_revision_id, subscription_id),
  CONSTRAINT leave_occurrence_decisions_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT leave_occurrence_decisions_slot_fkey
    FOREIGN KEY (vendor_id, delivery_slot_id) REFERENCES delivery_slots(vendor_id, id),
  CONSTRAINT leave_occurrence_decisions_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES users(id),
  CONSTRAINT leave_occurrence_decisions_effective_status_check CHECK (
    previous_effective_status IN ('scheduled', 'skipped_by_customer')
    AND requested_effective_status IN ('scheduled', 'skipped_by_customer')
    AND previous_effective_status <> requested_effective_status
  ),
  CONSTRAINT leave_occurrence_decisions_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT leave_occurrence_decisions_decision_check CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL
      AND decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 3 AND 500)
    OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL
      AND decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 3 AND 500)
  ),
  CONSTRAINT leave_occurrence_decisions_version_check CHECK (version > 0)
);

CREATE TABLE delivery_events (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  scheduled_delivery_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_user_id UUID,
  occurred_at TIMESTAMPTZ(6) NOT NULL,
  received_at TIMESTAMPTZ(6) NOT NULL,
  actual_quantity NUMERIC(18,3),
  reason_code TEXT,
  note TEXT,
  latitude NUMERIC(8,6),
  longitude NUMERIC(9,6),
  replaced_event_id UUID,
  payload_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT delivery_events_pkey PRIMARY KEY (id),
  CONSTRAINT delivery_events_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT delivery_events_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT delivery_events_scheduled_delivery_fkey
    FOREIGN KEY (vendor_id, scheduled_delivery_id) REFERENCES scheduled_deliveries(vendor_id, id),
  CONSTRAINT delivery_events_actor_user_fkey FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT delivery_events_replaced_event_fkey
    FOREIGN KEY (vendor_id, replaced_event_id) REFERENCES delivery_events(vendor_id, id),
  CONSTRAINT delivery_events_event_type_check CHECK (
    event_type IN ('delivered', 'skipped_by_customer', 'skipped_by_agent', 'missed')
  ),
  CONSTRAINT delivery_events_source_check CHECK (
    source IN ('system', 'customer', 'delivery_agent', 'vendor_admin')
  ),
  CONSTRAINT delivery_events_quantity_check CHECK (
    (event_type = 'delivered' AND actual_quantity > 0)
    OR (event_type <> 'delivered' AND actual_quantity IS NULL)
  ),
  CONSTRAINT delivery_events_note_check CHECK (
    note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 500)
  ),
  CONSTRAINT delivery_events_coordinates_check CHECK (
    (latitude IS NULL AND longitude IS NULL)
    OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
  ),
  CONSTRAINT delivery_events_replaced_event_check CHECK (
    replaced_event_id IS NULL OR replaced_event_id <> id
  ),
  CONSTRAINT delivery_events_payload_version_check CHECK (payload_version > 0)
);

CREATE TABLE delivery_price_snapshots (
  vendor_id UUID NOT NULL,
  scheduled_delivery_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  pricing_level TEXT NOT NULL,
  source_price_id UUID NOT NULL,
  source_price_type TEXT NOT NULL,
  resolved_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT delivery_price_snapshots_pkey PRIMARY KEY (scheduled_delivery_id),
  CONSTRAINT delivery_price_snapshots_vendor_id_scheduled_delivery_id_key
    UNIQUE (vendor_id, scheduled_delivery_id),
  CONSTRAINT delivery_price_snapshots_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT delivery_price_snapshots_scheduled_delivery_fkey
    FOREIGN KEY (vendor_id, scheduled_delivery_id) REFERENCES scheduled_deliveries(vendor_id, id),
  CONSTRAINT delivery_price_snapshots_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT delivery_price_snapshots_pricing_level_check CHECK (
    pricing_level IN ('global', 'customer_specific')
  ),
  CONSTRAINT delivery_price_snapshots_source_type_check CHECK (
    source_price_type IN ('global_price', 'customer_price_override')
  ),
  CONSTRAINT delivery_price_snapshots_source_pair_check CHECK (
    (pricing_level = 'global' AND source_price_type = 'global_price')
    OR (pricing_level = 'customer_specific' AND source_price_type = 'customer_price_override')
  )
);

CREATE TABLE notifications (
  id UUID NOT NULL,
  vendor_id UUID NOT NULL,
  recipient_user_id UUID NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  read_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_vendor_id_id_key UNIQUE (vendor_id, id),
  CONSTRAINT notifications_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES vendors(id),
  CONSTRAINT notifications_recipient_user_fkey FOREIGN KEY (recipient_user_id) REFERENCES users(id),
  CONSTRAINT notifications_type_check CHECK (
    type IN ('leave_accepted', 'leave_rejected', 'agent_skip', 'delivery_corrected')
  ),
  CONSTRAINT notifications_payload_object_check CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX leave_requests_vendor_household_created_at_id_idx
  ON leave_requests (vendor_id, household_id, created_at DESC, id DESC);
CREATE INDEX leave_request_revisions_vendor_request_created_at_id_idx
  ON leave_request_revisions (vendor_id, leave_request_id, created_at DESC, id DESC);
CREATE INDEX leave_occurrence_decisions_vendor_status_service_date_id_idx
  ON leave_occurrence_decisions (vendor_id, status, service_date, id);
CREATE INDEX delivery_events_vendor_delivery_created_at_id_idx
  ON delivery_events (vendor_id, scheduled_delivery_id, created_at DESC, id DESC);
CREATE INDEX delivery_events_vendor_created_at_id_idx
  ON delivery_events (vendor_id, created_at DESC, id DESC);
CREATE INDEX notifications_vendor_recipient_created_at_id_idx
  ON notifications (vendor_id, recipient_user_id, created_at DESC, id DESC);

ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_requests_tenant_policy ON leave_requests
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE leave_request_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_request_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_request_revisions_tenant_policy ON leave_request_revisions
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE leave_revision_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_revision_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_revision_subscriptions_tenant_policy ON leave_revision_subscriptions
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE leave_occurrence_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_occurrence_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_occurrence_decisions_tenant_policy ON leave_occurrence_decisions
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_events FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_events_tenant_policy ON delivery_events
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE delivery_price_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_price_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_price_snapshots_tenant_policy ON delivery_price_snapshots
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_tenant_policy ON notifications
  USING (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid)
  WITH CHECK (vendor_id = NULLIF(current_setting('app.vendor_id', true), '')::uuid);

GRANT SELECT, INSERT ON leave_requests, leave_request_revisions, leave_revision_subscriptions,
  leave_occurrence_decisions, delivery_events, delivery_price_snapshots, notifications TO milktrack_app;
GRANT UPDATE (status, current_revision_id, version, updated_at) ON leave_requests TO milktrack_app;
GRANT UPDATE (status, decided_by, decided_at, decision_reason, version, updated_at)
  ON leave_occurrence_decisions TO milktrack_app;
GRANT UPDATE (read_at) ON notifications TO milktrack_app;
REVOKE UPDATE ON scheduled_deliveries FROM milktrack_app;
GRANT UPDATE (
  subscription_revision_id, household_id, product_id, unit_id, route_assignment_id,
  planned_quantity, status, cancelled_at, cancellation_reason, finalized_at, version, updated_at
) ON scheduled_deliveries TO milktrack_app;
