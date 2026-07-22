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
import { PrismaMembershipService } from '../src/memberships/application/membership.service.js';
import { PrismaMembershipStore } from '../src/memberships/infrastructure/prisma-membership.store.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
test.after(() => Promise.all([owner.end(), prisma.$disconnect()]));

async function fixture() {
  const value = {
    vendorId: randomUUID(), otherVendorId: randomUUID(), agentUserId: randomUUID(), otherAgentUserId: randomUUID(), customerUserId: randomUUID(),
    agentMembershipId: randomUUID(), otherAgentMembershipId: randomUUID(), crossVendorMembershipId: randomUUID(), customerMembershipId: randomUUID(),
    householdId: randomUUID(), unitId: randomUUID(), productId: randomUUID(), slotId: randomUUID(), routeId: randomUUID(), assignmentId: randomUUID(),
    planId: randomUUID(), stopId: randomUUID(), deliveryIds: [randomUUID(), randomUUID()], subscriptionIds: [randomUUID(), randomUUID()], revisionIds: [randomUUID(), randomUUID()],
  };
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,\'Atomic agent\',now()),($2,\'Atomic other agent\',now()),($3,\'Atomic customer\',now())', [value.agentUserId, value.otherAgentUserId, value.customerUserId]);
    await client.query("INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,capture_agent_location_evidence,updated_at) VALUES($1,$2,'Atomic','Atomic','active','Asia/Kolkata','INR',0,1,true,now())", [value.vendorId, `atomic-${value.vendorId}`]);
    await client.query("INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,capture_agent_location_evidence,updated_at) VALUES($1,$2,'Atomic other','Atomic other','active','Asia/Kolkata','INR',0,1,true,now())", [value.otherVendorId, `atomic-${value.otherVendorId}`]);
    await client.query("INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at) VALUES($1,$2,$3,'delivery_agent','active',now(),now()),($4,$2,$5,'delivery_agent','active',now(),now()),($6,$2,$7,'customer','active',now(),now()),($8,$9,$3,'delivery_agent','active',now(),now())", [value.agentMembershipId, value.vendorId, value.agentUserId, value.otherAgentMembershipId, value.otherAgentUserId, value.customerMembershipId, value.customerUserId, value.crossVendorMembershipId, value.otherVendorId]);
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
    const vendorIds = [value.vendorId, value.otherVendorId];
    for (const table of ['notifications', 'delivery_events', 'delivery_price_snapshots', 'scheduled_deliveries', 'route_stops', 'route_stop_plans', 'route_assignments', 'routes', 'subscription_revision_weekdays', 'subscription_revisions', 'subscriptions', 'household_members', 'vendor_memberships', 'products', 'units', 'delivery_slots', 'households']) await client.query(`DELETE FROM ${table} WHERE vendor_id=ANY($1::uuid[])`, [vendorIds]);
    await client.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendorIds]);
    await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[value.agentUserId, value.otherAgentUserId, value.customerUserId]]);
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

function realBoundaryService() {
  const memberships = new PrismaMembershipService({} as never, new PrismaMembershipStore(), {} as never, {} as never);
  return new DefaultAgentStopOutcomeService(
    { execute: (input: { vendorId: string }, work: (tx: unknown) => Promise<unknown>) => transactions.run(input.vendorId, work) } as never,
    memberships, new PrismaDeliveryStore(), { isEffectivelyOnLeave: () => Promise.resolve(false) },
    { resolve: () => Promise.reject(new Error('price resolution must not run for a denied boundary')) },
    { getDeliveryPolicyForTransaction: () => Promise.resolve({ captureAgentLocationEvidence: true }) } as never,
    { getNotificationRecipientUserIds: () => Promise.reject(new Error('recipient lookup must not run for a denied boundary')) } as never,
    new PrismaNotificationStore(),
  );
}

async function assertUnchanged(value: Awaited<ReturnType<typeof fixture>>) {
  assert.deepEqual((await owner.query('SELECT status,version FROM scheduled_deliveries WHERE vendor_id=$1 ORDER BY id', [value.vendorId])).rows, [{ status: 'scheduled', version: 1 }, { status: 'scheduled', version: 1 }]);
  for (const table of ['delivery_events', 'delivery_price_snapshots', 'notifications']) assert.equal((await owner.query(`SELECT 1 FROM ${table} WHERE vendor_id=ANY($1::uuid[])`, [[value.vendorId, value.otherVendorId]])).rowCount, 0);
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

void test('an invalid or stale second item leaves the real stop aggregate unchanged', async () => {
  const value = await fixture();
  const actor = { userId: value.agentUserId, sessionId: randomUUID(), displayName: 'Agent', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [] } as const;
  const validItems = value.deliveryIds.map((scheduledDeliveryId) => ({ scheduledDeliveryId, expectedVersion: 1, actualQuantity: '1' }));
  const store = new PrismaDeliveryStore();
  try {
    for (const [code, items] of [
      ['INVALID_DELIVERY_QUANTITY', [validItems[0], { ...validItems[1], actualQuantity: '0' }]],
      ['STALE_VERSION', [validItems[0], { ...validItems[1], expectedVersion: 2 }]],
    ] as const) {
      await assert.rejects(service(value, store, new PrismaNotificationStore()).record(actor, value.vendorId, value.stopId, {
        serviceDate: '2030-01-01', outcome: 'delivered', occurredAt: '2030-01-01T01:00:00Z', items,
      }), (error: unknown) => error instanceof Error && 'code' in error && error.code === code);
      await assertUnchanged(value);
    }
  } finally { await cleanup(value); }
});

void test('real membership and stop boundaries neutrally deny mismatched agent, assignment, date, stop, and vendor', async () => {
  const value = await fixture();
  const command = {
    serviceDate: '2030-01-01', outcome: 'delivered' as const, occurredAt: '2030-01-01T01:00:00Z',
    items: value.deliveryIds.map((scheduledDeliveryId) => ({ scheduledDeliveryId, expectedVersion: 1, actualQuantity: '1' })),
  };
  const actor = (userId: string) => ({ userId, sessionId: randomUUID(), displayName: 'Agent', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [] } as const);
  const cases = [
    {
      name: 'inactive agent', expectedCode: 'FORBIDDEN', actorUserId: value.agentUserId, vendorId: value.vendorId, routeStopId: value.stopId, serviceDate: command.serviceDate,
      before: () => owner.query("UPDATE vendor_memberships SET status='ended',ended_at=now() WHERE id=$1", [value.agentMembershipId]),
      after: () => owner.query("UPDATE vendor_memberships SET status='active',ended_at=NULL WHERE id=$1", [value.agentMembershipId]),
    },
    { name: 'wrong agent', expectedCode: 'INCOMPLETE_STOP_SET', actorUserId: value.otherAgentUserId, vendorId: value.vendorId, routeStopId: value.stopId, serviceDate: command.serviceDate },
    {
      name: 'wrong assignment', expectedCode: 'INCOMPLETE_STOP_SET', actorUserId: value.agentUserId, vendorId: value.vendorId, routeStopId: value.stopId, serviceDate: command.serviceDate,
      before: () => owner.query('UPDATE route_assignments SET agent_membership_id=$1,updated_at=now() WHERE id=$2', [value.otherAgentMembershipId, value.assignmentId]),
      after: () => owner.query('UPDATE route_assignments SET agent_membership_id=$1,updated_at=now() WHERE id=$2', [value.agentMembershipId, value.assignmentId]),
    },
    { name: 'wrong date', expectedCode: 'INCOMPLETE_STOP_SET', actorUserId: value.agentUserId, vendorId: value.vendorId, routeStopId: value.stopId, serviceDate: '2030-01-02' },
    { name: 'wrong stop', expectedCode: 'INCOMPLETE_STOP_SET', actorUserId: value.agentUserId, vendorId: value.vendorId, routeStopId: randomUUID(), serviceDate: command.serviceDate },
    { name: 'wrong vendor', expectedCode: 'INCOMPLETE_STOP_SET', actorUserId: value.agentUserId, vendorId: value.otherVendorId, routeStopId: value.stopId, serviceDate: command.serviceDate },
  ];
  try {
    for (const current of cases) {
      await current.before?.();
      try {
        await assert.rejects(realBoundaryService().record(actor(current.actorUserId), current.vendorId, current.routeStopId, {
          ...command, serviceDate: current.serviceDate,
        }), (error: unknown) => error instanceof Error && 'code' in error && error.code === current.expectedCode, current.name);
        await assertUnchanged(value);
      } finally { await current.after?.(); }
    }
  } finally { await cleanup(value); }
});
