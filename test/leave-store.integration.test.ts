import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { unwrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import { PrismaLeaveStore } from '../src/leave/infrastructure/prisma-leave.store.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const store = new PrismaLeaveStore();
test.after(() => Promise.all([owner.end(), prisma.$disconnect()]));

type Fixture = Readonly<{ vendorId: string; householdId: string; userId: string; unitId: string; productId: string; subscriptionId: string; subscriptionRevisionId: string; slotId: string }>;

async function fixture(label: string): Promise<Fixture> {
  const vendorId = randomUUID(); const householdId = randomUUID(); const userId = randomUUID();
  const unitId = randomUUID(); const productId = randomUUID(); const slotId = randomUUID(); const subscriptionId = randomUUID(); const revisionId = randomUUID();
  await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [userId, `Leave ${label}`]);
  await owner.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
    VALUES($1,$2,$2,$2,'active','Asia/Kolkata','INR',60,1,now())`, [vendorId, `leave-${label}-${vendorId.slice(0, 8)}`]);
  await owner.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at)
    VALUES($1,$2,$3,$3,'Road','Pune','MH','411001','IN',now())`, [householdId, vendorId, `HH-${label}`]);
  await owner.query('INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,$3,$3,3,now())', [unitId, vendorId, 'UNIT']);
  await owner.query('INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,$3,$3,$4,now())', [productId, vendorId, 'PRODUCT', unitId]);
  await owner.query(`INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
    VALUES($1,$2,$3,$3,'06:00','09:00',now())`, [slotId, vendorId, 'SLOT']);
  await owner.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [subscriptionId, vendorId, householdId]);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [revisionId, vendorId, subscriptionId, productId, unitId, slotId, userId]);
    await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,2)', [vendorId, revisionId]);
    await client.query('COMMIT');
  } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  return { vendorId, householdId, userId, unitId, productId, subscriptionId, subscriptionRevisionId: revisionId, slotId };
}

async function cleanup(value: Fixture) {
  await owner.query('DELETE FROM scheduled_deliveries WHERE vendor_id=$1', [value.vendorId]);
  await owner.query('UPDATE leave_requests SET current_revision_id=NULL WHERE vendor_id=$1', [value.vendorId]);
  for (const table of ['leave_occurrence_decisions', 'leave_revision_subscriptions', 'leave_request_revisions', 'leave_requests'])
    await owner.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [value.vendorId]);
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query('DELETE FROM subscription_revision_weekdays WHERE vendor_id=$1', [value.vendorId]);
    await client.query('DELETE FROM subscription_revisions WHERE vendor_id=$1', [value.vendorId]);
    await client.query('COMMIT');
  } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  for (const table of ['subscriptions', 'products', 'units', 'delivery_slots', 'households'])
    await owner.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [value.vendorId]);
  await owner.query('DELETE FROM vendors WHERE id=$1', [value.vendorId]);
  await owner.query('DELETE FROM users WHERE id=$1', [value.userId]);
}

function revision(current: Fixture, values: Readonly<{ requestId: string; revisionId: string; action?: 'create' | 'amend' | 'cancel'; previousRevisionId?: string; status?: 'accepted' | 'pending_approval' | 'partially_pending' | 'cancelled'; startDate?: string; endDate?: string; subscriptions?: readonly Readonly<{ subscriptionId: string; selected: boolean }>[]; decisions?: readonly Readonly<{ id: string; serviceDate: string; deliverySlotId: string; status: 'pending' | 'rejected'; subscriptionId?: string; previousEffectiveStatus?: 'scheduled' | 'skipped_by_customer'; requestedEffectiveStatus?: 'scheduled' | 'skipped_by_customer' }>[] }>) {
  return {
    vendorId: current.vendorId, householdId: current.householdId, requestId: values.requestId, revisionId: values.revisionId,
    action: values.action ?? 'create', previousRevisionId: values.previousRevisionId, source: 'customer' as const,
    createdBy: current.userId, startDate: values.startDate ?? '2030-01-01', endDate: values.endDate ?? '2030-01-31',
    subscriptions: values.subscriptions ?? [{ subscriptionId: current.subscriptionId, selected: true }],
    status: values.status ?? 'accepted', expectedVersion: values.previousRevisionId ? 1 : undefined,
    decisions: values.decisions ?? [],
  };
}

function rejectsWithCode(work: () => Promise<unknown>, code: string) {
  return assert.rejects(work, (cause: unknown) => {
    assert(cause && typeof cause === 'object' && 'code' in cause);
    assert.equal(cause.code, code);
    return true;
  });
}

function rejectsWithCodeAndStatus(work: () => Promise<unknown>, code: string, status: number) {
  return assert.rejects(work, (cause: unknown) => {
    assert(cause && typeof cause === 'object' && 'code' in cause && 'status' in cause);
    assert.equal(cause.code, code); assert.equal(cause.status, status);
    return true;
  });
}

void test('leave store scopes active household subscriptions, persists append-only revisions, and rejects overlap', async () => {
  const current = await fixture('store'); const requestId = randomUUID(); const firstRevisionId = randomUUID(); const retainedSubscriptionId = randomUUID();
  try {
    await owner.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [retainedSubscriptionId, current.vendorId, current.householdId]);
    await transactions.run(current.vendorId, async (tx) => {
      await rejectsWithCode(() => store.lockSubscriptions(tx, current.vendorId, []), 'LEAVE_SUBSCRIPTION_SELECTION');
      await rejectsWithCode(() => store.lockSubscriptions(tx, current.vendorId, [current.subscriptionId, current.subscriptionId]), 'LEAVE_SUBSCRIPTION_SELECTION');
      await store.lockSubscriptions(tx, current.vendorId, [current.subscriptionId]);
      const preview = await store.preview(tx, {
        vendorId: current.vendorId, householdId: current.householdId, subscriptionIds: [current.subscriptionId],
        startDate: '2030-01-01', endDate: '2030-01-31', timezone: 'Asia/Kolkata', skipCutoffMinutes: 60,
        lateLeavePolicy: 'approval', now: new Date('2029-12-31T23:30:00.001Z'), limit: 1,
      });
      assert.deepEqual(preview.items.map((item) => item.serviceDate), ['2030-01-01']);
      assert.deepEqual({ onTimeCount: preview.onTimeCount, lateCount: preview.lateCount }, { onTimeCount: 4, lateCount: 1 });
      const next = await store.preview(tx, {
        vendorId: current.vendorId, householdId: current.householdId, subscriptionIds: [current.subscriptionId],
        startDate: '2030-01-01', endDate: '2030-01-31', timezone: 'Asia/Kolkata', skipCutoffMinutes: 60,
        lateLeavePolicy: 'approval', now: new Date('2029-12-31T23:30:00.001Z'), limit: 1, cursor: preview.nextCursor,
      });
      assert.deepEqual(next.items.map((item) => item.serviceDate), ['2030-01-08']);
      assert.deepEqual({ onTimeCount: next.onTimeCount, lateCount: next.lateCount }, { onTimeCount: 4, lateCount: 1 });
      const created = await store.createRevision(tx, revision(current, { requestId, revisionId: firstRevisionId, subscriptions: [
        { subscriptionId: current.subscriptionId, selected: true },
        { subscriptionId: retainedSubscriptionId, selected: false },
      ] }));
      assert.equal(created.status, 'accepted');
      assert.equal(created.revisions.length, 1);
      assert.deepEqual(created.revisions[0]?.subscriptions, [
        { subscriptionId: current.subscriptionId, selected: true },
        { subscriptionId: retainedSubscriptionId, selected: false },
      ].sort((left, right) => left.subscriptionId.localeCompare(right.subscriptionId)));
      assert.deepEqual(created.revisions[0]?.subscriptionIds, [current.subscriptionId]);
      assert.equal(await store.isEffectivelyOnLeave(tx, {
        vendorId: current.vendorId, subscriptionId: current.subscriptionId, deliverySlotId: current.slotId, serviceDate: '2030-01-01',
      }), true);
      assert.equal(await store.isEffectivelyOnLeave(tx, {
        vendorId: current.vendorId, subscriptionId: retainedSubscriptionId, deliverySlotId: current.slotId, serviceDate: '2030-01-01',
      }), false);
    });
    await transactions.run(current.vendorId, async (tx) => {
      await store.lockSubscriptions(tx, current.vendorId, [current.subscriptionId]);
      await rejectsWithCode(() => store.createRevision(tx, revision(current, { requestId: randomUUID(), revisionId: randomUUID() })), 'LEAVE_OVERLAP');
    });
    await transactions.run(current.vendorId, async (tx) => {
      await store.lockSubscriptions(tx, current.vendorId, [current.subscriptionId]);
      const amended = await store.createRevision(tx, revision(current, {
        requestId, revisionId: randomUUID(), action: 'amend', previousRevisionId: firstRevisionId,
      }));
      assert.equal(amended.revisions.length, 2);
      assert.equal(amended.currentRevisionId, amended.revisions[0]?.id);
      assert.equal(await store.isEffectivelyOnLeave(tx, {
        vendorId: current.vendorId, subscriptionId: current.subscriptionId, deliverySlotId: current.slotId, serviceDate: '2030-01-01',
      }), true);
      const competing = await store.createRevision(tx, {
        ...revision(current, { requestId: randomUUID(), revisionId: randomUUID() }),
        startDate: '2030-02-01', endDate: '2030-02-28',
      });
      assert.equal(competing.status, 'accepted');
      await rejectsWithCodeAndStatus(() => store.createRevision(tx, {
        ...revision(current, { requestId, revisionId: randomUUID(), action: 'amend', previousRevisionId: firstRevisionId }),
        startDate: '2030-02-01', endDate: '2030-02-28',
      }), 'LEAVE_REQUEST_VERSION_CONFLICT', 409);
    });
  } finally { await cleanup(current); }
});

void test('approved late amendment becomes effective and cancelled requests reject further lifecycle changes', async () => {
  const current = await fixture('amend-lifecycle'); const requestId = randomUUID(); const createdRevisionId = randomUUID();
  try {
    await transactions.run(current.vendorId, async (tx) => {
      await store.createRevision(tx, revision(current, { requestId, revisionId: createdRevisionId }));
      const amendmentRevisionId = randomUUID(); const decisionId = randomUUID();
      await store.createRevision(tx, revision(current, {
        requestId, revisionId: amendmentRevisionId, action: 'amend', previousRevisionId: createdRevisionId,
        status: 'pending_approval', decisions: [{ id: decisionId, serviceDate: '2030-01-01', deliverySlotId: current.slotId, status: 'pending' }],
      }));
      assert.equal(await store.isEffectivelyOnLeave(tx, {
        vendorId: current.vendorId, subscriptionId: current.subscriptionId, deliverySlotId: current.slotId, serviceDate: '2030-01-01',
      }), false);
      await store.decide(tx, { vendorId: current.vendorId, id: decisionId, expectedVersion: 1, decision: 'approved', decidedBy: current.userId, reason: 'Approved late amendment', now: new Date() });
      assert.equal(await store.isEffectivelyOnLeave(tx, {
        vendorId: current.vendorId, subscriptionId: current.subscriptionId, deliverySlotId: current.slotId, serviceDate: '2030-01-01',
      }), true);
      const cancelled = await store.createRevision(tx, { ...revision(current, {
        requestId, revisionId: randomUUID(), action: 'cancel', previousRevisionId: amendmentRevisionId, status: 'cancelled',
      }), expectedVersion: 3 });
      const cancellationRevisionId = cancelled.currentRevisionId;
      assert.ok(cancellationRevisionId);
      assert.equal(await store.isEffectivelyOnLeave(tx, {
        vendorId: current.vendorId, subscriptionId: current.subscriptionId, deliverySlotId: current.slotId, serviceDate: '2030-01-01',
      }), false);
    });
    await owner.query("UPDATE subscription_revisions SET status='paused' WHERE id=$1", [current.subscriptionRevisionId]);
    await transactions.run(current.vendorId, async (tx) => {
      const cancelled = await store.getRequest(tx, current.vendorId, current.householdId, requestId);
      const cancellationRevisionId = cancelled.currentRevisionId;
      assert.ok(cancellationRevisionId);
      const next = { ...revision(current, { requestId, revisionId: randomUUID(), action: 'cancel', previousRevisionId: cancellationRevisionId }), expectedVersion: cancelled.version };
      await rejectsWithCodeAndStatus(() => store.createRevision(tx, next), 'LEAVE_REQUEST_STATE_CONFLICT', 409);
      await rejectsWithCodeAndStatus(() => store.createRevision(tx, { ...next, revisionId: randomUUID(), action: 'amend' }), 'LEAVE_REQUEST_STATE_CONFLICT', 409);
      await rejectsWithCodeAndStatus(() => store.createRevision(tx, { ...next, revisionId: randomUUID(), expectedVersion: cancelled.version - 1 }), 'LEAVE_REQUEST_VERSION_CONFLICT', 409);
    });
  } finally { await cleanup(current); }
});

void test('leave selection requires an active unsuperseded revision applicable to the range', async () => {
  const current = await fixture('inactive-plan');
  try {
    await owner.query("UPDATE subscription_revisions SET status='paused' WHERE id=$1", [current.subscriptionRevisionId]);
    await transactions.run(current.vendorId, async (tx) => {
      const input = {
        vendorId: current.vendorId, householdId: current.householdId, subscriptionIds: [current.subscriptionId],
        startDate: '2030-01-01', endDate: '2030-01-31', timezone: 'Asia/Kolkata', skipCutoffMinutes: 60,
        lateLeavePolicy: 'approval' as const, now: new Date('2029-12-31T00:00:00.000Z'),
      };
      await rejectsWithCode(() => store.preview(tx, input), 'LEAVE_SUBSCRIPTION_NOT_ACTIVE');
      await rejectsWithCode(() => store.createRevision(tx, revision(current, { requestId: randomUUID(), revisionId: randomUUID() })), 'LEAVE_SUBSCRIPTION_NOT_ACTIVE');
    });
  } finally { await cleanup(current); }
});

void test('late decisions are explicit, versioned, cursor-stable, and tenant-neutral', async () => {
  const current = await fixture('decisions'); const requestId = randomUUID();
  const secondSubscriptionId = randomUUID(); const secondSubscriptionRevisionId = randomUUID();
  const firstDecisionId = '00000000-0000-4000-8000-000000000001';
  const secondDecisionId = '00000000-0000-4000-8000-000000000002';
  const other = await fixture('other');
  try {
    await owner.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [secondSubscriptionId, current.vendorId, current.householdId]);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [secondSubscriptionRevisionId, current.vendorId, secondSubscriptionId, current.productId, current.unitId, current.slotId, current.userId]);
      await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,2)', [current.vendorId, secondSubscriptionRevisionId]);
      await client.query('COMMIT');
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
    await transactions.run(current.vendorId, async (tx) => {
      await store.createRevision(tx, { ...revision(current, {
        requestId, revisionId: randomUUID(), status: 'pending_approval', decisions: [
          { id: firstDecisionId, serviceDate: '2030-01-01', deliverySlotId: current.slotId, status: 'pending', subscriptionId: current.subscriptionId },
          { id: secondDecisionId, serviceDate: '2030-01-01', deliverySlotId: current.slotId, status: 'pending', subscriptionId: secondSubscriptionId },
        ],
      }), subscriptions: [
        { subscriptionId: current.subscriptionId, selected: true },
        { subscriptionId: secondSubscriptionId, selected: true },
      ] });
      const pending = await store.listPendingDecisions(tx, { vendorId: current.vendorId, limit: 1 });
      assert.equal(pending.items[0]?.id, firstDecisionId);
      const next = await store.listPendingDecisions(tx, { vendorId: current.vendorId, limit: 1, cursor: pending.nextCursor });
      assert.equal(next.items[0]?.id, secondDecisionId);
      const decided = await store.decide(tx, { vendorId: current.vendorId, id: firstDecisionId, expectedVersion: 1,
        decision: 'approved', decidedBy: current.userId, reason: 'Customer emergency approved', now: new Date('2030-01-01T00:00:00.000Z') });
      assert.equal(decided.status, 'approved');
      assert.equal(decided.request.status, 'partially_pending');
    });
    await transactions.run(other.vendorId, async (tx) => {
      await rejectsWithCode(() => store.getRequest(tx, other.vendorId, other.householdId, requestId), 'LEAVE_REQUEST_NOT_FOUND');
    });
  } finally { await cleanup(current); await cleanup(other); }
});

void test('mixed amendment decisions recompute status from the current selected baseline', async () => {
  const current = await fixture('mixed-decision-status'); const requestId = randomUUID(); const createdRevisionId = randomUUID();
  const replacementSubscriptionId = randomUUID(); const replacementRevisionId = randomUUID();
  const removalDecisionId = randomUUID(); const additionDecisionId = randomUUID();
  try {
    await owner.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [replacementSubscriptionId, current.vendorId, current.householdId]);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [replacementRevisionId, current.vendorId, replacementSubscriptionId, current.productId, current.unitId, current.slotId, current.userId]);
      await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,2)', [current.vendorId, replacementRevisionId]);
      await client.query('COMMIT');
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
    await transactions.run(current.vendorId, async (tx) => {
      await store.createRevision(tx, revision(current, { requestId, revisionId: createdRevisionId, startDate: '2030-01-01', endDate: '2030-01-01' }));
      const amendedRevisionId = randomUUID();
      await store.createRevision(tx, revision(current, {
        requestId, revisionId: amendedRevisionId, action: 'amend', previousRevisionId: createdRevisionId,
        startDate: '2030-01-01', endDate: '2030-01-01',
        status: 'partially_pending', subscriptions: [
          { subscriptionId: current.subscriptionId, selected: false },
          { subscriptionId: replacementSubscriptionId, selected: true },
        ], decisions: [
          { id: removalDecisionId, subscriptionId: current.subscriptionId, serviceDate: '2030-01-01', deliverySlotId: current.slotId,
            status: 'pending', previousEffectiveStatus: 'skipped_by_customer', requestedEffectiveStatus: 'scheduled' },
          { id: additionDecisionId, subscriptionId: replacementSubscriptionId, serviceDate: '2030-01-01', deliverySlotId: current.slotId,
            status: 'pending', previousEffectiveStatus: 'scheduled', requestedEffectiveStatus: 'skipped_by_customer' },
        ],
      }));
      const afterRemoval = await store.decide(tx, { vendorId: current.vendorId, id: removalDecisionId, expectedVersion: 1,
        decision: 'approved', decidedBy: current.userId, reason: 'Approve removal', now: new Date() });
      assert.equal(afterRemoval.request.status, 'pending_approval');
      const afterAddition = await store.decide(tx, { vendorId: current.vendorId, id: additionDecisionId, expectedVersion: 1,
        decision: 'rejected', decidedBy: current.userId, reason: 'Reject replacement', now: new Date() });
      assert.equal(afterAddition.request.status, 'rejected');
    });
  } finally { await cleanup(current); }
});

void test('same-subscription decisions recompute status at occurrence granularity', async () => {
  const current = await fixture('occurrence-status');
  try {
    await transactions.run(current.vendorId, async (tx) => {
      const twoLateRequestId = randomUUID(); const firstDecisionId = randomUUID(); const secondDecisionId = randomUUID();
      await store.createRevision(tx, revision(current, {
        requestId: twoLateRequestId, revisionId: randomUUID(), startDate: '2030-01-01', endDate: '2030-01-08', status: 'pending_approval',
        decisions: [
          { id: firstDecisionId, serviceDate: '2030-01-01', deliverySlotId: current.slotId, status: 'pending' },
          { id: secondDecisionId, serviceDate: '2030-01-08', deliverySlotId: current.slotId, status: 'pending' },
        ],
      }));
      const partiallyAccepted = await store.decide(tx, { vendorId: current.vendorId, id: firstDecisionId, expectedVersion: 1,
        decision: 'approved', decidedBy: current.userId, reason: 'Approve one date', now: new Date() });
      assert.equal(partiallyAccepted.request.status, 'partially_pending');
      const accepted = await store.decide(tx, { vendorId: current.vendorId, id: secondDecisionId, expectedVersion: 1,
        decision: 'rejected', decidedBy: current.userId, reason: 'Reject the other date', now: new Date() });
      assert.equal(accepted.request.status, 'accepted');

      const onTimeRequestId = randomUUID(); const rejectedDecisionId = randomUUID();
      await store.createRevision(tx, revision(current, {
        requestId: onTimeRequestId, revisionId: randomUUID(), startDate: '2030-02-05', endDate: '2030-02-12', status: 'partially_pending',
        decisions: [{ id: rejectedDecisionId, serviceDate: '2030-02-05', deliverySlotId: current.slotId, status: 'pending' }],
      }));
      const onTimeAccepted = await store.decide(tx, { vendorId: current.vendorId, id: rejectedDecisionId, expectedVersion: 1,
        decision: 'rejected', decidedBy: current.userId, reason: 'Keep the on-time date', now: new Date() });
      assert.equal(onTimeAccepted.request.status, 'accepted');

      const rejectedRequestId = randomUUID(); const rejectedIds = [randomUUID(), randomUUID()];
      await store.createRevision(tx, revision(current, {
        requestId: rejectedRequestId, revisionId: randomUUID(), startDate: '2030-03-05', endDate: '2030-03-12', status: 'pending_approval',
        decisions: rejectedIds.map((id, index) => ({ id, serviceDate: index === 0 ? '2030-03-05' : '2030-03-12', deliverySlotId: current.slotId, status: 'pending' })),
      }));
      for (const id of rejectedIds) await store.decide(tx, { vendorId: current.vendorId, id, expectedVersion: 1,
        decision: 'rejected', decidedBy: current.userId, reason: 'Reject late date', now: new Date() });
      assert.equal((await store.getRequest(tx, current.vendorId, current.householdId, rejectedRequestId)).status, 'rejected');
    });
  } finally { await cleanup(current); }
});

void test('shifted same-subscription range resolves each decision against its exact selected baseline', async () => {
  const current = await fixture('shifted-occurrence-status');
  const requestId = randomUUID(); const createdRevisionId = randomUUID();
  const removalDecisionId = randomUUID(); const additionDecisionId = randomUUID();
  try {
    await transactions.run(current.vendorId, async (tx) => {
      await store.createRevision(tx, revision(current, {
        requestId, revisionId: createdRevisionId, startDate: '2030-01-01', endDate: '2030-01-01',
      }));
      await store.createRevision(tx, revision(current, {
        requestId, revisionId: randomUUID(), action: 'amend', previousRevisionId: createdRevisionId,
        startDate: '2030-01-08', endDate: '2030-01-08', status: 'partially_pending', decisions: [
          { id: removalDecisionId, serviceDate: '2030-01-01', deliverySlotId: current.slotId, status: 'pending',
            previousEffectiveStatus: 'skipped_by_customer', requestedEffectiveStatus: 'scheduled' },
          { id: additionDecisionId, serviceDate: '2030-01-08', deliverySlotId: current.slotId, status: 'pending',
            previousEffectiveStatus: 'scheduled', requestedEffectiveStatus: 'skipped_by_customer' },
        ],
      }));
      const afterRemoval = await store.decide(tx, { vendorId: current.vendorId, id: removalDecisionId, expectedVersion: 1,
        decision: 'rejected', decidedBy: current.userId, reason: 'Keep old date skipped', now: new Date() });
      assert.equal(afterRemoval.request.status, 'partially_pending');
      const afterAddition = await store.decide(tx, { vendorId: current.vendorId, id: additionDecisionId, expectedVersion: 1,
        decision: 'rejected', decidedBy: current.userId, reason: 'Keep new date scheduled', now: new Date() });
      assert.equal(afterAddition.request.status, 'accepted');
    });
  } finally { await cleanup(current); }
});

void test('decision status uses one subscription-revision snapshot for its total and exact baseline', async () => {
  const current = await fixture('decision-snapshot'); const requestId = randomUUID(); const revisionId = randomUUID();
  const decisionId = randomUUID(); const replacementRevisionId = randomUUID();
  try {
    await transactions.run(current.vendorId, (tx) => store.createRevision(tx, revision(current, {
      requestId, revisionId, startDate: '2030-01-01', endDate: '2030-01-01', status: 'pending_approval',
      decisions: [{ id: decisionId, serviceDate: '2030-01-01', deliverySlotId: current.slotId, status: 'pending' }],
    })));
    let replacementCommitted = false;
    const replaceSchedule = async () => {
      if (replacementCommitted) return;
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE subscription_revisions SET effective_to='2030-01-02',superseded_at=now(),
          superseded_by_revision_id=$1,supersession_reason='Correct schedule',updated_at=now() WHERE id=$2`,
        [replacementRevisionId, current.subscriptionRevisionId]);
        await client.query(`INSERT INTO subscription_revisions
          (id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,1,'active','2030-01-02',$7,now())`,
        [replacementRevisionId, current.vendorId, current.subscriptionId, current.productId, current.unitId, current.slotId, current.userId]);
        await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,3)',
          [current.vendorId, replacementRevisionId]);
        await client.query('COMMIT'); replacementCommitted = true;
      } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
    };
    await transactions.run(current.vendorId, async (context) => {
      const tx = unwrapPrismaTransaction(context);
      const mutable = tx as unknown as { $queryRaw: (query: unknown) => Promise<unknown> };
      const original = mutable.$queryRaw;
      let totalRead!: () => void;
      const totalCompleted = new Promise<void>((resolve) => { totalRead = resolve; });
      mutable.$queryRaw = async (query) => {
        const sql = String((query as { sql?: unknown }).sql ?? query);
        const combinedSnapshot = sql.includes('selected_occurrences AS') && sql.includes('selected_decisions AS');
        if (!combinedSnapshot && sql.includes('SELECT d.id FROM leave_occurrence_decisions d')) {
          await totalCompleted;
          return original.call(tx, query);
        }
        const result = await original.call(tx, query);
        if (sql.includes('SELECT array_agg(w.weekday ORDER BY w.weekday) AS weekdays')) {
          await replaceSchedule(); totalRead();
        } else if (combinedSnapshot) {
          await replaceSchedule(); totalRead();
        }
        return result;
      };
      try {
        const decided = await store.decide(context, { vendorId: current.vendorId, id: decisionId, expectedVersion: 1,
          decision: 'rejected', decidedBy: current.userId, reason: 'Reject corrected occurrence', now: new Date() });
        assert.equal(decided.request.status, 'rejected');
      } finally { mutable.$queryRaw = original; }
    });
    assert.equal(replacementCommitted, true, 'the schedule replacement must commit at the read boundary');
  } finally { await cleanup(current); }
});

void test('unselected revision associations retain the strong tenant subscription foreign key', async () => {
  const current = await fixture('unselected-fk');
  const foreign = await fixture('unselected-foreign');
  try {
    for (const invalidSubscriptionId of [randomUUID(), foreign.subscriptionId]) {
      await assert.rejects(
        transactions.run(current.vendorId, (tx) => store.createRevision(tx, revision(current, {
          requestId: randomUUID(), revisionId: randomUUID(), subscriptions: [
            { subscriptionId: current.subscriptionId, selected: true },
            { subscriptionId: invalidSubscriptionId, selected: false },
          ],
        }))),
        /leave_revision_subscriptions_subscription_fkey|Foreign key constraint/u,
      );
    }
  } finally { await cleanup(current); await cleanup(foreign); }
});

void test('superseded leave decisions are neither queued nor actionable', async () => {
  const current = await fixture('superseded-decision');
  const requestId = randomUUID(); const firstRevisionId = randomUUID(); const decisionId = randomUUID();
  try {
    await transactions.run(current.vendorId, async (tx) => {
      await store.createRevision(tx, revision(current, {
        requestId, revisionId: firstRevisionId, status: 'pending_approval', decisions: [
          { id: decisionId, serviceDate: '2030-01-01', deliverySlotId: current.slotId, status: 'pending' },
        ],
      }));
      await store.createRevision(tx, revision(current, {
        requestId, revisionId: randomUUID(), action: 'amend', previousRevisionId: firstRevisionId, status: 'accepted',
      }));
      assert.deepEqual((await store.listPendingDecisions(tx, { vendorId: current.vendorId })).items, []);
      await rejectsWithCode(() => store.decide(tx, {
        vendorId: current.vendorId, id: decisionId, expectedVersion: 1, decision: 'approved',
        decidedBy: current.userId, reason: 'Superseded', now: new Date('2030-01-01T00:00:00.000Z'),
      }), 'LEAVE_DECISION_NOT_FOUND');
    });
  } finally { await cleanup(current); }
});

void test('leave decision rejects a finalized matching delivery before mutating the decision', async () => {
  const current = await fixture('finalized'); const requestId = randomUUID(); const decisionId = randomUUID();
  try {
    await transactions.run(current.vendorId, async (tx) => {
      await store.createRevision(tx, revision(current, {
        requestId, revisionId: randomUUID(), status: 'pending_approval', decisions: [
          { id: decisionId, serviceDate: '2030-01-01', deliverySlotId: current.slotId, status: 'pending' },
        ],
      }));
    });
    await owner.query(`INSERT INTO scheduled_deliveries(
      id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,
      service_date,planned_quantity,status,finalized_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'2030-01-01',1,'delivered',now(),now())`, [
      randomUUID(), current.vendorId, current.subscriptionId, current.subscriptionRevisionId, current.householdId,
      current.productId, current.unitId, current.slotId,
    ]);
    await transactions.run(current.vendorId, (tx) => rejectsWithCode(() => store.decide(tx, {
      vendorId: current.vendorId, id: decisionId, expectedVersion: 1, decision: 'approved',
      decidedBy: current.userId, reason: 'Customer emergency approved', now: new Date('2030-01-01T00:00:00.000Z'),
    }), 'LEAVE_OCCURRENCE_FINALIZED'));
  } finally { await cleanup(current); }
});
