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
  assert.doesNotMatch(sql, /GRANT DELETE|CREATE TABLE scheduled_deliveries/u);
});
