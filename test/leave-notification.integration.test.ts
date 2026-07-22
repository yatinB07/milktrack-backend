import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import type { TenantAuthorizationExecutor } from '../src/authorization/application/tenant-authorization.executor.js';
import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { DefaultDeliveryLeaveProjection } from '../src/delivery/application/delivery-leave.projection.js';
import { PrismaDeliveryStore } from '../src/delivery/infrastructure/prisma-delivery.store.js';
import { DefaultLeaveService } from '../src/leave/application/leave.service.js';
import { DefaultSchedulingLeaveService } from '../src/leave/application/scheduling-leave.service.js';
import { PrismaLeaveStore } from '../src/leave/infrastructure/prisma-leave.store.js';
import type { MembershipService } from '../src/memberships/application/membership.service.js';
import { PrismaMembershipStore } from '../src/memberships/infrastructure/prisma-membership.store.js';
import type { NotificationWriter } from '../src/notifications/application/notification-writer.js';
import { PrismaNotificationStore } from '../src/notifications/infrastructure/prisma-notification.store.js';
import { DefaultRoutingScheduleService } from '../src/routing/application/routing-schedule.service.js';
import { PrismaRouteAssignmentStore } from '../src/routing/infrastructure/prisma-route-assignment.store.js';
import { PrismaScheduledDeliveryStore } from '../src/scheduling/infrastructure/prisma-scheduled-delivery.store.js';
import { PrismaSubscriptionLabelReader } from '../src/subscriptions/infrastructure/prisma-subscription-label.reader.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const leaves = new PrismaLeaveStore();
const notificationStore = new PrismaNotificationStore();
const memberships = new PrismaMembershipStore();
const projection = new DefaultDeliveryLeaveProjection(new PrismaDeliveryStore());
const routing = new DefaultRoutingScheduleService(new PrismaRouteAssignmentStore());
const schedulingLeave = new DefaultSchedulingLeaveService(leaves);
const scheduledDeliveries = new PrismaScheduledDeliveryStore();
const labels = new PrismaSubscriptionLabelReader();

test.after(() => Promise.all([owner.end(), prisma.$disconnect()]));

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(label: string) {
  const value = {
    vendorId: randomUUID(), customerUserId: randomUUID(), agentUserId: randomUUID(), customerMembershipId: randomUUID(),
    agentMembershipId: randomUUID(), householdMemberId: randomUUID(), householdId: randomUUID(), unitId: randomUUID(),
    productId: randomUUID(), slotId: randomUUID(), subscriptionId: randomUUID(), revisionId: randomUUID(),
    routeId: randomUUID(), assignmentId: randomUUID(), planId: randomUUID(), stopId: randomUUID(),
    firstDeliveryId: randomUUID(), secondDeliveryId: randomUUID(),
  };
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now()),($3,$4,now())', [value.customerUserId, `Customer ${label}`, value.agentUserId, `Agent ${label}`]);
    await client.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
      VALUES($1,$2,$2,$2,'active','UTC','USD',60,1,now())`, [value.vendorId, `leave-notify-${label}-${value.vendorId.slice(0, 8)}`]);
    await client.query("INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at) VALUES($1,$2,$3,'customer','active',now(),now()),($4,$2,$5,'delivery_agent','active',now(),now())", [value.customerMembershipId, value.vendorId, value.customerUserId, value.agentMembershipId, value.agentUserId]);
    await client.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at)
      VALUES($1,$2,$3,$3,'Road','Pune','MH','411001','IN',now())`, [value.householdId, value.vendorId, `LN-${label}`]);
    await client.query("INSERT INTO household_members(id,vendor_id,household_id,customer_membership_id,status,joined_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())", [value.householdMemberId, value.vendorId, value.householdId, value.customerMembershipId]);
    await client.query("INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,'LITRE','Litre',3,now())", [value.unitId, value.vendorId]);
    await client.query("INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,'MILK','Milk',$3,now())", [value.productId, value.vendorId, value.unitId]);
    await client.query("INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'AM','Morning','06:00','09:00',now())", [value.slotId, value.vendorId]);
    await client.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [value.subscriptionId, value.vendorId, value.householdId]);
    await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [value.revisionId, value.vendorId, value.subscriptionId, value.productId, value.unitId, value.slotId, value.customerUserId]);
    await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,2)', [value.vendorId, value.revisionId]);
    await client.query("INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at) VALUES($1,$2,'ROUTE','Route',$3,now())", [value.routeId, value.vendorId, value.slotId]);
    await client.query("INSERT INTO route_assignments(id,vendor_id,route_id,delivery_slot_id,agent_membership_id,service_date,created_by,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,'2030-01-01',$6,$6,now())", [value.assignmentId, value.vendorId, value.routeId, value.slotId, value.agentMembershipId, value.customerUserId]);
    await client.query("INSERT INTO route_stop_plans(id,vendor_id,route_id,delivery_slot_id,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,'2030-01-01',$5,now())", [value.planId, value.vendorId, value.routeId, value.slotId, value.customerUserId]);
    await client.query("INSERT INTO route_stops(id,vendor_id,route_id,plan_id,household_id,delivery_slot_id,sequence,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'2030-01-01',$7,now())", [value.stopId, value.vendorId, value.routeId, value.planId, value.householdId, value.slotId, value.customerUserId]);
    for (const [id, serviceDate, assignmentId] of [[value.firstDeliveryId, '2030-01-01', value.assignmentId], [value.secondDeliveryId, '2030-01-08', null]] as const) {
      await client.query(`INSERT INTO scheduled_deliveries(id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,route_assignment_id,service_date,planned_quantity,status,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'scheduled',now())`, [id, value.vendorId, value.subscriptionId, value.revisionId, value.householdId, value.productId, value.unitId, value.slotId, assignmentId, serviceDate]);
    }
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(value: Fixture) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const table of ['notifications', 'delivery_events', 'scheduled_deliveries']) await client.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [value.vendorId]);
    await client.query('UPDATE leave_requests SET current_revision_id=NULL WHERE vendor_id=$1', [value.vendorId]);
    for (const table of ['leave_occurrence_decisions', 'leave_revision_subscriptions', 'leave_request_revisions', 'leave_requests', 'route_stops', 'route_stop_plans', 'route_assignments', 'routes', 'subscription_revision_weekdays', 'subscription_revisions', 'subscriptions', 'household_members', 'vendor_memberships', 'products', 'units', 'delivery_slots', 'households']) {
      await client.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [value.vendorId]);
    }
    await client.query('DELETE FROM vendors WHERE id=$1', [value.vendorId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[value.customerUserId, value.agentUserId]]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function actor(value: Fixture): Actor {
  return {
    userId: value.customerUserId, sessionId: randomUUID(), displayName: 'Customer', authenticationMethod: 'phone_otp', platformRoles: [],
    memberships: [{ id: value.customerMembershipId, vendorId: value.vendorId, vendorName: 'Milk', role: 'customer', status: 'active' }],
  };
}

function service(writer: NotificationWriter = notificationStore, options: Readonly<{ now?: Date; skipCutoffMinutes?: number }> = {}) {
  const authorization = { execute: ({ vendorId }: { vendorId: string }, work: (tx: TransactionContext) => Promise<unknown>) => transactions.run(vendorId, work) } as TenantAuthorizationExecutor;
  const memberService = { customerMembershipHistory: (tx: TransactionContext, vendorId: string, ids: readonly string[]) => memberships.customerMembershipHistory(tx, vendorId, ids) } as MembershipService;
  const leave = new DefaultLeaveService(
    authorization,
    { requireCustomerSubscriptionHousehold: () => Promise.resolve({ householdId: 'authorized' }) } as never,
    leaves,
    { getDeliveryPolicyForTransaction: () => Promise.resolve({ skipCutoffMinutes: options.skipCutoffMinutes ?? 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, version: 1 }), getSubscriptionTimezone: () => Promise.resolve({ timezone: 'UTC' }) } as never,
    { append: () => Promise.resolve() },
    projection,
    writer,
    routing,
    memberService,
    labels,
  );
  if (options.now) (leave as unknown as { now: () => Date }).now = () => options.now!;
  return leave;
}

function scheduleTarget(value: Fixture, serviceDate: string) {
  return {
    subscriptionId: value.subscriptionId, revisionId: value.revisionId, householdId: value.householdId,
    productId: value.productId, unitId: value.unitId, deliverySlotId: value.slotId, plannedQuantity: '1',
    routeAssignmentId: serviceDate === '2030-01-01' ? value.assignmentId : null,
  };
}

void test('accepted leave updates schedules, reverses eligible amendments/cancellation, and notifies current recipients atomically', async () => {
  const value = await fixture('lifecycle');
  try {
    const leave = service();
    const created = await requestContextStore.run({ correlationId: randomUUID() }, () => leave.create(actor(value), value.vendorId, value.householdId, {
      startDate: '2030-01-01', endDate: '2030-01-08', subscriptionIds: [value.subscriptionId],
    }));
    assert.equal(created.currentStatus, 'accepted');
    const initial = await owner.query<{ serviceDate: string; status: string }>('SELECT service_date::text AS "serviceDate",status FROM scheduled_deliveries WHERE vendor_id=$1 ORDER BY service_date', [value.vendorId]);
    assert.deepEqual(initial.rows, [{ serviceDate: '2030-01-01', status: 'skipped_by_customer' }, { serviceDate: '2030-01-08', status: 'skipped_by_customer' }]);
    const accepted = await owner.query<{ recipientUserId: string }>("SELECT recipient_user_id AS \"recipientUserId\" FROM notifications WHERE vendor_id=$1 AND type='leave_accepted' ORDER BY recipient_user_id", [value.vendorId]);
    assert.deepEqual(accepted.rows.map(({ recipientUserId }) => recipientUserId).sort(), [value.customerUserId, value.agentUserId].sort());

    const amended = await requestContextStore.run({ correlationId: randomUUID() }, () => leave.amend(actor(value), value.vendorId, value.householdId, created.id, {
      startDate: '2030-01-08', endDate: '2030-01-08', subscriptionIds: [value.subscriptionId], expectedVersion: 1,
    }));
    const afterAmend = await owner.query<{ serviceDate: string; status: string }>('SELECT service_date::text AS "serviceDate",status FROM scheduled_deliveries WHERE vendor_id=$1 ORDER BY service_date', [value.vendorId]);
    assert.deepEqual(afterAmend.rows, [{ serviceDate: '2030-01-01', status: 'scheduled' }, { serviceDate: '2030-01-08', status: 'skipped_by_customer' }]);

    await requestContextStore.run({ correlationId: randomUUID() }, () => leave.cancel(actor(value), value.vendorId, value.householdId, created.id, { expectedVersion: amended.version }));
    const afterCancel = await owner.query<{ status: string }>('SELECT status FROM scheduled_deliveries WHERE vendor_id=$1 ORDER BY service_date', [value.vendorId]);
    assert.deepEqual(afterCancel.rows, [{ status: 'scheduled' }, { status: 'scheduled' }]);
    const events = (await owner.query<{
      id: string; eventType: string; replacedEventId: string | null; reasonCode: string | null;
    }>(`SELECT e.id,e.event_type AS "eventType",e.replaced_event_id AS "replacedEventId",e.reason_code AS "reasonCode"
      FROM delivery_events e JOIN scheduled_deliveries d
        ON d.vendor_id=e.vendor_id AND d.id=e.scheduled_delivery_id
      WHERE e.vendor_id=$1 ORDER BY d.service_date,e.created_at,e.id`, [value.vendorId])).rows;
    assert.deepEqual(events.map(({ eventType }) => eventType), [
      'skipped_by_customer', 'scheduled', 'skipped_by_customer', 'scheduled',
    ]);
    for (const index of [0, 2]) {
      assert.equal(events[index + 1]?.replacedEventId, events[index]?.id);
      assert.equal(events[index + 1]?.reasonCode, 'customer_leave_reversed');
    }
  } finally {
    await cleanup(value);
  }
});

void test('rejected leave decision notifies only the requesting customer', async () => {
  const value = await fixture('rejected');
  const requestId = randomUUID(); const revisionId = randomUUID(); const decisionId = randomUUID();
  try {
    await transactions.run(value.vendorId, (tx) => leaves.createRevision(tx, {
      vendorId: value.vendorId, householdId: value.householdId, requestId, revisionId, action: 'create', source: 'customer',
      createdBy: value.customerUserId, startDate: '2030-01-15', endDate: '2030-01-15', subscriptions: [{ subscriptionId: value.subscriptionId, selected: true }],
      status: 'pending_approval', decisions: [{ id: decisionId, subscriptionId: value.subscriptionId, serviceDate: '2030-01-15', deliverySlotId: value.slotId, cutoffAt: new Date('2030-01-14T23:00:00.000Z'), status: 'pending' }],
    }));
    await requestContextStore.run({ correlationId: randomUUID() }, () => service().decideOccurrence({ ...actor(value), memberships: [] }, value.vendorId, decisionId, {
      expectedVersion: 1, decision: 'rejected', reason: 'Route already dispatched',
    }));
    const notifications = await owner.query<{ recipientUserId: string; type: string }>('SELECT recipient_user_id AS "recipientUserId",type FROM notifications WHERE vendor_id=$1', [value.vendorId]);
    assert.deepEqual(notifications.rows, [{ recipientUserId: value.customerUserId, type: 'leave_rejected' }]);
  } finally {
    await cleanup(value);
  }
});

void test('notification failure rolls back the accepted leave, schedule event, and prior notification', async () => {
  const value = await fixture('rollback');
  const writer: NotificationWriter = { append: async (tx, notification) => {
    await notificationStore.append(tx, notification);
    if (notification.recipientUserId === value.agentUserId) throw new Error('notification failed');
  } };
  try {
    await assert.rejects(requestContextStore.run({ correlationId: randomUUID() }, () => service(writer).create(actor(value), value.vendorId, value.householdId, {
      startDate: '2030-01-01', endDate: '2030-01-01', subscriptionIds: [value.subscriptionId],
    })), /notification failed/u);
    assert.equal((await owner.query<{ count: number }>('SELECT count(*)::int AS count FROM leave_requests WHERE vendor_id=$1', [value.vendorId])).rows[0]?.count, 0);
    assert.equal((await owner.query<{ count: number }>('SELECT count(*)::int AS count FROM delivery_events WHERE vendor_id=$1', [value.vendorId])).rows[0]?.count, 0);
    assert.equal((await owner.query<{ count: number }>('SELECT count(*)::int AS count FROM notifications WHERE vendor_id=$1', [value.vendorId])).rows[0]?.count, 0);
    assert.deepEqual((await owner.query<{ status: string }>('SELECT status FROM scheduled_deliveries WHERE vendor_id=$1 ORDER BY service_date', [value.vendorId])).rows, [{ status: 'scheduled' }, { status: 'scheduled' }]);
  } finally {
    await cleanup(value);
  }
});

void test('amendment and cancellation reverse customer skips created by later schedule generation', async () => {
  const value = await fixture('generated-reversal');
  try {
    await owner.query('DELETE FROM scheduled_deliveries WHERE vendor_id=$1', [value.vendorId]);
    const leave = service();
    const created = await requestContextStore.run({ correlationId: randomUUID() }, () => leave.create(actor(value), value.vendorId, value.householdId, {
      startDate: '2030-01-01', endDate: '2030-01-08', subscriptionIds: [value.subscriptionId],
    }));
    for (const serviceDate of ['2030-01-01', '2030-01-08']) {
      await transactions.run(value.vendorId, async (tx) => {
        const target = scheduleTarget(value, serviceDate);
        const effective = await schedulingLeave.effectiveOccurrences(tx, value.vendorId, serviceDate, [target]);
        await scheduledDeliveries.reconcile(tx, value.vendorId, serviceDate, [target], effective);
      });
    }
    assert.deepEqual((await owner.query<{ status: string; source: string }>(`SELECT d.status,e.source FROM scheduled_deliveries d JOIN delivery_events e
      ON e.vendor_id=d.vendor_id AND e.scheduled_delivery_id=d.id WHERE d.vendor_id=$1 ORDER BY d.service_date`, [value.vendorId])).rows,
    [{ status: 'skipped_by_customer', source: 'system' }, { status: 'skipped_by_customer', source: 'system' }]);

    const amended = await requestContextStore.run({ correlationId: randomUUID() }, () => leave.amend(actor(value), value.vendorId, value.householdId, created.id, {
      startDate: '2030-01-08', endDate: '2030-01-08', subscriptionIds: [value.subscriptionId], expectedVersion: created.version,
    }));
    assert.deepEqual((await owner.query<{ status: string }>('SELECT status FROM scheduled_deliveries WHERE vendor_id=$1 ORDER BY service_date', [value.vendorId])).rows,
      [{ status: 'scheduled' }, { status: 'skipped_by_customer' }]);

    await requestContextStore.run({ correlationId: randomUUID() }, () => leave.cancel(actor(value), value.vendorId, value.householdId, created.id, { expectedVersion: amended.version }));
    assert.deepEqual((await owner.query<{ status: string }>('SELECT status FROM scheduled_deliveries WHERE vendor_id=$1 ORDER BY service_date', [value.vendorId])).rows,
      [{ status: 'scheduled' }, { status: 'scheduled' }]);
  } finally {
    await cleanup(value);
  }
});

void test('late amendment approval reverses a leave skip and rejected cancellation preserves remaining leave', async () => {
  const value = await fixture('late-reversal');
  try {
    const created = await requestContextStore.run({ correlationId: randomUUID() }, () => service().create(actor(value), value.vendorId, value.householdId, {
      startDate: '2030-01-01', endDate: '2030-01-08', subscriptionIds: [value.subscriptionId],
    }));
    const late = service(notificationStore, { now: new Date('2030-01-01T07:00:00.000Z'), skipCutoffMinutes: 10_080 });
    const amended = await requestContextStore.run({ correlationId: randomUUID() }, () => late.amend(actor(value), value.vendorId, value.householdId, created.id, {
      startDate: '2030-01-08', endDate: '2030-01-08', subscriptionIds: [value.subscriptionId], expectedVersion: created.version,
    }));
    assert.equal(amended.currentStatus, 'partially_pending');
    assert.equal(await transactions.run(value.vendorId, (tx) => leaves.isEffectivelyOnLeave(tx, {
      vendorId: value.vendorId, subscriptionId: value.subscriptionId, deliverySlotId: value.slotId, serviceDate: '2030-01-01',
    })), true);
    assert.deepEqual((await owner.query<{ serviceDate: string; status: string }>('SELECT service_date::text AS "serviceDate",status FROM scheduled_deliveries WHERE vendor_id=$1 ORDER BY service_date', [value.vendorId])).rows,
      [{ serviceDate: '2030-01-01', status: 'skipped_by_customer' }, { serviceDate: '2030-01-08', status: 'skipped_by_customer' }]);
    const amendmentDecision = (await owner.query<{ id: string; previousStatus: string; requestedStatus: string }>(`SELECT id,previous_effective_status AS "previousStatus",requested_effective_status AS "requestedStatus"
      FROM leave_occurrence_decisions WHERE vendor_id=$1 AND leave_request_revision_id=$2`, [value.vendorId, amended.currentRevisionId])).rows[0];
    assert(amendmentDecision);
    assert.deepEqual({ previousStatus: amendmentDecision.previousStatus, requestedStatus: amendmentDecision.requestedStatus },
      { previousStatus: 'skipped_by_customer', requestedStatus: 'scheduled' });
    await requestContextStore.run({ correlationId: randomUUID() }, () => late.decideOccurrence({ ...actor(value), memberships: [] }, value.vendorId, amendmentDecision.id, {
      expectedVersion: 1, decision: 'approved', reason: 'Approve removal',
    }));
    const vendorEvent = (await owner.query<{ source: string; actorUserId: string }>(`SELECT source,actor_user_id AS "actorUserId" FROM delivery_events
      WHERE vendor_id=$1 AND scheduled_delivery_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [value.vendorId, value.firstDeliveryId])).rows[0];
    assert.deepEqual(vendorEvent, { source: 'vendor_admin', actorUserId: value.customerUserId });
    assert.deepEqual((await owner.query<{ status: string }>('SELECT status FROM scheduled_deliveries WHERE vendor_id=$1 ORDER BY service_date', [value.vendorId])).rows,
      [{ status: 'scheduled' }, { status: 'skipped_by_customer' }]);

    const cancelled = await requestContextStore.run({ correlationId: randomUUID() }, () => late.cancel(actor(value), value.vendorId, value.householdId, created.id, { expectedVersion: amended.version + 1 }));
    assert.equal(cancelled.currentStatus, 'pending_approval');
    const cancellationDecision = (await owner.query<{ id: string }>('SELECT id FROM leave_occurrence_decisions WHERE vendor_id=$1 AND leave_request_revision_id=$2', [value.vendorId, cancelled.currentRevisionId])).rows[0];
    assert(cancellationDecision);
    await requestContextStore.run({ correlationId: randomUUID() }, () => late.decideOccurrence({ ...actor(value), memberships: [] }, value.vendorId, cancellationDecision.id, {
      expectedVersion: 1, decision: 'rejected', reason: 'Keep remaining leave',
    }));
    const final = await transactions.run(value.vendorId, (tx) => leaves.getRequest(tx, value.vendorId, value.householdId, created.id));
    assert.equal(final.status, 'accepted');
    assert.deepEqual((await owner.query<{ status: string }>('SELECT status FROM scheduled_deliveries WHERE vendor_id=$1 ORDER BY service_date', [value.vendorId])).rows,
      [{ status: 'scheduled' }, { status: 'skipped_by_customer' }]);
  } finally {
    await cleanup(value);
  }
});
