import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
test.after(() => Promise.all([runtime.end(), owner.end()]));

type Fixture = Readonly<{
  vendorId: string;
  householdId: string;
  deliveryId: string;
}>;

async function asTenant(vendorId: string, work: (client: pg.PoolClient) => Promise<void>) {
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.vendor_id', $1, true)", [vendorId]);
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function rejects(
  client: pg.PoolClient,
  text: string,
  values: unknown[],
  expected: RegExp,
) {
  await client.query('SAVEPOINT expected_failure');
  await assert.rejects(client.query(text, values), expected);
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
}

async function fixture(label: string): Promise<Fixture> {
  const vendorId = randomUUID();
  const userId = randomUUID();
  const householdId = randomUUID();
  const unitId = randomUUID();
  const productId = randomUUID();
  const slotId = randomUUID();
  const subscriptionId = randomUUID();
  const revisionId = randomUUID();
  const deliveryId = randomUUID();
  await owner.query(`INSERT INTO users (id, display_name, updated_at) VALUES ($1, $2, now())`, [userId, `${label} user`]);
  await owner.query(`INSERT INTO vendors (id, code, legal_name, display_name, status, timezone, currency, skip_cutoff_minutes, billing_day, updated_at) VALUES ($1, $2, $2, $2, 'active', 'Asia/Kolkata', 'INR', 0, 1, now())`, [vendorId, `phase3-${label}-${vendorId.slice(0, 8)}`]);
  await owner.query(`INSERT INTO households (id, vendor_id, account_number, name, address_line_1, city, region, postal_code, country_code, updated_at) VALUES ($1, $2, $3, $3, 'Road', 'Pune', 'MH', '411001', 'IN', now())`, [householdId, vendorId, label]);
  await owner.query(`INSERT INTO units (id, vendor_id, code, name, decimal_scale, updated_at) VALUES ($1, $2, 'LITRE', 'Litre', 3, now())`, [unitId, vendorId]);
  await owner.query(`INSERT INTO products (id, vendor_id, code, name, default_unit_id, updated_at) VALUES ($1, $2, 'MILK', 'Milk', $3, now())`, [productId, vendorId, unitId]);
  await owner.query(`INSERT INTO delivery_slots (id, vendor_id, code, name, start_local_time, end_local_time, updated_at) VALUES ($1, $2, 'AM', 'Morning', '06:00', '09:00', now())`, [slotId, vendorId]);
  await owner.query(`INSERT INTO subscriptions (id, vendor_id, household_id, updated_at) VALUES ($1, $2, $3, now())`, [subscriptionId, vendorId, householdId]);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO subscription_revisions (id, vendor_id, subscription_id, product_id, unit_id, delivery_slot_id, quantity, status, effective_from, created_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, 'active', '2029-01-01', $7, now())`, [revisionId, vendorId, subscriptionId, productId, unitId, slotId, userId]);
    await client.query(`INSERT INTO subscription_revision_weekdays (vendor_id, subscription_revision_id, weekday) VALUES ($1, $2, 1)`, [vendorId, revisionId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await owner.query(`INSERT INTO scheduled_deliveries (id, vendor_id, subscription_id, subscription_revision_id, household_id, product_id, unit_id, delivery_slot_id, service_date, planned_quantity, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2030-01-01', 1, now())`, [deliveryId, vendorId, subscriptionId, revisionId, householdId, productId, unitId, slotId]);
  return { vendorId, householdId, deliveryId };
}

async function cleanup(values: readonly Fixture[]) {
  for (const value of values) {
    await owner.query('DELETE FROM notifications WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM delivery_price_snapshots WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM delivery_events WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM leave_occurrence_decisions WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM leave_revision_subscriptions WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM leave_request_revisions WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM leave_requests WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM scheduled_deliveries WHERE vendor_id=$1', [value.vendorId]);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM subscription_revision_weekdays WHERE vendor_id=$1', [value.vendorId]);
      await client.query('DELETE FROM subscription_revisions WHERE vendor_id=$1', [value.vendorId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await owner.query('DELETE FROM subscriptions WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM products WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM units WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM delivery_slots WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM households WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM vendors WHERE id=$1', [value.vendorId]);
  }
}

void test('Phase 3 tables enforce tenant isolation, immutable history, and delivery evidence constraints', async () => {
  const [a, b] = await Promise.all([fixture('a'), fixture('b')]);
  const leaveId = randomUUID();
  const eventId = randomUUID();
  try {
    await asTenant(a.vendorId, async (client) => {
      await client.query(`INSERT INTO leave_requests (id, vendor_id, household_id, status, updated_at) VALUES ($1, $2, $3, 'accepted', now())`, [leaveId, a.vendorId, a.householdId]);
      assert.equal((await client.query('SELECT id FROM leave_requests WHERE id=$1', [leaveId])).rowCount, 1);
      assert.equal((await client.query('SELECT id FROM leave_requests WHERE vendor_id=$1', [b.vendorId])).rowCount, 0);
      await rejects(client, `INSERT INTO leave_requests (id, vendor_id, household_id, status, updated_at) VALUES ($1, $2, $3, 'accepted', now())`, [randomUUID(), a.vendorId, b.householdId], /foreign key|violates row-level security/u);
      await client.query(`INSERT INTO delivery_events (id, vendor_id, scheduled_delivery_id, event_type, source, occurred_at, received_at) VALUES ($1, $2, $3, 'skipped_by_agent', 'delivery_agent', now(), now())`, [eventId, a.vendorId, a.deliveryId]);
      await rejects(client, 'UPDATE delivery_events SET source=$1 WHERE id=$2', ['system', eventId], /permission denied/u);
      await rejects(client, 'DELETE FROM delivery_events WHERE id=$1', [eventId], /permission denied/u);
      await client.query(`INSERT INTO delivery_price_snapshots (vendor_id, scheduled_delivery_id, amount_minor, currency, pricing_level, source_price_id, source_price_type, resolved_at) VALUES ($1, $2, 1000, 'INR', 'global', $3, 'global_price', now())`, [a.vendorId, a.deliveryId, randomUUID()]);
      await rejects(client, `INSERT INTO delivery_price_snapshots (vendor_id, scheduled_delivery_id, amount_minor, currency, pricing_level, source_price_id, source_price_type, resolved_at) VALUES ($1, $2, 1000, 'INR', 'global', $3, 'global_price', now())`, [a.vendorId, a.deliveryId, randomUUID()], /duplicate key/u);
      await rejects(client, `INSERT INTO delivery_events (id, vendor_id, scheduled_delivery_id, event_type, source, occurred_at, received_at, latitude) VALUES ($1, $2, $3, 'skipped_by_agent', 'delivery_agent', now(), now(), 91)`, [randomUUID(), a.vendorId, a.deliveryId], /delivery_events_coordinates_check/u);
      await rejects(client, "UPDATE scheduled_deliveries SET status='delivered' WHERE id=$1", [a.deliveryId], /scheduled_deliveries_status_consistency_check/u);
    });
  } finally {
    await cleanup([a, b]);
  }
});
