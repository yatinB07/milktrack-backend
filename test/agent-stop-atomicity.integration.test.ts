import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { DefaultAgentStopOutcomeService } from '../src/delivery/application/agent-stop-outcome.service.js';
import type { DeliveryStore } from '../src/delivery/application/delivery.store.js';
import { PrismaDeliveryStore } from '../src/delivery/infrastructure/prisma-delivery.store.js';
import type { NotificationWriter } from '../src/notifications/application/notification-writer.js';
import { PrismaNotificationStore } from '../src/notifications/infrastructure/prisma-notification.store.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
test.after(() => Promise.all([owner.end(), prisma.$disconnect()]));

async function fixture() {
  const value = {
    vendorId: randomUUID(), agentUserId: randomUUID(), customerUserId: randomUUID(), agentMembershipId: randomUUID(), customerMembershipId: randomUUID(),
    householdId: randomUUID(), unitId: randomUUID(), productId: randomUUID(), slotId: randomUUID(), routeId: randomUUID(), assignmentId: randomUUID(),
    planId: randomUUID(), stopId: randomUUID(), deliveryIds: [randomUUID(), randomUUID()], subscriptionIds: [randomUUID(), randomUUID()], revisionIds: [randomUUID(), randomUUID()],
  };
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,\'Atomic agent\',now()),($2,\'Atomic customer\',now())', [value.agentUserId, value.customerUserId]);
    await client.query("INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,capture_agent_location_evidence,updated_at) VALUES($1,$2,'Atomic','Atomic','active','Asia/Kolkata','INR',0,1,true,now())", [value.vendorId, `atomic-${value.vendorId}`]);
    await client.query("INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at) VALUES($1,$2,$3,'delivery_agent','active',now(),now()),($4,$2,$5,'customer','active',now(),now())", [value.agentMembershipId, value.vendorId, value.agentUserId, value.customerMembershipId, value.customerUserId]);
    await client.query("INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,'ATOMIC','Atomic','Road','Pune','MH','411001','IN',now())", [value.householdId, value.vendorId]);
    await client.query("INSERT INTO household_members(id,vendor_id,household_id,customer_membership_id,status,joined_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())", [randomUUID(), value.vendorId, value.householdId, value.customerMembershipId]);
    await client.query("INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,'ATOMIC_UNIT','Litre',3,now())", [value.unitId, value.vendorId]);
    await client.query("INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,'ATOMIC_PRODUCT','Milk',$3,now())", [value.productId, value.vendorId, value.unitId]);
    await client.query("INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'ATOMIC_SLOT','Morning','06:00','09:00',now())", [value.slotId, value.vendorId]);
    for (let index = 0; index < 2; index += 1) {
      await client.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [value.subscriptionIds[index], value.vendorId, value.householdId]);
      await client.query("INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'active','2030-01-01',$7,now())", [value.revisionIds[index], value.vendorId, value.subscriptionIds[index], value.productId, value.unitId, value.slotId, value.agentUserId]);
      await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,$3)', [value.vendorId, value.revisionIds[index], 2]);
    }
    await client.query("INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at) VALUES($1,$2,'ATOMIC_ROUTE','Route',$3,now())", [value.routeId, value.vendorId, value.slotId]);
    await client.query("INSERT INTO route_assignments(id,vendor_id,route_id,delivery_slot_id,agent_membership_id,service_date,status,created_by,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,'2030-01-01','assigned',$6,$6,now())", [value.assignmentId, value.vendorId, value.routeId, value.slotId, value.agentMembershipId, value.agentUserId]);
    await client.query("INSERT INTO route_stop_plans(id,vendor_id,route_id,delivery_slot_id,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,'2030-01-01',$5,now())", [value.planId, value.vendorId, value.routeId, value.slotId, value.agentUserId]);
    await client.query("INSERT INTO route_stops(id,vendor_id,route_id,plan_id,household_id,delivery_slot_id,sequence,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'2030-01-01',$7,now())", [value.stopId, value.vendorId, value.routeId, value.planId, value.householdId, value.slotId, value.agentUserId]);
    for (let index = 0; index < 2; index += 1) await client.query("INSERT INTO scheduled_deliveries(id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,route_assignment_id,service_date,planned_quantity,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'2030-01-01',1,now())", [value.deliveryIds[index], value.vendorId, value.subscriptionIds[index], value.revisionIds[index], value.householdId, value.productId, value.unitId, value.slotId, value.assignmentId]);
    await client.query('COMMIT');
    return value;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function cleanup(value: Awaited<ReturnType<typeof fixture>>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const table of ['notifications', 'delivery_events', 'delivery_price_snapshots', 'scheduled_deliveries', 'route_stops', 'route_stop_plans', 'route_assignments', 'routes', 'subscription_revision_weekdays', 'subscription_revisions', 'subscriptions', 'household_members', 'vendor_memberships', 'products', 'units', 'delivery_slots', 'households']) await client.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [value.vendorId]);
    await client.query('DELETE FROM vendors WHERE id=$1', [value.vendorId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[value.agentUserId, value.customerUserId]]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

function service(value: Awaited<ReturnType<typeof fixture>>, deliveries: DeliveryStore, notifications: NotificationWriter) {
  return new DefaultAgentStopOutcomeService(
    { execute: (_input: unknown, work: (tx: unknown) => Promise<unknown>) => transactions.run(value.vendorId, work) } as never,
    { resolveSelfRouteAgent: () => Promise.resolve({ membershipId: value.agentMembershipId }) } as never,
    deliveries, { isEffectivelyOnLeave: () => Promise.resolve(false) },
    { resolve: () => Promise.resolve({ amountMinor: '100', currency: 'INR', pricingLevel: 'global', sourcePriceId: randomUUID(), sourcePriceType: 'global_price', resolvedAt: new Date('2030-01-01T00:30:00Z') }) } as never,
    { getDeliveryPolicyForTransaction: () => Promise.resolve({ captureAgentLocationEvidence: true }) } as never,
    { getNotificationRecipientUserIds: () => Promise.resolve(new Map([[value.householdId, [value.customerUserId]]])) } as never,
    notifications,
  );
}

async function assertUnchanged(value: Awaited<ReturnType<typeof fixture>>) {
  assert.deepEqual((await owner.query('SELECT status,version FROM scheduled_deliveries WHERE vendor_id=$1 ORDER BY id', [value.vendorId])).rows, [{ status: 'scheduled', version: 1 }, { status: 'scheduled', version: 1 }]);
  for (const table of ['delivery_events', 'delivery_price_snapshots', 'notifications']) assert.equal((await owner.query(`SELECT 1 FROM ${table} WHERE vendor_id=$1`, [value.vendorId])).rowCount, 0);
}

void test('forced late failures roll back every stop event, projection, snapshot, and notification', async () => {
  const value = await fixture();
  const store = new PrismaDeliveryStore();
  const actor = { userId: value.agentUserId, sessionId: randomUUID(), displayName: 'Agent', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [] } as const;
  const versions = value.deliveryIds.map((scheduledDeliveryId) => ({ scheduledDeliveryId, expectedVersion: 1 }));
  try {
    let events = 0;
    const failingDeliveries = Object.create(store) as PrismaDeliveryStore;
    failingDeliveries.appendFinalOutcome = async (...args: Parameters<PrismaDeliveryStore['appendFinalOutcome']>) => {
      if (++events === 2) throw new Error('forced event failure');
      return store.appendFinalOutcome(...args);
    };
    await assert.rejects(service(value, failingDeliveries, new PrismaNotificationStore()).record(actor, value.vendorId, value.stopId, {
      serviceDate: '2030-01-01', outcome: 'delivered', occurredAt: '2030-01-01T01:00:00Z', items: versions.map((item) => ({ ...item, actualQuantity: '1' })),
    }), /forced event failure/u);
    await assertUnchanged(value);

    let notifications = 0;
    const writer = new PrismaNotificationStore();
    const failingNotifications = { append: async (...args: Parameters<PrismaNotificationStore['append']>) => {
      if (++notifications === 2) throw new Error('forced notification failure');
      return writer.append(...args);
    } };
    await assert.rejects(service(value, store, failingNotifications).record(actor, value.vendorId, value.stopId, {
      serviceDate: '2030-01-01', outcome: 'skipped_by_agent', occurredAt: '2030-01-01T01:00:00Z', items: versions, reasonCode: 'customer_on_leave',
    }), /forced notification failure/u);
    await assertUnchanged(value);
  } finally { await cleanup(value); }
});
