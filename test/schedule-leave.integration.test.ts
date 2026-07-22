import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { DefaultSchedulingLeaveService } from '../src/leave/application/scheduling-leave.service.js';
import { PrismaLeaveStore } from '../src/leave/infrastructure/prisma-leave.store.js';
import { PrismaScheduledDeliveryStore } from '../src/scheduling/infrastructure/prisma-scheduled-delivery.store.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const leaves = new PrismaLeaveStore();
const schedulingLeave = new DefaultSchedulingLeaveService(leaves);
const deliveries = new PrismaScheduledDeliveryStore();

test.after(() => Promise.all([owner.end(), prisma.$disconnect()]));

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(label: string) {
  const value = {
    vendorId: randomUUID(), userId: randomUUID(), householdId: randomUUID(), unitId: randomUUID(),
    productId: randomUUID(), slotId: randomUUID(), subscriptionId: randomUUID(), revisionId: randomUUID(),
  };
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [value.userId, `Schedule leave ${label}`]);
    await client.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
      VALUES($1,$2,$2,$2,'active','UTC','USD',60,1,now())`, [value.vendorId, `schedule-leave-${label}-${value.vendorId.slice(0, 8)}`]);
    await client.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at)
      VALUES($1,$2,$3,$3,'Road','Pune','MH','411001','IN',now())`, [value.householdId, value.vendorId, `SL-${label}`]);
    await client.query('INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,$3,$3,3,now())', [value.unitId, value.vendorId, 'LITRE']);
    await client.query('INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,$3,$3,$4,now())', [value.productId, value.vendorId, 'MILK', value.unitId]);
    await client.query("INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'AM','Morning','06:00','09:00',now())", [value.slotId, value.vendorId]);
    await client.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [value.subscriptionId, value.vendorId, value.householdId]);
    await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [value.revisionId, value.vendorId, value.subscriptionId, value.productId, value.unitId, value.slotId, value.userId]);
    await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,2)', [value.vendorId, value.revisionId]);
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
    for (const table of ['delivery_events', 'scheduled_deliveries']) await client.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [value.vendorId]);
    await client.query('UPDATE leave_requests SET current_revision_id=NULL WHERE vendor_id=$1', [value.vendorId]);
    for (const table of ['leave_occurrence_decisions', 'leave_revision_subscriptions', 'leave_request_revisions', 'leave_requests', 'subscription_revision_weekdays', 'subscription_revisions', 'subscriptions', 'products', 'units', 'delivery_slots', 'households']) {
      await client.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [value.vendorId]);
    }
    await client.query('DELETE FROM vendors WHERE id=$1', [value.vendorId]);
    await client.query('DELETE FROM users WHERE id=$1', [value.userId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function target(value: Fixture) {
  return {
    subscriptionId: value.subscriptionId, revisionId: value.revisionId, householdId: value.householdId,
    productId: value.productId, unitId: value.unitId, deliverySlotId: value.slotId, plannedQuantity: '1',
    routeAssignmentId: null,
  };
}

async function addTarget(value: Fixture) {
  const subscriptionId = randomUUID();
  const revisionId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [subscriptionId, value.vendorId, value.householdId]);
    await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [revisionId, value.vendorId, subscriptionId, value.productId, value.unitId, value.slotId, value.userId]);
    await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,2)', [value.vendorId, revisionId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { ...target(value), subscriptionId, revisionId };
}

async function createBatchLeave(
  value: Fixture,
  candidate: ReturnType<typeof target>,
  input: Readonly<{
    status: 'accepted' | 'pending_approval' | 'partially_pending' | 'cancelled';
    selected?: boolean;
    decision?: 'pending' | 'rejected' | 'approved';
  }>,
) {
  const requestId = randomUUID();
  const revisionId = randomUUID();
  const request = await transactions.run(value.vendorId, (tx) => leaves.createRevision(tx, {
    vendorId: value.vendorId, householdId: value.householdId, requestId, revisionId,
    action: input.status === 'cancelled' ? 'cancel' : 'create', source: 'customer', createdBy: value.userId,
    startDate: '2030-01-01', endDate: '2030-01-01',
    subscriptions: [{ subscriptionId: candidate.subscriptionId, selected: input.selected ?? true }], status: input.status,
    decisions: input.decision ? [{
      id: randomUUID(), subscriptionId: candidate.subscriptionId, serviceDate: '2030-01-01', deliverySlotId: candidate.deliverySlotId,
      cutoffAt: new Date('2029-12-31T23:00:00.000Z'),
      status: input.decision === 'rejected' ? 'rejected' : 'pending',
      previousEffectiveStatus: 'scheduled', requestedEffectiveStatus: 'skipped_by_customer',
    }] : [],
  }));
  if (input.decision === 'approved') {
    await owner.query("UPDATE leave_occurrence_decisions SET status='approved',decided_by=$2,decided_at=now(),decision_reason='approved' WHERE vendor_id=$1 AND leave_request_revision_id=$3", [value.vendorId, value.userId, revisionId]);
  }
  return { requestId, revisionId, version: request.version };
}

async function createLeave(value: Fixture, status: 'accepted' | 'pending_approval' | 'rejected') {
  await transactions.run(value.vendorId, (tx) => leaves.createRevision(tx, {
    vendorId: value.vendorId, householdId: value.householdId, requestId: randomUUID(), revisionId: randomUUID(),
    action: 'create', source: 'customer', createdBy: value.userId, startDate: '2030-01-01', endDate: '2030-01-01',
    subscriptions: [{ subscriptionId: value.subscriptionId, selected: true }], status,
    decisions: status === 'accepted' ? [] : [{
      id: randomUUID(), subscriptionId: value.subscriptionId, serviceDate: '2030-01-01', deliverySlotId: value.slotId,
      cutoffAt: new Date('2029-12-31T23:00:00.000Z'),
      status: status === 'pending_approval' ? 'pending' : 'rejected',
    }],
  }));
}

void test('generation projects only effective leave and records a system customer-skip event', async () => {
  const values = [await fixture('accepted'), await fixture('pending'), await fixture('rejected')];
  try {
    await Promise.all([
      createLeave(values[0], 'accepted'),
      createLeave(values[1], 'pending_approval'),
      createLeave(values[2], 'rejected'),
    ]);
    for (const value of values) {
      await transactions.run(value.vendorId, async (tx) => {
        const effective = await schedulingLeave.effectiveOccurrences(tx, value.vendorId, '2030-01-01', [target(value)]);
        await deliveries.reconcile(tx, value.vendorId, '2030-01-01', [target(value)], effective);
      });
    }
    const states = await owner.query<{ status: string; source: string | null; reasonCode: string | null }>(`
      SELECT d.status,e.source,e.reason_code AS "reasonCode" FROM scheduled_deliveries d
      LEFT JOIN delivery_events e ON e.vendor_id=d.vendor_id AND e.scheduled_delivery_id=d.id
      WHERE d.vendor_id=ANY($1::uuid[]) ORDER BY d.vendor_id`, [values.map(({ vendorId }) => vendorId).sort()]);
    const byVendor = new Map(states.rows.map((row, index) => [values.map(({ vendorId }) => vendorId).sort()[index], row]));
    assert.deepEqual(byVendor.get(values[0].vendorId), { status: 'skipped_by_customer', source: 'system', reasonCode: 'customer_on_leave' });
    assert.deepEqual(byVendor.get(values[1].vendorId), { status: 'scheduled', source: null, reasonCode: null });
    assert.deepEqual(byVendor.get(values[2].vendorId), { status: 'scheduled', source: null, reasonCode: null });
  } finally {
    await Promise.all(values.map(cleanup));
  }
});

void test('regeneration applies accepted leave to an existing eligible row and preserves agent-finalized outcomes', async () => {
  const values = [await fixture('existing'), await fixture('finalized')];
  try {
    for (const value of values) {
      await transactions.run(value.vendorId, (tx) => deliveries.reconcile(tx, value.vendorId, '2030-01-01', [target(value)], new Set()));
    }
    await owner.query("UPDATE scheduled_deliveries SET status='delivered',finalized_at=now() WHERE vendor_id=$1", [values[1].vendorId]);
    await Promise.all(values.map((value) => createLeave(value, 'accepted')));
    for (const value of values) {
      await transactions.run(value.vendorId, async (tx) => {
        const effective = await schedulingLeave.effectiveOccurrences(tx, value.vendorId, '2030-01-01', [target(value)]);
        await deliveries.reconcile(tx, value.vendorId, '2030-01-01', [target(value)], effective);
      });
    }
    const rows = await owner.query<{ vendorId: string; status: string }>('SELECT vendor_id AS "vendorId",status FROM scheduled_deliveries WHERE vendor_id=ANY($1::uuid[])', [values.map(({ vendorId }) => vendorId)]);
    const status = new Map(rows.rows.map((row) => [row.vendorId, row.status]));
    assert.equal(status.get(values[0].vendorId), 'skipped_by_customer');
    assert.equal(status.get(values[1].vendorId), 'delivered');
  } finally {
    await Promise.all(values.map(cleanup));
  }
});

void test('batch resolution honors current decisions, selected baseline, current revision, and tenant scope', async () => {
  const value = await fixture('batch');
  const foreign = await fixture('batch-foreign');
  try {
    const accepted = target(value);
    const pending = await addTarget(value);
    const rejected = await addTarget(value);
    const approved = await addTarget(value);
    const cancelled = await addTarget(value);
    const decisionOverBaseline = await addTarget(value);
    const currentRevision = await addTarget(value);

    await createBatchLeave(value, accepted, { status: 'accepted' });
    await createBatchLeave(value, pending, { status: 'pending_approval', decision: 'pending' });
    await createBatchLeave(value, rejected, { status: 'accepted', decision: 'rejected' });
    await createBatchLeave(value, approved, { status: 'partially_pending', decision: 'approved' });
    await createBatchLeave(value, cancelled, { status: 'cancelled' });
    await createBatchLeave(value, decisionOverBaseline, { status: 'partially_pending', selected: false, decision: 'approved' });
    const old = await createBatchLeave(value, currentRevision, { status: 'accepted' });
    await transactions.run(value.vendorId, (tx) => leaves.createRevision(tx, {
      vendorId: value.vendorId, householdId: value.householdId, requestId: old.requestId, revisionId: randomUUID(),
      previousRevisionId: old.revisionId, expectedVersion: old.version, action: 'amend', source: 'customer', createdBy: value.userId,
      startDate: '2030-01-01', endDate: '2030-01-01', subscriptions: [{ subscriptionId: currentRevision.subscriptionId, selected: false }],
      status: 'accepted', decisions: [],
    }));

    const candidates = [accepted, pending, rejected, approved, cancelled, decisionOverBaseline, currentRevision, target(foreign)];
    const effective = await transactions.run(value.vendorId, (tx) => schedulingLeave.effectiveOccurrences(
      tx,
      value.vendorId,
      '2030-01-01',
      candidates,
    ));

    assert.deepEqual(effective, new Set([
      `${accepted.subscriptionId}:${accepted.deliverySlotId}`,
      `${approved.subscriptionId}:${approved.deliverySlotId}`,
      `${decisionOverBaseline.subscriptionId}:${decisionOverBaseline.deliverySlotId}`,
    ]));
  } finally {
    await Promise.all([cleanup(value), cleanup(foreign)]);
  }
});
