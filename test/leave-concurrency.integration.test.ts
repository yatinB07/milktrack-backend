import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
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
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  let acquired!: () => void; const acquiredFirst = new Promise<void>((resolve) => { acquired = resolve; });
  try {
    await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [userId, 'Leave concurrency']);
    await owner.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$2,$2,'active','Asia/Kolkata','INR',60,1,now())`, [vendorId, `leave-concurrency-${vendorId.slice(0, 8)}`]);
    await owner.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,'HH','HH','Road','Pune','MH','411001','IN',now())`, [householdId, vendorId]);
    await owner.query('INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,$3,$3,3,now())', [unitId, vendorId, 'UNIT']);
    await owner.query('INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,$3,$3,$4,now())', [productId, vendorId, 'PRODUCT', unitId]);
    await owner.query(`INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'SLOT','Slot','06:00','09:00',now())`, [slotId, vendorId]);
    await owner.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [subscriptionId, vendorId, householdId]);
    const client = await owner.connect(); try { await client.query('BEGIN'); await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [subscriptionRevisionId, vendorId, subscriptionId, productId, unitId, slotId, userId]); await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,2)', [vendorId, subscriptionRevisionId]); await client.query('COMMIT'); } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
    const input = (requestId: string, revisionId: string) => ({ vendorId, householdId, requestId, revisionId, action: 'create' as const, source: 'customer' as const, createdBy: userId, startDate: '2030-01-01', endDate: '2030-01-31', subscriptionIds: [subscriptionId], status: 'accepted' as const, decisions: [] });
    const first = transactions.run(vendorId, async (tx) => { await store.lockSubscriptions(tx, vendorId, [subscriptionId]); acquired(); await blocked; return store.createRevision(tx, input(randomUUID(), randomUUID())); });
    await acquiredFirst;
    const second = transactions.run(vendorId, async (tx) => { await store.lockSubscriptions(tx, vendorId, [subscriptionId]); return store.createRevision(tx, input(randomUUID(), randomUUID())); });
    release();
    const [one, two] = await Promise.allSettled([first, second]);
    assert.equal([one, two].filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = [one, two].find(({ status }) => status === 'rejected');
    const cause = rejected?.status === 'rejected' ? rejected.reason : undefined;
    assert(hasCode(cause));
    assert.equal(cause.code, 'LEAVE_OVERLAP');
  } finally {
    release?.();
    await owner.query('UPDATE leave_requests SET current_revision_id=NULL WHERE vendor_id=$1', [vendorId]);
    for (const table of ['leave_occurrence_decisions', 'leave_revision_subscriptions', 'leave_request_revisions', 'leave_requests']) await owner.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [vendorId]);
    await deleteSubscriptionRevisions(vendorId);
    for (const table of ['subscriptions', 'products', 'units', 'delivery_slots', 'households']) await owner.query(`DELETE FROM ${table} WHERE vendor_id=$1`, [vendorId]);
    await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]); await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  }
});
