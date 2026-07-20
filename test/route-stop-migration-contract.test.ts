import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('route stop migration defines database-owned effective projections and exclusions without assignments', async () => {
  const sql = await readFile(new URL('../prisma/migrations/202607200007_route_stop_plans/migration.sql', import.meta.url), 'utf8');
  for (const fragment of [
    'CREATE TABLE route_stop_plans', 'CREATE TABLE route_stops',
    'route_stop_plans_vendor_id_route_id_id_key', 'route_stop_plans_supersession_fkey',
    'DEFERRABLE INITIALLY DEFERRED', 'route_stops_plan_fkey', 'route_stops_household_fkey',
    'derive_route_stop_plan_fields', 'propagate_route_stop_plan_fields',
    'route_stops_no_sequence_overlap', 'route_stops_no_household_slot_overlap',
    'daterange(effective_from, effective_to', 'WHERE (superseded_at IS NULL)',
    'ENABLE ROW LEVEL SECURITY', 'FORCE ROW LEVEL SECURITY', 'GRANT SELECT, INSERT', 'GRANT UPDATE',
  ]) assert.ok(sql.includes(fragment), `migration must include ${fragment}`);
  assert.doesNotMatch(sql, /GRANT DELETE|CREATE TABLE route_assignments|CREATE TABLE scheduled_deliveries/u);
});
