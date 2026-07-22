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
