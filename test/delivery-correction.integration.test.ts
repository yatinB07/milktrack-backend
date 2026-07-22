import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { PrismaAuditWriter } from '../src/audit/infrastructure/prisma-audit.writer.js';
import { PrismaTenantAuthorizationExecutor } from '../src/authorization/application/tenant-authorization.executor.js';
import { PrismaAuthorizationPolicy } from '../src/authorization/infrastructure/prisma-authorization.policy.js';
import { PrismaSecurityDenialRecorder } from '../src/authorization/infrastructure/security-denial.recorder.js';
import { DefaultDeliveryCorrectionService } from '../src/delivery/application/delivery-correction.service.js';
import { PrismaDeliveryStore } from '../src/delivery/infrastructure/prisma-delivery.store.js';
import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaNotificationStore } from '../src/notifications/infrastructure/prisma-notification.store.js';
import { requestContextStore, type Actor } from '../src/common/context/request-context.js';

const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const deliveries = new PrismaDeliveryStore();
test.after(() => Promise.all([prisma.$disconnect(), owner.end()]));

type Fixture = Readonly<{ vendorId: string; otherVendorId: string; householdId: string; deliveryId: string; sourcePriceId: string; actors: readonly Actor[]; ownerActor: Actor; admin: Actor; customerId: string; originalEventId: string }>;

async function fixture(): Promise<Fixture> {
  const vendorId = randomUUID(); const otherVendorId = randomUUID(); const ownerId = randomUUID(); const adminId = randomUUID(); const customerId = randomUUID(); const agentId = randomUUID(); const platformId = randomUUID();
  const ownerMembershipId = randomUUID(); const adminMembershipId = randomUUID(); const customerMembershipId = randomUUID(); const agentMembershipId = randomUUID(); const householdId = randomUUID(); const unitId = randomUUID(); const productId = randomUUID(); const slotId = randomUUID(); const subscriptionId = randomUUID(); const revisionId = randomUUID(); const deliveryId = randomUUID(); const sourcePriceId = randomUUID();
  for (const [id, name] of [[ownerId, 'Owner'], [adminId, 'Admin'], [customerId, 'Customer'], [agentId, 'Agent'], [platformId, 'Platform']] as const) await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [id, name]);
  for (const id of [vendorId, otherVendorId]) await owner.query("INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$2,$2,'active','Asia/Kolkata','INR',0,1,now())", [id, `correction-${id.slice(0, 8)}`]);
  await owner.query("INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at) VALUES($1,$2,$3,'vendor_owner','active',now(),now()),($4,$2,$5,'vendor_administrator','active',now(),now()),($6,$2,$7,'customer','active',now(),now()),($8,$2,$9,'delivery_agent','active',now(),now())", [ownerMembershipId, vendorId, ownerId, adminMembershipId, adminId, customerMembershipId, customerId, agentMembershipId, agentId]);
  await owner.query("INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,'A','A','Road','Pune','MH','411001','IN',now())", [householdId, vendorId]);
  await owner.query("INSERT INTO household_members(id,vendor_id,household_id,customer_membership_id,joined_at,updated_at) VALUES($1,$2,$3,$4,now(),now())", [randomUUID(), vendorId, householdId, customerMembershipId]);
  await owner.query("INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,'LT','Litre',3,now())", [unitId, vendorId]);
  await owner.query("INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,'ML','Milk',$3,now())", [productId, vendorId, unitId]);
  await owner.query("INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'AM','Morning','06:00','09:00',now())", [slotId, vendorId]);
  await owner.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [subscriptionId, vendorId, householdId]);
  await owner.query("WITH revision AS (INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now()) RETURNING id) INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) SELECT $2,id,1 FROM revision", [revisionId, vendorId, subscriptionId, productId, unitId, slotId, adminId]);
  await owner.query("INSERT INTO scheduled_deliveries(id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,service_date,planned_quantity,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'2030-01-01',1,now())", [deliveryId, vendorId, subscriptionId, revisionId, householdId, productId, unitId, slotId]);
  await transactions.run(vendorId, (tx) => deliveries.applyCustomerLeave(tx, { vendorId, subscriptionId, serviceDate: '2030-01-01', deliverySlotId: slotId }, customerId));
  const originalEventId = (await owner.query<{ id: string }>('SELECT id FROM delivery_events WHERE scheduled_delivery_id=$1', [deliveryId])).rows[0].id;
  const actor = (userId: string, displayName: string, authenticationMethod: Actor['authenticationMethod'], platformRoles: Actor['platformRoles'], role?: 'vendor_owner' | 'vendor_administrator' | 'customer' | 'delivery_agent', membershipId = randomUUID()): Actor => ({ userId, sessionId: randomUUID(), displayName, authenticationMethod, platformRoles, memberships: role ? [{ id: membershipId, vendorId, vendorName: 'Milk', role, status: 'active' }] : [] });
  const ownerActor = actor(ownerId, 'Owner', 'administrator_mfa', [], 'vendor_owner', ownerMembershipId);
  const admin = actor(adminId, 'Admin', 'administrator_mfa', [], 'vendor_administrator', adminMembershipId);
  const customer = actor(customerId, 'Customer', 'phone_otp', [], 'customer', customerMembershipId);
  const agent = actor(agentId, 'Agent', 'phone_otp', [], 'delivery_agent', agentMembershipId);
  const platform = actor(platformId, 'Platform', 'administrator_mfa', ['platform_administrator']);
  return { vendorId, otherVendorId, householdId, deliveryId, sourcePriceId, actors: [ownerActor, admin, customer, agent, platform], ownerActor, admin, customerId, originalEventId };
}

async function cleanup(value: Fixture) {
  const userIds = value.actors.map(({ userId }) => userId);
  await owner.query('DELETE FROM notifications WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM audit_events WHERE vendor_id=$1 OR actor_user_id=ANY($2::uuid[])', [value.vendorId, userIds]); await owner.query('DELETE FROM delivery_price_snapshots WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM delivery_events WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM scheduled_deliveries WHERE vendor_id=$1', [value.vendorId]); await owner.query('WITH weekdays AS (DELETE FROM subscription_revision_weekdays WHERE vendor_id=$1 RETURNING subscription_revision_id) DELETE FROM subscription_revisions WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM subscriptions WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM household_members WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM households WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM products WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM units WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM delivery_slots WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM vendor_memberships WHERE vendor_id=$1', [value.vendorId]); await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [[value.vendorId, value.otherVendorId]]); await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
}

function service(value: Fixture, notifications = new PrismaNotificationStore(), priceFound = true) {
  const audits = new PrismaAuditWriter();
  return new DefaultDeliveryCorrectionService(
    new PrismaTenantAuthorizationExecutor(transactions, new PrismaAuthorizationPolicy(audits), new PrismaSecurityDenialRecorder(prisma)),
    deliveries,
    { resolve: () => Promise.resolve(priceFound ? { amountMinor: '95', currency: 'INR', pricingLevel: 'global' as const, sourcePriceId: value.sourcePriceId, sourcePriceType: 'global_price' as const, resolvedAt: new Date('2030-01-01T00:30:00.000Z') } : undefined) },
    audits, notifications,
  );
}

void test('correction transaction rolls back snapshot, event, projection, audit, and notification on notification failure and stays tenant-scoped', async () => {
  const value = await fixture();
  try {
    const correction = { expectedVersion: 2, replacementOutcome: 'delivered' as const, actualQuantity: '1.500', reason: 'Verified route sheet' };
    await assert.rejects(requestContextStore.run({ correlationId: randomUUID() }, () => service(value, undefined, false).correct(value.ownerActor, value.vendorId, value.deliveryId, correction)), (error: unknown) => (error as { code?: string }).code === 'DELIVERY_PRICE_NOT_FOUND');
    assert.deepEqual((await owner.query('SELECT status,version FROM scheduled_deliveries WHERE id=$1', [value.deliveryId])).rows, [{ status: 'skipped_by_customer', version: 2 }]);
    for (const table of ['delivery_price_snapshots', 'audit_events', 'notifications']) assert.equal((await owner.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE vendor_id=$1`, [value.vendorId])).rows[0]?.count, 0);

    for (const denied of value.actors.slice(2)) {
      await assert.rejects(requestContextStore.run({ correlationId: randomUUID() }, () => service(value).correct(denied, value.vendorId, value.deliveryId, correction)), (error: unknown) => (error as { code?: string }).code === 'FORBIDDEN');
    }
    await assert.rejects(requestContextStore.run({ correlationId: randomUUID() }, () => service(value).correct(value.admin, value.otherVendorId, value.deliveryId, correction)), (error: unknown) => (error as { code?: string }).code === 'FORBIDDEN');

    const failingNotifications = { append: async (tx: never, notification: Parameters<PrismaNotificationStore['append']>[1]) => { await new PrismaNotificationStore().append(tx, notification); throw new Error('notification unavailable'); } };
    await assert.rejects(requestContextStore.run({ correlationId: randomUUID() }, () => service(value, failingNotifications as never).correct(value.ownerActor, value.vendorId, value.deliveryId, correction)), /notification unavailable/u);
    assert.deepEqual((await owner.query('SELECT status,version FROM scheduled_deliveries WHERE id=$1', [value.deliveryId])).rows, [{ status: 'skipped_by_customer', version: 2 }]);
    for (const table of ['delivery_events', 'delivery_price_snapshots', 'notifications']) assert.equal((await owner.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE vendor_id=$1`, [value.vendorId])).rows[0]?.count, table === 'delivery_events' ? 1 : 0);
    assert.equal((await owner.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_events WHERE vendor_id=$1 AND action='delivery.corrected'", [value.vendorId])).rows[0]?.count, 0);

    await requestContextStore.run({ correlationId: randomUUID() }, () => service(value).correct(value.ownerActor, value.vendorId, value.deliveryId, correction));
    assert.deepEqual((await owner.query('SELECT status,version FROM scheduled_deliveries WHERE id=$1', [value.deliveryId])).rows, [{ status: 'delivered', version: 3 }]);
    const event = (await owner.query<{ source: string; replaced_event_id: string; reason_code: string; actual_quantity: string }>('SELECT source,replaced_event_id,reason_code,actual_quantity::text AS actual_quantity FROM delivery_events WHERE scheduled_delivery_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [value.deliveryId])).rows[0];
    assert.deepEqual(event, { source: 'vendor_admin', replaced_event_id: value.originalEventId, reason_code: correction.reason, actual_quantity: '1.500' });
    const audit = (await owner.query<{ old_value: unknown; new_value: unknown; reason: string }>("SELECT old_value,new_value,reason FROM audit_events WHERE vendor_id=$1 AND action='delivery.corrected'", [value.vendorId])).rows[0];
    assert.deepEqual(audit, { old_value: { status: 'skipped_by_customer', version: 2 }, new_value: { status: 'delivered', actualQuantity: '1.5', version: 3 }, reason: correction.reason });
    assert.deepEqual((await owner.query('SELECT recipient_user_id,type,payload FROM notifications WHERE vendor_id=$1', [value.vendorId])).rows, [{ recipient_user_id: value.customerId, type: 'delivery_corrected', payload: { householdId: value.householdId, scheduledDeliveryId: value.deliveryId } }]);
    assert.deepEqual((await owner.query("SELECT amount_minor::text AS amount,source_price_id,source_price_type,resolved_at AT TIME ZONE 'UTC' AS resolved_at FROM delivery_price_snapshots WHERE scheduled_delivery_id=$1", [value.deliveryId])).rows, [{ amount: '95', source_price_id: value.sourcePriceId, source_price_type: 'global_price', resolved_at: new Date('2030-01-01T00:30:00.000Z') }]);

    await assert.rejects(requestContextStore.run({ correlationId: randomUUID() }, () => service(value).correct(value.admin, value.vendorId, value.deliveryId, correction)), (error: unknown) => (error as { code?: string }).code === 'STALE_VERSION');
    await requestContextStore.run({ correlationId: randomUUID() }, () => service(value).correct(value.admin, value.vendorId, value.deliveryId, { expectedVersion: 3, replacementOutcome: 'skipped_by_agent', reason: 'Delivery did not occur' }));
    assert.deepEqual((await owner.query('SELECT status,version FROM scheduled_deliveries WHERE id=$1', [value.deliveryId])).rows, [{ status: 'skipped_by_agent', version: 4 }]);
    assert.equal((await owner.query<{ amount: string }>('SELECT amount_minor::text AS amount FROM delivery_price_snapshots WHERE scheduled_delivery_id=$1', [value.deliveryId])).rows[0]?.amount, '95');
  } finally { await cleanup(value); }
});
