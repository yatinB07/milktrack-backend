import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('route migration defines the tenant-safe soft-delete aggregate without later routing tables', async () => {
  const sql = await readFile(new URL('../prisma/migrations/202607200006_routes/migration.sql', import.meta.url), 'utf8');
  for (const fragment of [
    'CREATE TABLE routes', 'routes_vendor_id_id_key', 'routes_vendor_id_id_delivery_slot_id_key',
    'routes_delivery_slot_fkey', 'routes_code_check', 'routes_name_check', 'routes_status_check',
    'routes_version_check', 'routes_deletion_check', 'routes_vendor_id_code_visible_key',
    'ENABLE ROW LEVEL SECURITY', 'FORCE ROW LEVEL SECURITY', 'routes_tenant_policy',
    'GRANT SELECT, INSERT', 'GRANT UPDATE',
  ]) assert.match(sql, new RegExp(fragment.replaceAll(' ', '\\s+'), 'u'));
  assert.doesNotMatch(sql, /GRANT DELETE|CREATE TABLE route_stop|CREATE TABLE route_assignment/u);
});
