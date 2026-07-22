import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { ApplicationError } from '../src/common/errors/application.error.js';
import { DefaultDeliveryLeaveProjection } from '../src/delivery/application/delivery-leave.projection.js';
import { PrismaDeliveryStore } from '../src/delivery/infrastructure/prisma-delivery.store.js';
import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';

const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const store = new PrismaDeliveryStore();
test.after(() => Promise.all([prisma.$disconnect(), owner.end()]));

type Fixture = Readonly<{
  vendorId: string;
  householdId: string;
  otherHouseholdId: string;
  deliveryId: string;
  actorUserId: string;
}>;

async function fixture(label: string): Promise<Fixture> {
  const vendorId = randomUUID(); const actorUserId = randomUUID(); const householdId = randomUUID();
  const otherHouseholdId = randomUUID(); const unitId = randomUUID(); const productId = randomUUID();
  const slotId = randomUUID(); const subscriptionId = randomUUID(); const revisionId = randomUUID(); const deliveryId = randomUUID();
  await owner.query(`INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())`, [actorUserId, `${label} actor`]);
  await owner.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$2,$2,'active','Asia/Kolkata','INR',0,1,now())`, [vendorId, `delivery-${label}-${vendorId.slice(0, 8)}`]);
  for (const [id, account] of [[householdId, 'A'], [otherHouseholdId, 'B']] as const) {
    await owner.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,$3,$3,'Road','Pune','MH','411001','IN',now())`, [id, vendorId, `${label}-${account}`]);
  }
  await owner.query(`INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,'LITRE','Litre',3,now())`, [unitId, vendorId]);
  await owner.query(`INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,'MILK','Milk',$3,now())`, [productId, vendorId, unitId]);
  await owner.query(`INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'AM','Morning','06:00','09:00',now())`, [slotId, vendorId]);
  await owner.query(`INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())`, [subscriptionId, vendorId, householdId]);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [revisionId, vendorId, subscriptionId, productId, unitId, slotId, actorUserId]);
    await client.query(`INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,1)`, [vendorId, revisionId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  await owner.query(`INSERT INTO scheduled_deliveries(id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,service_date,planned_quantity,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'2030-01-01',1,now())`, [deliveryId, vendorId, subscriptionId, revisionId, householdId, productId, unitId, slotId]);
  return { vendorId, householdId, otherHouseholdId, deliveryId, actorUserId };
}

async function cleanup(value: Fixture) {
  const { vendorId } = value;
  await owner.query('DELETE FROM delivery_price_snapshots WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM delivery_events WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM scheduled_deliveries WHERE vendor_id=$1', [vendorId]);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM subscription_revision_weekdays WHERE vendor_id=$1', [vendorId]);
    await client.query('DELETE FROM subscription_revisions WHERE vendor_id=$1', [vendorId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  await owner.query('DELETE FROM subscriptions WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM products WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM units WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM delivery_slots WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM households WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]);
  await owner.query('DELETE FROM users WHERE id=$1', [value.actorUserId]);
}

void test('delivery store appends before final projection, fences stale versions, and protects snapshots', async () => {
  const value = await fixture('store');
  const now = new Date('2030-01-01T06:30:00.000Z');
  try {
    const result = await transactions.run(value.vendorId, (tx) => store.appendFinalOutcome(tx, {
      id: randomUUID(), vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId, expectedVersion: 1,
      outcome: 'delivered', source: 'delivery_agent', actorUserId: value.actorUserId,
      occurredAt: now, receivedAt: now, actualQuantity: '1.500',
    }));
    assert.equal(result.currentStatus, 'delivered');
    assert.equal(result.version, 2);
    await transactions.run(value.vendorId, (tx) => store.createPriceSnapshot(tx, {
      vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId, amountMinor: '1000', currency: 'INR',
      pricingLevel: 'global', sourcePriceId: randomUUID(), sourcePriceType: 'global_price', resolvedAt: now,
    }));
    const detail = await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId));
    assert.equal(detail.currentStatus, 'delivered');
    assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0]?.actualQuantity, '1.5');
    assert.equal(detail.snapshot?.amountMinor, '1000');
    await assert.rejects(
      transactions.run(value.vendorId, (tx) => store.appendFinalOutcome(tx, {
        id: randomUUID(), vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId, expectedVersion: 1,
        outcome: 'missed', source: 'delivery_agent', actorUserId: value.actorUserId, occurredAt: now, receivedAt: now,
      })),
      (error: unknown) => error instanceof ApplicationError && error.code === 'STALE_VERSION',
    );
    await assert.rejects(
      transactions.run(value.vendorId, (tx) => store.createPriceSnapshot(tx, {
        vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId, amountMinor: '1000', currency: 'INR',
        pricingLevel: 'global', sourcePriceId: randomUUID(), sourcePriceType: 'global_price', resolvedAt: now,
      })),
      (error: unknown) => error instanceof ApplicationError && error.code === 'DELIVERY_SNAPSHOT_EXISTS',
    );
    await assert.rejects(
      transactions.run(value.vendorId, (tx) => store.getCustomerDetail(tx, value.vendorId, value.otherHouseholdId, value.deliveryId)),
      (error: unknown) => error instanceof ApplicationError && error.code === 'DELIVERY_NOT_FOUND',
    );
  } finally { await cleanup(value); }
});

void test('leave projection changes only its own final outcome and rolls all writes back with its transaction', async () => {
  const value = await fixture('leave');
  try {
    const key = await transactions.run(value.vendorId, async (tx) => {
      const record = await store.getVendorDetail(tx, value.vendorId, value.deliveryId);
      return { vendorId: value.vendorId, subscriptionId: record.subscriptionId, serviceDate: record.serviceDate, deliverySlotId: record.deliverySlotId };
    });
    const projection = new DefaultDeliveryLeaveProjection(store);
    await transactions.run(value.vendorId, (tx) => projection.applyCustomerLeave(tx, key, value.actorUserId));
    assert.equal((await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId))).currentStatus, 'skipped_by_customer');
    await transactions.run(value.vendorId, (tx) => projection.reverseCustomerLeave(tx, key, value.actorUserId));
    assert.equal((await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId))).currentStatus, 'scheduled');
    await assert.rejects(transactions.run(value.vendorId, async (tx) => {
      await store.appendFinalOutcome(tx, {
        id: randomUUID(), vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId, expectedVersion: 3,
        outcome: 'missed', source: 'delivery_agent', actorUserId: value.actorUserId,
        occurredAt: new Date(), receivedAt: new Date(), reasonCode: 'other', note: 'Road closed',
      });
      throw new Error('rollback');
    }), /rollback/u);
    assert.equal((await owner.query<{ count: number }>('SELECT count(*)::int AS count FROM delivery_events WHERE vendor_id=$1', [value.vendorId])).rows[0]?.count, 2);
  } finally { await cleanup(value); }
});
