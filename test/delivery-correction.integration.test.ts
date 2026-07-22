import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { PrismaAuditWriter } from '../src/audit/infrastructure/prisma-audit.writer.js';
import { DefaultDeliveryCorrectionService } from '../src/delivery/application/delivery-correction.service.js';
import { PrismaDeliveryStore } from '../src/delivery/infrastructure/prisma-delivery.store.js';
import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaNotificationStore } from '../src/notifications/infrastructure/prisma-notification.store.js';
import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import type { TransactionContext } from '../src/common/application/transaction-context.js';

const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const deliveries = new PrismaDeliveryStore();
test.after(() => Promise.all([prisma.$disconnect(), owner.end()]));

type Fixture = Readonly<{ vendorId: string; otherVendorId: string; deliveryId: string; admin: Actor; customerId: string }>;

async function fixture(): Promise<Fixture> {
  const vendorId = randomUUID(); const otherVendorId = randomUUID(); const adminId = randomUUID(); const customerId = randomUUID();
  const adminMembershipId = randomUUID(); const customerMembershipId = randomUUID(); const householdId = randomUUID(); const unitId = randomUUID(); const productId = randomUUID(); const slotId = randomUUID(); const subscriptionId = randomUUID(); const revisionId = randomUUID(); const deliveryId = randomUUID();
  await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now()),($3,$4,now())', [adminId, 'Admin', customerId, 'Customer']);
  for (const id of [vendorId, otherVendorId]) await owner.query("INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$2,$2,'active','Asia/Kolkata','INR',0,1,now())", [id, `correction-${id.slice(0, 8)}`]);
  await owner.query("INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at) VALUES($1,$2,$3,'vendor_administrator','active',now(),now()),($4,$2,$5,'customer','active',now(),now())", [adminMembershipId, vendorId, adminId, customerMembershipId, customerId]);
  await owner.query("INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,'A','A','Road','Pune','MH','411001','IN',now())", [householdId, vendorId]);
  await owner.query("INSERT INTO household_members(id,vendor_id,household_id,customer_membership_id,joined_at,updated_at) VALUES($1,$2,$3,$4,now(),now())", [randomUUID(), vendorId, householdId, customerMembershipId]);
  await owner.query("INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,'LT','Litre',3,now())", [unitId, vendorId]);
  await owner.query("INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,'ML','Milk',$3,now())", [productId, vendorId, unitId]);
  await owner.query("INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'AM','Morning','06:00','09:00',now())", [slotId, vendorId]);
  await owner.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [subscriptionId, vendorId, householdId]);
  await owner.query("INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())", [revisionId, vendorId, subscriptionId, productId, unitId, slotId, adminId]);
  await owner.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,1)', [vendorId, revisionId]);
  await owner.query("INSERT INTO scheduled_deliveries(id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,service_date,planned_quantity,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'2030-01-01',1,now())", [deliveryId, vendorId, subscriptionId, revisionId, householdId, productId, unitId, slotId]);
  await transactions.run(vendorId, (tx) => deliveries.applyCustomerLeave(tx, { vendorId, subscriptionId, serviceDate: '2030-01-01', deliverySlotId: slotId }, customerId));
  return { vendorId, otherVendorId, deliveryId, customerId, admin: { userId: adminId, sessionId: randomUUID(), displayName: 'Admin', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [{ id: adminMembershipId, vendorId, vendorName: 'Milk', role: 'vendor_administrator', status: 'active' }] } };
}

async function cleanup(value: Fixture) {
  await owner.query('DELETE FROM notifications WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM audit_events WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM delivery_price_snapshots WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM delivery_events WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM scheduled_deliveries WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM subscription_revision_weekdays WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM subscription_revisions WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM subscriptions WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM household_members WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM households WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM products WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM units WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM delivery_slots WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM vendor_memberships WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [[value.vendorId, value.otherVendorId]]); await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[value.admin.userId, value.customerId]]);
}

function service(notifications = new PrismaNotificationStore()) {
  return new DefaultDeliveryCorrectionService(
    { execute: <T>(input: { vendorId: string }, work: (tx: TransactionContext) => Promise<T>) => transactions.run(input.vendorId, work) },
    deliveries,
    { resolve: () => Promise.resolve({ amountMinor: '95', currency: 'INR', pricingLevel: 'global' as const, sourcePriceId: randomUUID(), sourcePriceType: 'global_price' as const, resolvedAt: new Date('2030-01-01T00:30:00.000Z') }) },
    new PrismaAuditWriter(), notifications,
  );
}

void test('correction transaction rolls back snapshot, event, projection, audit, and notification on notification failure and stays tenant-scoped', async () => {
  const value = await fixture();
  try {
    const failingNotifications = { append: async (tx: never, notification: Parameters<PrismaNotificationStore['append']>[1]) => { await new PrismaNotificationStore().append(tx, notification); throw new Error('notification unavailable'); } };
    await assert.rejects(requestContextStore.run({ correlationId: randomUUID() }, () => service(failingNotifications as never).correct(value.admin, value.vendorId, value.deliveryId, { expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity: '1.5', reason: 'Verified route sheet' })), /notification unavailable/u);
    assert.deepEqual((await owner.query('SELECT status,version FROM scheduled_deliveries WHERE id=$1', [value.deliveryId])).rows, [{ status: 'skipped_by_customer', version: 2 }]);
    for (const table of ['delivery_events', 'delivery_price_snapshots', 'audit_events', 'notifications']) assert.equal((await owner.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE vendor_id=$1`, [value.vendorId])).rows[0]?.count, table === 'delivery_events' ? 1 : 0);
    await assert.rejects(requestContextStore.run({ correlationId: randomUUID() }, () => service().correct(value.admin, value.otherVendorId, value.deliveryId, { expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity: '1.5', reason: 'Wrong tenant' })), (error: unknown) => (error as { code?: string }).code === 'DELIVERY_NOT_FOUND');
    await requestContextStore.run({ correlationId: randomUUID() }, () => service().correct(value.admin, value.vendorId, value.deliveryId, { expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity: '1.5', reason: 'Verified route sheet' }));
    assert.deepEqual((await owner.query('SELECT status,version FROM scheduled_deliveries WHERE id=$1', [value.deliveryId])).rows, [{ status: 'delivered', version: 3 }]);
    for (const table of ['delivery_events', 'delivery_price_snapshots', 'audit_events', 'notifications']) assert.equal((await owner.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE vendor_id=$1`, [value.vendorId])).rows[0]?.count, table === 'delivery_events' ? 2 : 1);
    await requestContextStore.run({ correlationId: randomUUID() }, () => service().correct(value.admin, value.vendorId, value.deliveryId, { expectedVersion: 3, replacementOutcome: 'skipped_by_agent', reason: 'Delivery did not occur' }));
    assert.deepEqual((await owner.query('SELECT status,version FROM scheduled_deliveries WHERE id=$1', [value.deliveryId])).rows, [{ status: 'skipped_by_agent', version: 4 }]);
    assert.equal((await owner.query<{ amount: string }>('SELECT amount_minor::text AS amount FROM delivery_price_snapshots WHERE scheduled_delivery_id=$1', [value.deliveryId])).rows[0]?.amount, '95');
    await requestContextStore.run({ correlationId: randomUUID() }, () => service().correct(value.admin, value.vendorId, value.deliveryId, { expectedVersion: 4, replacementOutcome: 'delivered', actualQuantity: '1.25', reason: 'Correct delivered quantity' }));
    assert.deepEqual((await owner.query('SELECT status,version FROM scheduled_deliveries WHERE id=$1', [value.deliveryId])).rows, [{ status: 'delivered', version: 5 }]);
    assert.equal((await owner.query<{ amount: string }>('SELECT amount_minor::text AS amount FROM delivery_price_snapshots WHERE scheduled_delivery_id=$1', [value.deliveryId])).rows[0]?.amount, '95');
  } finally { await cleanup(value); }
});
