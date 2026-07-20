import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('route assignment migration defines retained tenant-safe exact-date assignments', async () => {
  const sql = await readFile(new URL('../prisma/migrations/202607200008_route_assignments/migration.sql', import.meta.url), 'utf8');
  for (const fragment of [
    'CREATE TABLE route_assignments', 'route_assignments_route_fkey', 'route_assignments_agent_membership_fkey',
    'UNIQUE (vendor_id, route_id, service_date)', 'route_assignments_agent_slot_date_assigned_key',
    "WHERE status = 'assigned'", 'route_assignments_status_consistency_check',
    'ENABLE ROW LEVEL SECURITY', 'FORCE ROW LEVEL SECURITY', 'GRANT SELECT, INSERT', 'GRANT UPDATE (',
  ]) assert.ok(sql.includes(fragment), `migration must include ${fragment}`);
  assert.match(sql, /status = 'cancelled' AND cancelled_at IS NOT NULL\s+AND cancellation_reason IS NOT NULL/u);
  assert.doesNotMatch(sql, /GRANT DELETE|CREATE TABLE scheduled_deliveries/u);
});

void test('route assignment Prisma relations match migration-owned foreign keys', async () => {
  const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const assignment = schema.match(/model RouteAssignment \{([\s\S]*?)\n\}/u)?.[1] ?? '';
  const deliverySlot = schema.match(/model DeliverySlot \{([\s\S]*?)\n\}/u)?.[1] ?? '';
  assert.doesNotMatch(assignment, /^\s+deliverySlot\s/mu);
  assert.doesNotMatch(deliverySlot, /^\s+routeAssignments\s/mu);
});
