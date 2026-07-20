import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

const runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
test.after(() => Promise.all([runtime.end(), owner.end()]));

async function fixture(label: string) {
  const userId = randomUUID(); const vendorId = randomUUID(); const householdId = randomUUID();
  const unitId = randomUUID(); const productId = randomUUID(); const slotId = randomUUID();
  await owner.query('INSERT INTO users (id,display_name,updated_at) VALUES ($1,$2,now())', [userId, `Subscription ${label}`]);
  await owner.query(
    `INSERT INTO vendors
       (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
     VALUES ($1,$2,$3,$3,'active','Asia/Kolkata','INR',0,1,now())`,
    [vendorId, `subscription-${vendorId}`, `Subscription ${label}`],
  );
  await owner.query(
    `INSERT INTO households
       (id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at)
     VALUES ($1,$2,$3,$4,'1 Test Road','Pune','Maharashtra','411001','IN',now())`,
    [householdId, vendorId, `SUB-${label}`, `Household ${label}`],
  );
  await owner.query('INSERT INTO units (id,vendor_id,code,name,decimal_scale,updated_at) VALUES ($1,$2,$3,$4,3,now())', [unitId, vendorId, `UNIT_${label}`, `Unit ${label}`]);
  await owner.query('INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at) VALUES ($1,$2,$3,$4,$5,now())', [productId, vendorId, `PRODUCT_${label}`, `Product ${label}`, unitId]);
  await owner.query(
    `INSERT INTO delivery_slots (id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
     VALUES ($1,$2,$3,$4,'06:00','09:00',now())`,
    [slotId, vendorId, `SLOT_${label}`, `Slot ${label}`],
  );
  return { userId, vendorId, householdId, unitId, productId, slotId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function cleanup(fixtures: readonly Fixture[]) {
  const vendorIds = fixtures.map(({ vendorId }) => vendorId); const userIds = fixtures.map(({ userId }) => userId);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query('DELETE FROM subscription_revision_weekdays WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
    await client.query('DELETE FROM subscription_revisions WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
    await client.query('DELETE FROM subscriptions WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
    await client.query('DELETE FROM delivery_slots WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
    await client.query('DELETE FROM products WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
    await client.query('DELETE FROM units WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
    await client.query('DELETE FROM households WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
    await client.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendorIds]);
    await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
    await client.query('COMMIT');
  } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
}

async function insertRoot(current: Fixture, householdId = current.householdId) {
  const id = randomUUID();
  await owner.query('INSERT INTO subscriptions (id,vendor_id,household_id,updated_at) VALUES ($1,$2,$3,now())', [id, current.vendorId, householdId]);
  return id;
}

async function insertRevision(
  client: pg.Pool | pg.PoolClient,
  current: Fixture,
  subscriptionId: string,
  from = '2030-01-01',
  to: string | null = null,
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO subscription_revisions
       (id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,effective_to,created_by,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,1.250,'active',$7,$8,$9,now())`,
    [id, current.vendorId, subscriptionId, current.productId, current.unitId, current.slotId, from, to, current.userId],
  );
  return id;
}

async function insertCompleteRevision(
  current: Fixture,
  subscriptionId: string,
  from = '2030-01-01',
  to: string | null = null,
) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    const id = await insertRevision(client, current, subscriptionId, from, to);
    await client.query('INSERT INTO subscription_revision_weekdays VALUES ($1,$2,1)', [current.vendorId, id]);
    await client.query('COMMIT');
    return id;
  } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
}

async function asTenant(vendorId: string, work: (client: pg.PoolClient) => Promise<void>) {
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.vendor_id',$1,true)", [vendorId]);
    await work(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

void test('subscription aggregate tables publish forced RLS, exclusion, deferred supersession, and weekday trigger', async () => {
  const tables = ['subscriptions', 'subscription_revisions', 'subscription_revision_weekdays'];
  const rls = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    'SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])', [tables],
  );
  assert.equal(rls.rows.length, 3);
  assert.ok(rls.rows.every(({ relrowsecurity, relforcerowsecurity }) => relrowsecurity && relforcerowsecurity));
  const constraints = await owner.query<{ conname: string; condeferrable: boolean; condeferred: boolean }>(
    `SELECT conname,condeferrable,condeferred FROM pg_constraint
     WHERE conname=ANY($1::text[])`,
    [['subscription_revisions_supersession_fkey', 'subscription_revisions_no_current_plan_overlap']],
  );
  assert.equal(constraints.rows.length, 2);
  assert.deepEqual(constraints.rows.find(({ conname }) => conname === 'subscription_revisions_supersession_fkey'), {
    conname: 'subscription_revisions_supersession_fkey', condeferrable: true, condeferred: true,
  });
  const trigger = await owner.query<{ tgdeferrable: boolean; tginitdeferred: boolean }>(
    "SELECT tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgname='subscription_revision_weekdays_nonempty'",
  );
  assert.deepEqual(trigger.rows, [{ tgdeferrable: true, tginitdeferred: true }]);
});

void test('weekday cardinality is checked at commit while same-transaction weekdays succeed', async () => {
  const current = await fixture('A'); const rootId = await insertRoot(current);
  try {
    const missing = await owner.connect();
    try {
      await missing.query('BEGIN'); await insertRevision(missing, current, rootId);
      await assert.rejects(missing.query('COMMIT'), /subscription revision .* requires at least one weekday/);
    } finally { await missing.query('ROLLBACK'); missing.release(); }
    const complete = await owner.connect();
    let revisionId: string;
    try {
      await complete.query('BEGIN'); revisionId = await insertRevision(complete, current, rootId);
      await complete.query('INSERT INTO subscription_revision_weekdays VALUES ($1,$2,1)', [current.vendorId, revisionId]);
      await complete.query('COMMIT');
    } catch (cause) { await complete.query('ROLLBACK'); throw cause; } finally { complete.release(); }
    await assert.rejects(owner.query('INSERT INTO subscription_revision_weekdays VALUES ($1,$2,8)', [current.vendorId, revisionId!]), /weekday_check/);
  } finally { await cleanup([current]); }
});

void test('composite supersession rejects a different root and current plans cannot overlap', async () => {
  const current = await fixture('B'); const firstRoot = await insertRoot(current); const secondRoot = await insertRoot(current);
  try {
    const firstRevision = await insertCompleteRevision(current, firstRoot, '2030-01-01', '2030-02-01');
    const secondRevision = await insertCompleteRevision(current, secondRoot);
    await assert.rejects(owner.query(
      `UPDATE subscription_revisions SET superseded_at=now(),superseded_by_revision_id=$1,
       supersession_reason='Wrong root',updated_at=now() WHERE id=$2`, [secondRevision, firstRevision],
    ), /subscription_revisions_supersession_fkey/);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(insertRevision(client, current, firstRoot, '2030-01-15', '2030-03-01'), /subscription_revisions_no_current_plan_overlap/);
    } finally { await client.query('ROLLBACK'); client.release(); }
  } finally { await cleanup([current]); }
});

void test('deferred supersession accepts an allocated replacement and rolls the whole correction back on invalid weekdays', async () => {
  const current = await fixture('E'); const root = await insertRoot(current);
  try {
    const oldRevision = await insertCompleteRevision(current, root, '2031-01-01');
    const replacement = randomUUID(); const success = await owner.connect();
    try {
      await success.query('BEGIN');
      await success.query(
        `UPDATE subscription_revisions SET superseded_at=now(),superseded_by_revision_id=$1,
         supersession_reason='Correct future plan',updated_at=now() WHERE id=$2`, [replacement, oldRevision],
      );
      await success.query(
        `INSERT INTO subscription_revisions
           (id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,effective_to,created_by,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,2,'active','2031-01-01','2032-01-01',$7,now())`,
        [replacement, current.vendorId, root, current.productId, current.unitId, current.slotId, current.userId],
      );
      await success.query('INSERT INTO subscription_revision_weekdays VALUES ($1,$2,2)', [current.vendorId, replacement]);
      await success.query('COMMIT');
    } catch (cause) { await success.query('ROLLBACK'); throw cause; } finally { success.release(); }
    assert.deepEqual((await owner.query(
      'SELECT id,superseded_by_revision_id FROM subscription_revisions WHERE subscription_id=$1 ORDER BY id', [root],
    )).rows, [
      { id: oldRevision, superseded_by_revision_id: replacement },
      { id: replacement, superseded_by_revision_id: null },
    ].sort((left, right) => left.id.localeCompare(right.id)));

    const secondOld = await insertCompleteRevision(current, root, '2032-01-01');
    const invalidReplacement = randomUUID(); const failed = await owner.connect();
    try {
      await failed.query('BEGIN');
      await failed.query(
        `UPDATE subscription_revisions SET superseded_at=now(),superseded_by_revision_id=$1,
         supersession_reason='Invalid correction',updated_at=now() WHERE id=$2`, [invalidReplacement, secondOld],
      );
      await failed.query(
        `INSERT INTO subscription_revisions
           (id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,2,'active','2032-01-01',$7,now())`,
        [invalidReplacement, current.vendorId, root, current.productId, current.unitId, current.slotId, current.userId],
      );
      await assert.rejects(failed.query('COMMIT'), /requires at least one weekday/);
    } finally { await failed.query('ROLLBACK'); failed.release(); }
    assert.deepEqual((await owner.query(
      'SELECT superseded_at,superseded_by_revision_id FROM subscription_revisions WHERE id=$1', [secondOld],
    )).rows, [{ superseded_at: null, superseded_by_revision_id: null }]);
    assert.equal((await owner.query('SELECT id FROM subscription_revisions WHERE id=$1', [invalidReplacement])).rowCount, 0);
  } finally { await cleanup([current]); }
});

void test('subscription root soft-delete metadata is all absent or consistently present', async () => {
  const current = await fixture('F'); const root = await insertRoot(current);
  try {
    await assert.rejects(owner.query('UPDATE subscriptions SET deleted_at=now(),updated_at=now() WHERE id=$1', [root]), /subscriptions_deletion_check/);
    await assert.rejects(owner.query("UPDATE subscriptions SET deleted_at=now(),deleted_by=$1,deletion_reason=' ',updated_at=now() WHERE id=$2", [current.userId, root]), /subscriptions_deletion_check/);
    await owner.query("UPDATE subscriptions SET deleted_at=now(),deleted_by=$1,deletion_reason='Terminal cleanup',updated_at=now() WHERE id=$2", [current.userId, root]);
    await owner.query('UPDATE subscriptions SET deleted_at=NULL,deleted_by=NULL,deletion_reason=NULL,updated_at=now() WHERE id=$1', [root]);
  } finally { await cleanup([current]); }
});

void test('runtime permits own aggregate access, denies both tenant directions, and cannot hard-delete history', async () => {
  const fixtures = [await fixture('C'), await fixture('D')] as const;
  try {
    const ids: { root: string; revision: string }[] = [];
    for (const current of fixtures) {
      const root = await insertRoot(current); const revision = await insertCompleteRevision(current, root);
      ids.push({ root, revision });
    }
    for (const [index, own, other] of [[0, fixtures[0], fixtures[1]], [1, fixtures[1], fixtures[0]]] as const) {
      await asTenant(own.vendorId, async (client) => {
        assert.deepEqual((await client.query('SELECT id FROM subscriptions WHERE id=$1', [ids[index].root])).rows, [{ id: ids[index].root }]);
        assert.deepEqual((await client.query('SELECT subscription_revision_id FROM subscription_revision_weekdays WHERE subscription_revision_id=$1', [ids[index].revision])).rows, [{ subscription_revision_id: ids[index].revision }]);
        assert.equal((await client.query('SELECT id FROM subscriptions WHERE id=$1', [ids[1 - index].root])).rowCount, 0);
        assert.equal((await client.query('SELECT id FROM subscription_revisions WHERE id=$1', [ids[1 - index].revision])).rowCount, 0);
        assert.equal((await client.query('SELECT subscription_revision_id FROM subscription_revision_weekdays WHERE subscription_revision_id=$1', [ids[1 - index].revision])).rowCount, 0);
      });
      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(client.query('DELETE FROM subscription_revisions WHERE id=$1', [ids[index].revision]), /permission denied/);
      });
      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(client.query('DELETE FROM subscriptions WHERE id=$1', [ids[index].root]), /permission denied/);
      });
      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(client.query('DELETE FROM subscription_revision_weekdays WHERE subscription_revision_id=$1', [ids[index].revision]), /permission denied/);
      });
      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(client.query('INSERT INTO subscriptions (id,vendor_id,household_id,updated_at) VALUES ($1,$2,$3,now())', [randomUUID(), other.vendorId, other.householdId]), /row-level security policy/);
      });
    }
  } finally { await cleanup(fixtures); }
});
