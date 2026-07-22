import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaLeaveStore } from '../src/leave/infrastructure/prisma-leave.store.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const store = new PrismaLeaveStore();
test.after(() => Promise.all([owner.end(), prisma.$disconnect()]));

type Fixture = Readonly<{ vendorId: string; householdId: string; userId: string; subscriptionId: string; slotId: string }>;

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
  return { vendorId, householdId, userId, subscriptionId, slotId };
}

async function cleanup(value: Fixture) {
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

function revision(current: Fixture, values: Readonly<{ requestId: string; revisionId: string; action?: 'create' | 'amend' | 'cancel'; previousRevisionId?: string; status?: 'accepted' | 'pending_approval'; decisions?: readonly Readonly<{ id: string; serviceDate: string; deliverySlotId: string; status: 'pending' | 'rejected' }>[] }>) {
  return {
    vendorId: current.vendorId, householdId: current.householdId, requestId: values.requestId, revisionId: values.revisionId,
    action: values.action ?? 'create', previousRevisionId: values.previousRevisionId, source: 'customer' as const,
    createdBy: current.userId, startDate: '2030-01-01', endDate: '2030-01-31', subscriptionIds: [current.subscriptionId],
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

void test('leave store scopes active household subscriptions, persists append-only revisions, and rejects overlap', async () => {
  const current = await fixture('store'); const requestId = randomUUID(); const firstRevisionId = randomUUID();
  try {
    await transactions.run(current.vendorId, async (tx) => {
      await rejectsWithCode(() => store.lockSubscriptions(tx, current.vendorId, []), 'LEAVE_SUBSCRIPTION_SELECTION');
      await rejectsWithCode(() => store.lockSubscriptions(tx, current.vendorId, [current.subscriptionId, current.subscriptionId]), 'LEAVE_SUBSCRIPTION_SELECTION');
      await store.lockSubscriptions(tx, current.vendorId, [current.subscriptionId]);
      const preview = await store.preview(tx, {
        vendorId: current.vendorId, householdId: current.householdId, subscriptionIds: [current.subscriptionId],
        startDate: '2030-01-01', endDate: '2030-01-31', timezone: 'Asia/Kolkata', skipCutoffMinutes: 60,
        lateLeavePolicy: 'approval', now: new Date('2029-12-31T00:00:00.000Z'), limit: 1,
      });
      assert.deepEqual(preview.items.map((item) => item.serviceDate), ['2030-01-01']);
      const created = await store.createRevision(tx, revision(current, { requestId, revisionId: firstRevisionId }));
      assert.equal(created.status, 'accepted');
      assert.equal(created.revisions.length, 1);
      assert.equal(await store.isEffectivelyOnLeave(tx, {
        vendorId: current.vendorId, subscriptionId: current.subscriptionId, deliverySlotId: current.slotId, serviceDate: '2030-01-01',
      }), true);
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
    });
  } finally { await cleanup(current); }
});

void test('late decisions are explicit, versioned, cursor-stable, and tenant-neutral', async () => {
  const current = await fixture('decisions'); const requestId = randomUUID(); const decisionId = randomUUID();
  const other = await fixture('other');
  try {
    await transactions.run(current.vendorId, async (tx) => {
      await store.lockSubscriptions(tx, current.vendorId, [current.subscriptionId]);
      await store.createRevision(tx, revision(current, {
        requestId, revisionId: randomUUID(), status: 'pending_approval', decisions: [{
          id: decisionId, serviceDate: '2030-01-01', deliverySlotId: current.slotId, status: 'pending',
        }],
      }));
      const pending = await store.listPendingDecisions(tx, { vendorId: current.vendorId, limit: 1 });
      assert.equal(pending.items[0]?.id, decisionId);
      const decided = await store.decide(tx, { vendorId: current.vendorId, id: decisionId, expectedVersion: 1,
        decision: 'approved', decidedBy: current.userId, reason: 'Customer emergency approved', now: new Date('2030-01-01T00:00:00.000Z') });
      assert.equal(decided.status, 'approved');
      assert.equal(decided.request.status, 'accepted');
    });
    await transactions.run(other.vendorId, async (tx) => {
      await rejectsWithCode(() => store.getRequest(tx, other.vendorId, other.householdId, requestId), 'LEAVE_REQUEST_NOT_FOUND');
    });
  } finally { await cleanup(current); await cleanup(other); }
});
