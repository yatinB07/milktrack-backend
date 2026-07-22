import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('Phase 3 migration creates tenant-safe append-only leave and delivery history', async () => {
  const sql = await readFile(
    new URL('../prisma/migrations/202607220001_phase_3_online_delivery/migration.sql', import.meta.url),
    'utf8',
  );
  for (const fragment of [
    'ADD COLUMN late_leave_policy',
    'ADD COLUMN capture_agent_location_evidence',
    'CREATE TABLE leave_requests',
    'CREATE TABLE leave_request_revisions',
    'CREATE TABLE leave_revision_subscriptions',
    'CREATE TABLE leave_occurrence_decisions',
    'CREATE TABLE delivery_events',
    'CREATE TABLE delivery_price_snapshots',
    'CREATE TABLE notifications',
    'ENABLE ROW LEVEL SECURITY',
    'FORCE ROW LEVEL SECURITY',
    'GRANT SELECT, INSERT',
  ]) assert.ok(sql.includes(fragment), `migration must contain ${fragment}`);
  assert.doesNotMatch(sql, /CREATE TABLE (idempotency_records|sync_conflicts|outbox_messages|notification_attempts)/u);
  assert.doesNotMatch(sql, /GRANT DELETE ON (leave_request_revisions|delivery_events|delivery_price_snapshots|notifications)/u);
});

void test('Phase 3 corrections migrate strict leave, delivery, and notification contracts forward', async () => {
  const sql = await readFile(
    new URL('../prisma/migrations/202607230001_phase_3_final_corrections/migration.sql', import.meta.url),
    'utf8',
  );
  for (const fragment of [
    'BEGIN;',
    'ADD COLUMN selected BOOLEAN NOT NULL DEFAULT true',
    'LOCK TABLE delivery_events, leave_requests, notifications, scheduled_deliveries',
    'IN ACCESS EXCLUSIVE MODE',
    'ALTER TABLE notifications NO FORCE ROW LEVEL SECURITY',
    'ALTER TABLE notifications FORCE ROW LEVEL SECURITY',
    "event_type IN ('scheduled','delivered','skipped_by_customer','skipped_by_agent','missed')",
    'ADD CONSTRAINT delivery_events_reversal_check',
    'ADD CONSTRAINT delivery_events_vendor_delivery_id_key',
    'FOREIGN KEY (vendor_id, scheduled_delivery_id, replaced_event_id)',
    'latitude IS NOT NULL AND longitude IS NOT NULL',
    "jsonb_set(n.payload, '{householdId}'",
    'notifications_household_payload_check',
    'notifications_vendor_recipient_household_cursor_idx',
    "(payload->>'householdId')",
    'COMMIT;',
  ]) assert.ok(sql.includes(fragment), `correction migration must contain ${fragment}`);
  assert.equal(sql.trimStart().startsWith('BEGIN;'), true);
  assert.equal(sql.trimEnd().endsWith('COMMIT;'), true);
  assert.match(sql, /\(latitude IS NULL\) <> \(longitude IS NULL\)/u);
  assert.match(sql, /RAISE EXCEPTION[^;]+coordinate/isu);
  assert.match(sql, /FROM leave_requests/u);
  assert.match(sql, /FROM scheduled_deliveries/u);
  assert.match(sql, /RAISE EXCEPTION[^;]+notification/isu);
  assert.doesNotMatch(sql, /UPDATE delivery_events[\s\S]+SET (?:latitude|longitude)/u);
});
