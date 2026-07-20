import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

const runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
test.after(() => Promise.all([runtime.end(), owner.end()]));

async function fixture(label: 'A' | 'B') {
  const vendorId = randomUUID(); const slotId = randomUUID();
  await owner.query(
    `INSERT INTO vendors
       (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
     VALUES ($1,$2,$3,$3,'active','Asia/Kolkata','INR',0,1,now())`,
    [vendorId, `slots-${vendorId}`, `Slots ${label}`],
  );
  await owner.query(
    `INSERT INTO delivery_slots
       (id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
     VALUES ($1,$2,$3,$4,'06:00','09:00',now())`,
    [slotId, vendorId, `MORNING_${label}`, `Morning ${label}`],
  );
  return { vendorId, slotId };
}
async function cleanup(fixtures: readonly Awaited<ReturnType<typeof fixture>>[]) {
  const vendorIds = fixtures.map(({ vendorId }) => vendorId);
  await owner.query('DELETE FROM delivery_slots WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendorIds]);
}
async function asTenant(vendorId: string, work: (client: pg.PoolClient) => Promise<void>) {
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.vendor_id',$1,true)", [vendorId]);
    await work(client);
  } finally {
    await client.query('ROLLBACK'); client.release();
  }
}

void test('delivery slots publish time precision, constraints, cursor index, and forced RLS', async () => {
  assert.equal((await owner.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='delivery_slots'",
  )).rowCount, 1);
  const columns = await owner.query<{ column_name: string; data_type: string; datetime_precision: number | null }>(
    `SELECT column_name,data_type,datetime_precision FROM information_schema.columns
     WHERE table_schema='public' AND table_name='delivery_slots'
       AND column_name IN ('start_local_time','end_local_time') ORDER BY column_name`,
  );
  assert.deepEqual(columns.rows, [
    { column_name: 'end_local_time', data_type: 'time without time zone', datetime_precision: 0 },
    { column_name: 'start_local_time', data_type: 'time without time zone', datetime_precision: 0 },
  ]);
  const constraints = ['delivery_slots_code_check', 'delivery_slots_name_check', 'delivery_slots_time_range_check', 'delivery_slots_vendor_id_code_key'];
  const found = await owner.query<{ conname: string }>('SELECT conname FROM pg_constraint WHERE conname=ANY($1::text[])', [constraints]);
  assert.deepEqual(found.rows.map(({ conname }) => conname).sort(), [...constraints].sort());
  assert.equal((await owner.query("SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='delivery_slots_vendor_id_active_created_at_id_idx'")).rowCount, 1);
  const rls = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='delivery_slots'");
  assert.deepEqual(rls.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
});

void test('delivery slots reject invalid normalized fields, overnight windows, and inactive code reuse', async () => {
  const current = await fixture('A');
  try {
    for (const [code, name, start, end, pattern] of [
      ['lower', 'Valid', '06:00', '09:00', /delivery_slots_code_check/],
      ['VALID', ' Padded ', '06:00', '09:00', /delivery_slots_name_check/],
      ['VALID', 'Valid', '09:00', '09:00', /delivery_slots_time_range_check/],
      ['VALID', 'Valid', '22:00', '06:00', /delivery_slots_time_range_check/],
    ] as const) await assert.rejects(
      owner.query(
        `INSERT INTO delivery_slots
           (id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())`,
        [randomUUID(), current.vendorId, code, name, start, end],
      ), pattern,
    );
    await owner.query('UPDATE delivery_slots SET active=false WHERE id=$1', [current.slotId]);
    await assert.rejects(owner.query(
      `INSERT INTO delivery_slots
         (id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
       VALUES ($1,$2,'MORNING_A','Duplicate','10:00','11:00',now())`,
      [randomUUID(), current.vendorId],
    ), /delivery_slots_vendor_id_code_key/);
  } finally { await cleanup([current]); }
});

void test('runtime role allows own delivery slots and denies cross-tenant access and hard deletes', async () => {
  const fixtures = [await fixture('A'), await fixture('B')] as const;
  try {
    for (const [own, other] of [[fixtures[0], fixtures[1]], [fixtures[1], fixtures[0]]] as const) {
      await asTenant(own.vendorId, async (client) => {
        assert.deepEqual((await client.query('SELECT id FROM delivery_slots WHERE id=$1', [own.slotId])).rows, [{ id: own.slotId }]);
        assert.equal((await client.query('UPDATE delivery_slots SET updated_at=now() WHERE id=$1', [own.slotId])).rowCount, 1);
        assert.equal((await client.query(
          `INSERT INTO delivery_slots
             (id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
           VALUES ($1,$2,'OWN_INSERT','Own','10:00','11:00',now())`,
          [randomUUID(), own.vendorId],
        )).rowCount, 1);
        assert.equal((await client.query('SELECT id FROM delivery_slots WHERE id=$1', [other.slotId])).rowCount, 0);
        assert.equal((await client.query('UPDATE delivery_slots SET updated_at=now() WHERE id=$1', [other.slotId])).rowCount, 0);
      });
      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(client.query(
          `INSERT INTO delivery_slots
             (id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
           VALUES ($1,$2,'CROSS','Cross','12:00','13:00',now())`,
          [randomUUID(), other.vendorId],
        ), /row-level security policy/);
      });
      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(client.query('DELETE FROM delivery_slots WHERE id=$1', [own.slotId]), /permission denied/);
      });
    }
  } finally { await cleanup(fixtures); }
});
