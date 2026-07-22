BEGIN;

LOCK TABLE delivery_events, leave_requests, notifications, scheduled_deliveries
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE delivery_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE leave_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_deliveries NO FORCE ROW LEVEL SECURITY;

ALTER TABLE leave_revision_subscriptions
  ADD COLUMN selected BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM delivery_events
    WHERE (latitude IS NULL) <> (longitude IS NULL)
  ) THEN
    RAISE EXCEPTION 'Cannot replace delivery coordinate constraint: half-pair coordinate evidence exists';
  END IF;
END $$;

ALTER TABLE delivery_events
  DROP CONSTRAINT delivery_events_replaced_event_fkey,
  DROP CONSTRAINT delivery_events_event_type_check,
  DROP CONSTRAINT delivery_events_coordinates_check,
  ADD CONSTRAINT delivery_events_vendor_delivery_id_key
    UNIQUE (vendor_id, scheduled_delivery_id, id),
  ADD CONSTRAINT delivery_events_replaced_event_fkey
    FOREIGN KEY (vendor_id, scheduled_delivery_id, replaced_event_id)
    REFERENCES delivery_events(vendor_id, scheduled_delivery_id, id),
  ADD CONSTRAINT delivery_events_event_type_check
    CHECK (event_type IN ('scheduled','delivered','skipped_by_customer','skipped_by_agent','missed')),
  ADD CONSTRAINT delivery_events_coordinates_check CHECK (
    (latitude IS NULL AND longitude IS NULL)
    OR (latitude IS NOT NULL AND longitude IS NOT NULL
      AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
  ),
  ADD CONSTRAINT delivery_events_reversal_check CHECK (
    event_type <> 'scheduled' OR (
      source IN ('customer','vendor_admin') AND actor_user_id IS NOT NULL
      AND reason_code = 'customer_leave_reversed' AND replaced_event_id IS NOT NULL
      AND actual_quantity IS NULL AND note IS NULL AND latitude IS NULL AND longitude IS NULL
    )
  );

UPDATE notifications AS n
SET payload = jsonb_set(n.payload, '{householdId}', to_jsonb(l.household_id::text))
FROM leave_requests AS l
WHERE n.vendor_id = l.vendor_id
  AND n.type IN ('leave_accepted', 'leave_rejected')
  AND n.payload->>'leaveRequestId' = l.id::text;

UPDATE notifications AS n
SET payload = jsonb_set(n.payload, '{householdId}', to_jsonb(d.household_id::text))
FROM scheduled_deliveries AS d
WHERE n.vendor_id = d.vendor_id
  AND n.type IN ('agent_skip', 'delivery_corrected')
  AND n.payload->>'scheduledDeliveryId' = d.id::text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM notifications
    WHERE type IN ('leave_accepted', 'leave_rejected', 'agent_skip', 'delivery_corrected')
      AND (
        NOT payload ? 'householdId'
        OR jsonb_typeof(payload->'householdId') <> 'string'
        OR payload->>'householdId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
  ) THEN
    RAISE EXCEPTION 'Cannot enforce notification household payload: an existing Phase 3 notification cannot be resolved';
  END IF;
END $$;

ALTER TABLE notifications ADD CONSTRAINT notifications_household_payload_check CHECK (
  payload ? 'householdId'
  AND jsonb_typeof(payload->'householdId') = 'string'
  AND payload->>'householdId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
);

CREATE INDEX notifications_vendor_recipient_household_cursor_idx
  ON notifications (vendor_id, recipient_user_id, (payload->>'householdId'), created_at DESC, id DESC);

ALTER TABLE delivery_events FORCE ROW LEVEL SECURITY;
ALTER TABLE leave_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_deliveries FORCE ROW LEVEL SECURITY;

COMMIT;
