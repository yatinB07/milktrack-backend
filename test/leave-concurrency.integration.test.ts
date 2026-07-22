import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { unwrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import { PrismaLeaveStore } from '../src/leave/infrastructure/prisma-leave.store.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService(); const transactions = new PrismaTenantTransactionRunner(prisma); const store = new PrismaLeaveStore();
test.after(() => Promise.all([owner.end(), prisma.$disconnect()]));

function hasCode(value: unknown): value is { code: unknown } {
  return Boolean(value && typeof value === 'object' && 'code' in value);
}

async function deleteSubscriptionRevisions(vendorId: string) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query('DELETE FROM subscription_revision_weekdays WHERE vendor_id=$1', [vendorId]);
    await client.query('DELETE FROM subscription_revisions WHERE vendor_id=$1', [vendorId]);
    await client.query('COMMIT');
  } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
}

void test('concurrent overlap attempts serialize behind sorted subscription locks', { timeout: 5_000 }, async () => {
  const vendorId = randomUUID(); const householdId = randomUUID(); const userId = randomUUID(); const unitId = randomUUID(); const productId = randomUUID(); const slotId = randomUUID(); const subscriptionId = randomUUID(); const subscriptionRevisionId = randomUUID();
  let blocker: pg.PoolClient | undefined;
  try {
    await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [userId, 'Leave concurrency']);
    await owner.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$2,$2,'active','Asia/Kolkata','INR',60,1,now())`, [vendorId, `leave-concurrency-${vendorId.slice(0, 8)}`]);
    await owner.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,'HH','HH','Road','Pune','MH','411001','IN',now())`, [householdId, vendorId]);
    await owner.query('INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,$3,$3,3,now())', [unitId, vendorId, 'UNIT']);
    await owner.query('INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,$3,$3,$4,now())', [productId, vendorId, 'PRODUCT', unitId]);
    await owner.query(`INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'SLOT','Slot','06:00','09:00',now())`, [slotId, vendorId]);
    await owner.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [subscriptionId, vendorId, householdId]);
    const client = await owner.connect(); try { await client.query('BEGIN'); await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [subscriptionRevisionId, vendorId, subscriptionId, productId, unitId, slotId, userId]); await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,2)', [vendorId, subscriptionRevisionId]); await client.query('COMMIT'); } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
    const input = (requestId: string, revisionId: string) => ({ vendorId, householdId, requestId, revisionId, action: 'create' as const, source: 'customer' as const, createdBy: userId, startDate: '2030-01-01', endDate: '2030-01-31', subscriptions: [{ subscriptionId, selected: true }], status: 'accepted' as const, decisions: [] });
    blocker = await owner.connect(); await blocker.query('BEGIN'); await blocker.query('SELECT id FROM subscriptions WHERE id=$1 FOR UPDATE', [subscriptionId]);
    let completed = 0;
    const first = transactions.run(vendorId, (tx) => store.createRevision(tx, input(randomUUID(), randomUUID()))).finally(() => { completed += 1; });
    const second = transactions.run(vendorId, (tx) => store.createRevision(tx, input(randomUUID(), randomUUID()))).finally(() => { completed += 1; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const completedBeforeRelease = completed;
    await blocker.query('COMMIT'); blocker.release(); blocker = undefined;
    const [one, two] = await Promise.allSettled([first, second]);
    assert.equal(completedBeforeRelease, 0, 'direct create must wait for the selected subscription lock');
    assert.equal([one, two].filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = [one, two].find(({ status }) => status === 'rejected');
    const cause: unknown = rejected?.status === 'rejected' ? rejected.reason as unknown : undefined;
    assert(hasCode(cause));
    assert.equal(cause.code, 'LEAVE_OVERLAP');
  } finally {
    if (blocker) { await blocker.query('ROLLBACK'); blocker.release(); }
    await owner.query('UPDATE leave_requests SET current_revision_id=NULL WHERE vendor_id=$1', [vendorId]);
    for (const table of ['leave_occurrence_decisions', 'leave_revision_subscriptions', 'leave_request_revisions', 'leave_requests']) await owner.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [vendorId]);
    await deleteSubscriptionRevisions(vendorId);
    for (const table of ['subscriptions', 'products', 'units', 'delivery_slots', 'households']) await owner.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [vendorId]);
    await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]); await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  }
});

void test('decision and amendment cannot both mutate the same current revision', { timeout: 5_000 }, async () => {
  const vendorId = randomUUID(); const householdId = randomUUID(); const userId = randomUUID(); const unitId = randomUUID();
  const productId = randomUUID(); const slotId = randomUUID(); const subscriptionId = randomUUID(); const subscriptionRevisionId = randomUUID();
  const requestId = randomUUID(); const revisionId = randomUUID(); const decisionId = randomUUID();
  let blocker: pg.PoolClient | undefined;
  try {
    await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [userId, 'Leave decision race']);
    await owner.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$2,$2,'active','Asia/Kolkata','INR',60,1,now())`, [vendorId, `leave-decision-race-${vendorId.slice(0, 8)}`]);
    await owner.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,'HH','HH','Road','Pune','MH','411001','IN',now())`, [householdId, vendorId]);
    await owner.query('INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,$3,$3,3,now())', [unitId, vendorId, 'UNIT']);
    await owner.query('INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,$3,$3,$4,now())', [productId, vendorId, 'PRODUCT', unitId]);
    await owner.query(`INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'SLOT','Slot','06:00','09:00',now())`, [slotId, vendorId]);
    await owner.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [subscriptionId, vendorId, householdId]);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [subscriptionRevisionId, vendorId, subscriptionId, productId, unitId, slotId, userId]);
      await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,2)', [vendorId, subscriptionRevisionId]);
      await client.query('COMMIT');
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
    await transactions.run(vendorId, (tx) => store.createRevision(tx, {
      vendorId, householdId, requestId, revisionId, action: 'create', source: 'customer', createdBy: userId,
      startDate: '2030-01-01', endDate: '2030-01-31', subscriptions: [{ subscriptionId, selected: true }], status: 'pending_approval',
      decisions: [{ id: decisionId, subscriptionId, serviceDate: '2030-01-01', deliverySlotId: slotId, status: 'pending', previousEffectiveStatus: 'scheduled', requestedEffectiveStatus: 'skipped_by_customer' }],
    }));

    blocker = await owner.connect(); await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM leave_occurrence_decisions WHERE id=$1 FOR UPDATE', [decisionId]);
    const decision = transactions.run(vendorId, (tx) => store.decide(tx, {
      vendorId, id: decisionId, expectedVersion: 1, decision: 'approved', decidedBy: userId, reason: 'Race decision', now: new Date(),
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const amendment = transactions.run(vendorId, (tx) => store.createRevision(tx, {
      vendorId, householdId, requestId, revisionId: randomUUID(), action: 'amend', previousRevisionId: revisionId,
      source: 'customer', createdBy: userId, startDate: '2030-01-08', endDate: '2030-01-31',
      subscriptions: [{ subscriptionId, selected: true }], status: 'accepted', expectedVersion: 1, decisions: [],
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await blocker.query('COMMIT'); blocker.release(); blocker = undefined;
    const outcomes = await Promise.allSettled([decision, amendment]);
    assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
    const persisted = (await owner.query<{ status: string; isCurrent: boolean }>(`SELECT d.status,q.current_revision_id=d.leave_request_revision_id AS "isCurrent"
      FROM leave_occurrence_decisions d JOIN leave_request_revisions r ON r.id=d.leave_request_revision_id
      JOIN leave_requests q ON q.id=r.leave_request_id WHERE d.id=$1`, [decisionId])).rows[0];
    assert(persisted);
    assert.equal(persisted.isCurrent || persisted.status === 'pending', true, 'a superseded decision must not be mutated');
  } finally {
    if (blocker) { await blocker.query('ROLLBACK'); blocker.release(); }
    await owner.query('UPDATE leave_requests SET current_revision_id=NULL WHERE vendor_id=$1', [vendorId]);
    for (const table of ['leave_occurrence_decisions', 'leave_revision_subscriptions', 'leave_request_revisions', 'leave_requests']) await owner.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [vendorId]);
    await deleteSubscriptionRevisions(vendorId);
    for (const table of ['subscriptions', 'products', 'units', 'delivery_slots', 'households']) await owner.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [vendorId]);
    await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]); await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  }
});

void test('pending queue does not return a superseded decision when amendment wins the second read', { timeout: 5_000 }, async () => {
  const vendorId = randomUUID(); const householdId = randomUUID(); const userId = randomUUID(); const unitId = randomUUID();
  const productId = randomUUID(); const slotId = randomUUID(); const subscriptionId = randomUUID(); const subscriptionRevisionId = randomUUID();
  const requestId = randomUUID(); const revisionId = randomUUID(); const decisionId = randomUUID();
  try {
    await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [userId, 'Leave queue race']);
    await owner.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$2,$2,'active','Asia/Kolkata','INR',60,1,now())`, [vendorId, `leave-queue-race-${vendorId.slice(0, 8)}`]);
    await owner.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,'HH','HH','Road','Pune','MH','411001','IN',now())`, [householdId, vendorId]);
    await owner.query('INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,$3,$3,3,now())', [unitId, vendorId, 'UNIT']);
    await owner.query('INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,$3,$3,$4,now())', [productId, vendorId, 'PRODUCT', unitId]);
    await owner.query(`INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'SLOT','Slot','06:00','09:00',now())`, [slotId, vendorId]);
    await owner.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [subscriptionId, vendorId, householdId]);
    const setup = await owner.connect();
    try {
      await setup.query('BEGIN');
      await setup.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [subscriptionRevisionId, vendorId, subscriptionId, productId, unitId, slotId, userId]);
      await setup.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,2)', [vendorId, subscriptionRevisionId]);
      await setup.query('COMMIT');
    } catch (cause) { await setup.query('ROLLBACK'); throw cause; } finally { setup.release(); }
    await transactions.run(vendorId, (tx) => store.createRevision(tx, {
      vendorId, householdId, requestId, revisionId, action: 'create', source: 'customer', createdBy: userId,
      startDate: '2030-01-01', endDate: '2030-01-31', subscriptions: [{ subscriptionId, selected: true }], status: 'pending_approval',
      decisions: [{ id: decisionId, subscriptionId, serviceDate: '2030-01-01', deliverySlotId: slotId, status: 'pending' }],
    }));
    let amendmentCommittedBeforeReturn = false;
    const page = await transactions.run(vendorId, async (context) => {
      const tx = unwrapPrismaTransaction(context);
      const decisions = tx.leaveOccurrenceDecision as typeof tx.leaveOccurrenceDecision & { findMany: typeof tx.leaveOccurrenceDecision.findMany };
      const findMany = decisions.findMany.bind(decisions);
      decisions.findMany = (async (...args: Parameters<typeof findMany>) => {
        await transactions.run(vendorId, (amendTx) => store.createRevision(amendTx, {
          vendorId, householdId, requestId, revisionId: randomUUID(), action: 'amend', previousRevisionId: revisionId,
          source: 'customer', createdBy: userId, startDate: '2030-01-08', endDate: '2030-01-31',
          subscriptions: [{ subscriptionId, selected: true }], status: 'accepted', expectedVersion: 1, decisions: [],
        }));
        amendmentCommittedBeforeReturn = true;
        return findMany(...args);
      }) as typeof decisions.findMany;
      return store.listPendingDecisions(context, { vendorId });
    });
    const amendmentWon = amendmentCommittedBeforeReturn;
    if (!amendmentWon) {
      await transactions.run(vendorId, (amendTx) => store.createRevision(amendTx, {
        vendorId, householdId, requestId, revisionId: randomUUID(), action: 'amend', previousRevisionId: revisionId,
        source: 'customer', createdBy: userId, startDate: '2030-01-08', endDate: '2030-01-31',
        subscriptions: [{ subscriptionId, selected: true }], status: 'accepted', expectedVersion: 1, decisions: [],
      }));
    }
    assert.equal(amendmentWon && page.items.some(({ id }) => id === decisionId), false);
  } finally {
    await owner.query('UPDATE leave_requests SET current_revision_id=NULL WHERE vendor_id=$1', [vendorId]);
    for (const table of ['leave_occurrence_decisions', 'leave_revision_subscriptions', 'leave_request_revisions', 'leave_requests']) await owner.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [vendorId]);
    await deleteSubscriptionRevisions(vendorId);
    for (const table of ['subscriptions', 'products', 'units', 'delivery_slots', 'households']) await owner.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [vendorId]);
    await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]); await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  }
});
