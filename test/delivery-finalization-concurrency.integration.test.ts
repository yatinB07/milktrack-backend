import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { ApplicationError } from '../src/common/errors/application.error.js';
import { PrismaDeliveryStore } from '../src/delivery/infrastructure/prisma-delivery.store.js';
import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';

const prisma = new PrismaService(); const transactions = new PrismaTenantTransactionRunner(prisma);
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL }); const store = new PrismaDeliveryStore();
test.after(() => Promise.all([prisma.$disconnect(), owner.end()]));

void test('concurrent final outcomes commit one event and one typed conflict', async () => {
  const vendorId = randomUUID(); const userId = randomUUID(); const householdId = randomUUID(); const unitId = randomUUID();
  const productId = randomUUID(); const slotId = randomUUID(); const subscriptionId = randomUUID(); const revisionId = randomUUID(); const deliveryId = randomUUID();
  try {
    await owner.query(`INSERT INTO users(id,display_name,updated_at) VALUES($1,'Delivery actor',now())`, [userId]);
    await owner.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$2,$2,'active','Asia/Kolkata','INR',0,1,now())`, [vendorId, `race-${vendorId.slice(0, 8)}`]);
    await owner.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,'A','A','Road','Pune','MH','411001','IN',now())`, [householdId, vendorId]);
    await owner.query(`INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,'LT','Litre',3,now())`, [unitId, vendorId]);
    await owner.query(`INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,'ML','Milk',$3,now())`, [productId, vendorId, unitId]);
    await owner.query(`INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'AM','Morning','06:00','09:00',now())`, [slotId, vendorId]);
    await owner.query(`INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())`, [subscriptionId, vendorId, householdId]);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [revisionId, vendorId, subscriptionId, productId, unitId, slotId, userId]);
      await client.query(`INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,1)`, [vendorId, revisionId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    await owner.query(`INSERT INTO scheduled_deliveries(id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,service_date,planned_quantity,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'2030-01-01',1,now())`, [deliveryId, vendorId, subscriptionId, revisionId, householdId, productId, unitId, slotId]);
    await transactions.run(vendorId, (tx) => store.createPriceSnapshot(tx, {
      vendorId, scheduledDeliveryId: deliveryId, amountMinor: '100', currency: 'INR', pricingLevel: 'global',
      sourcePriceId: randomUUID(), sourcePriceType: 'global_price', resolvedAt: new Date('2030-01-01T00:30:00.000Z'),
    }));
    const attempt = (outcome: 'delivered' | 'missed') => transactions.run(vendorId, (tx) => store.appendFinalOutcome(tx, {
      id: randomUUID(), vendorId, scheduledDeliveryId: deliveryId, expectedVersion: 1, outcome, source: 'delivery_agent', actorUserId: userId,
      occurredAt: new Date('2030-01-01T06:30:00.000Z'), receivedAt: new Date('2030-01-01T06:30:00.000Z'),
      ...(outcome === 'delivered' ? { actualQuantity: '1' } : { reasonCode: 'access_blocked' }),
    }));
    const results = await Promise.allSettled([attempt('delivered'), attempt('missed')]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert(rejected?.reason instanceof ApplicationError);
    assert(['STALE_VERSION', 'DELIVERY_ALREADY_FINALIZED'].includes(rejected.reason.code));
    assert.equal((await owner.query<{ count: number }>('SELECT count(*)::int AS count FROM delivery_events WHERE vendor_id=$1', [vendorId])).rows[0]?.count, 1);
  } finally {
    await owner.query('DELETE FROM delivery_events WHERE vendor_id=$1', [vendorId]); await owner.query('DELETE FROM delivery_price_snapshots WHERE vendor_id=$1', [vendorId]); await owner.query('DELETE FROM scheduled_deliveries WHERE vendor_id=$1', [vendorId]);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM subscription_revision_weekdays WHERE vendor_id=$1', [vendorId]);
      await client.query('DELETE FROM subscription_revisions WHERE vendor_id=$1', [vendorId]);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await owner.query('DELETE FROM subscriptions WHERE vendor_id=$1', [vendorId]); await owner.query('DELETE FROM products WHERE vendor_id=$1', [vendorId]); await owner.query('DELETE FROM units WHERE vendor_id=$1', [vendorId]);
    await owner.query('DELETE FROM delivery_slots WHERE vendor_id=$1', [vendorId]); await owner.query('DELETE FROM households WHERE vendor_id=$1', [vendorId]); await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]); await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  }
});
