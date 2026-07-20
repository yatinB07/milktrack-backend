import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('scheduled delivery migration owns duplicate-safe retained tenant schedules', async () => {
  const sql = await readFile(new URL('../prisma/migrations/202607200009_scheduled_deliveries/migration.sql', import.meta.url), 'utf8');
  for (const fragment of [
    'CREATE TABLE scheduled_deliveries',
    'scheduled_deliveries_business_key',
    'UNIQUE (vendor_id, subscription_id, service_date, delivery_slot_id)',
    'scheduled_deliveries_subscription_household_fkey',
    'scheduled_deliveries_revision_projection_fkey',
    'scheduled_deliveries_route_assignment_fkey',
    'FOREIGN KEY (vendor_id, route_assignment_id, service_date, delivery_slot_id)',
    'scheduled_deliveries_finalized_subscription_date_key',
    'WHERE finalized_at IS NOT NULL',
    'cancellation_reason IS NOT NULL',
    'planned_quantity > 0',
    'version > 0',
    'ENABLE ROW LEVEL SECURITY',
    'FORCE ROW LEVEL SECURITY',
    'GRANT SELECT, INSERT',
    'GRANT UPDATE (',
  ]) assert.ok(sql.includes(fragment), `migration must include ${fragment}`);
  assert.doesNotMatch(sql, /GRANT DELETE|schedule_generation_runs|delivery_events/u);
});

void test('Prisma publishes scheduled deliveries without S2 run models', async () => {
  const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  assert.match(schema, /model ScheduledDelivery \{/u);
  assert.match(schema, /@@unique\(\[vendorId, subscriptionId, serviceDate, deliverySlotId\]/u);
  assert.doesNotMatch(schema, /model ScheduleGenerationRun/u);
});
