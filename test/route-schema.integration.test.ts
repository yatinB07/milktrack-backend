import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
test.after(() => Promise.all([runtime.end(), owner.end()]));

async function fixture(label: string) {
  const vendorId = randomUUID(); const slotId = randomUUID(); const userId = randomUUID();
  await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [userId, `Route ${label}`]);
  await owner.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$3,$3,'active','Asia/Kolkata','INR',0,1,now())`, [vendorId, `route-${vendorId}`, `Route ${label}`]);
  await owner.query(`INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,$3,$4,'06:00','09:00',now())`, [slotId, vendorId, `ROUTE_SLOT_${label}`, `Route Slot ${label}`]);
  return { vendorId, slotId, userId };
}
async function cleanup(values: readonly Awaited<ReturnType<typeof fixture>>[]) { const vendors = values.map(({ vendorId }) => vendorId); const users = values.map(({ userId }) => userId); await owner.query('DELETE FROM routes WHERE vendor_id=ANY($1::uuid[])', [vendors]); await owner.query('DELETE FROM delivery_slots WHERE vendor_id=ANY($1::uuid[])', [vendors]); await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]); await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendors]); }
async function asTenant(vendorId: string, work: (client: pg.PoolClient) => Promise<void>) { const client = await runtime.connect(); try { await client.query('BEGIN'); await client.query("SELECT set_config('app.vendor_id',$1,true)", [vendorId]); await work(client); } finally { await client.query('ROLLBACK'); client.release(); } }
const insert = (value: Awaited<ReturnType<typeof fixture>>, code = 'AM_ROUTE') => owner.query(`INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at) VALUES($1,$2,$3,'Morning Route',$4,now()) RETURNING id`, [randomUUID(), value.vendorId, code, value.slotId]);

void test('routes publish approved constraints, indexes, forced RLS, and narrow grants', async () => {
  const constraints = ['routes_vendor_id_id_key','routes_vendor_id_id_delivery_slot_id_key','routes_delivery_slot_fkey','routes_code_check','routes_name_check','routes_status_check','routes_version_check','routes_deletion_check'];
  const found = await owner.query<{ conname: string }>('SELECT conname FROM pg_constraint WHERE conname=ANY($1::text[])', [constraints]);
  assert.deepEqual(found.rows.map(({ conname }) => conname).sort(), [...constraints].sort());
  for (const index of ['routes_vendor_id_code_visible_key','routes_vendor_id_status_created_at_id_idx','routes_vendor_id_delivery_slot_id_status_idx']) assert.equal((await owner.query("SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1", [index])).rowCount, 1);
  assert.deepEqual((await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='routes'")).rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
});

void test('route constraints enforce normalized fields, tenant slot ownership, and visible-code reuse', async () => {
  const values = [await fixture('A'), await fixture('B')] as const;
  try {
    for (const [code, name, pattern] of [['lower','Valid',/routes_code_check/],['VALID',' Padded ',/routes_name_check/]] as const) await assert.rejects(owner.query(`INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at) VALUES($1,$2,$3,$4,$5,now())`, [randomUUID(), values[0].vendorId, code, name, values[0].slotId]), pattern);
    await assert.rejects(owner.query(`INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at) VALUES($1,$2,'CROSS','Cross',$3,now())`, [randomUUID(), values[0].vendorId, values[1].slotId]), /routes_delivery_slot_fkey/);
    const first = (await insert(values[0])).rows[0] as { id: string };
    await assert.rejects(insert(values[0]), /routes_vendor_id_code_visible_key/);
    await owner.query(`UPDATE routes SET status='inactive',deleted_at=now(),deleted_by=$1,deletion_reason='Retired route' WHERE id=$2`, [values[0].userId, first.id]);
    assert.equal((await insert(values[0])).rowCount, 1);
  } finally { await cleanup(values); }
});

void test('runtime route access is tenant-scoped in both directions and hard delete is denied', async () => {
  const values = [await fixture('A'), await fixture('B')] as const; const ids = [(await insert(values[0])).rows[0] as { id: string }, (await insert(values[1])).rows[0] as { id: string }];
  try {
    for (const [index, other] of [[0,1],[1,0]] as const) await asTenant(values[index].vendorId, async (client) => {
      assert.equal((await client.query(`INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at) VALUES($1,$2,$3,'Runtime Route',$4,now())`, [randomUUID(), values[index].vendorId, `RUNTIME_${index}`, values[index].slotId])).rowCount, 1);
      assert.equal((await client.query('SELECT id FROM routes WHERE id=$1', [ids[index].id])).rowCount, 1);
      assert.equal((await client.query('SELECT id FROM routes WHERE id=$1', [ids[other].id])).rowCount, 0);
      assert.equal((await client.query('UPDATE routes SET name=$1 WHERE id=$2', ['Renamed', ids[index].id])).rowCount, 1);
      assert.equal((await client.query('UPDATE routes SET name=$1 WHERE id=$2', ['Cross', ids[other].id])).rowCount, 0);
    });
    for (const index of [0,1] as const) await asTenant(values[index].vendorId, async (client) => {
      await assert.rejects(client.query('UPDATE routes SET code=$1 WHERE id=$2', ['IMMUTABLE', ids[index].id]), /permission denied/);
    });
    for (const index of [0,1] as const) await asTenant(values[index].vendorId, async (client) => {
      await assert.rejects(client.query('DELETE FROM routes WHERE id=$1', [ids[index].id]), /permission denied/);
    });
    for (const [index, other] of [[0,1],[1,0]] as const) await asTenant(values[index].vendorId, async (client) => {
      await assert.rejects(client.query(`INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at) VALUES($1,$2,$3,'Cross Route',$4,now())`, [randomUUID(), values[other].vendorId, `CROSS_${index}`, values[other].slotId]), /row-level security policy/);
    });
  } finally { await cleanup(values); }
});
