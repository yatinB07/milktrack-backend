import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

const runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
test.after(() => Promise.all([runtime.end(), owner.end()]));

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(label: 'A' | 'B') {
  const userId = randomUUID(); const vendorId = randomUUID(); const unitId = randomUUID();
  const productId = randomUUID(); const householdId = randomUUID(); const slotId = randomUUID();
  await owner.query('INSERT INTO users (id,display_name,updated_at) VALUES ($1,$2,now())', [userId, `Price User ${label}`]);
  await owner.query(
    `INSERT INTO vendors
       (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
     VALUES ($1,$2,$3,$3,'active','Asia/Kolkata','INR',0,1,now())`,
    [vendorId, `pricing-${vendorId}`, `Pricing ${label}`],
  );
  await owner.query('INSERT INTO units (id,vendor_id,code,name,decimal_scale,updated_at) VALUES ($1,$2,$3,$4,2,now())', [unitId, vendorId, `LITRE_${label}`, `Litre ${label}`]);
  await owner.query('INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at) VALUES ($1,$2,$3,$4,$5,now())', [productId, vendorId, `MILK_${label}`, `Milk ${label}`, unitId]);
  await owner.query(
    `INSERT INTO households
       (id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at)
     VALUES ($1,$2,$3,$4,'1 Price Road','Pune','Maharashtra','411001','IN',now())`,
    [householdId, vendorId, `PRICE-${label}`, `Household ${label}`],
  );
  await owner.query(
    `INSERT INTO delivery_slots (id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
     VALUES ($1,$2,$3,$4,'06:00','09:00',now())`,
    [slotId, vendorId, `PRICE_SLOT_${label}`, `Price Slot ${label}`],
  );
  return { userId, vendorId, unitId, productId, householdId, slotId };
}

async function cleanup(fixtures: readonly Fixture[]) {
  const vendorIds = fixtures.map(({ vendorId }) => vendorId); const userIds = fixtures.map(({ userId }) => userId);
  await owner.query('DELETE FROM customer_price_overrides WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM global_prices WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM delivery_slots WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM products WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM units WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM households WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
}

async function asTenant(vendorId: string, work: (client: pg.PoolClient) => Promise<void>) {
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.vendor_id',$1,true)", [vendorId]);
    await work(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

function globalValues(current: Fixture, from: string, to: string | null = null) {
  return [randomUUID(), current.vendorId, current.productId, current.unitId, '1250', 'INR', from, to, current.userId];
}

void test('effective pricing publishes extension, tables, constraints, indexes, and forced RLS', async () => {
  assert.equal((await owner.query("SELECT 1 FROM pg_extension WHERE extname='btree_gist'")).rowCount, 1);
  const tables = await owner.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])",
    [['global_prices', 'customer_price_overrides']],
  );
  assert.deepEqual(tables.rows.map(({ table_name }) => table_name).sort(), ['customer_price_overrides', 'global_prices']);
  const constraints = [
    'products_vendor_id_id_default_unit_id_key',
    'global_prices_amount_minor_check', 'global_prices_currency_check', 'global_prices_effective_period_check', 'global_prices_no_overlap',
    'global_prices_product_unit_fkey',
    'customer_price_overrides_amount_minor_check', 'customer_price_overrides_currency_check',
    'customer_price_overrides_effective_period_check', 'customer_price_overrides_reason_check',
    'customer_price_overrides_no_overlap', 'customer_price_overrides_product_unit_fkey', 'customer_price_overrides_household_fkey',
  ];
  const found = await owner.query<{ conname: string }>('SELECT conname FROM pg_constraint WHERE conname=ANY($1::text[])', [constraints]);
  assert.deepEqual(found.rows.map(({ conname }) => conname).sort(), [...constraints].sort());
  for (const index of [
    'global_prices_vendor_id_created_at_id_idx', 'global_prices_resolution_idx',
    'customer_price_overrides_vendor_id_household_id_created_at_id_idx', 'customer_price_overrides_resolution_idx',
  ]) assert.equal((await owner.query("SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1", [index])).rowCount, 1);
  const rls = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[]) ORDER BY relname",
    [['global_prices', 'customer_price_overrides']],
  );
  assert.deepEqual(rls.rows, [
    { relname: 'customer_price_overrides', relrowsecurity: true, relforcerowsecurity: true },
    { relname: 'global_prices', relrowsecurity: true, relforcerowsecurity: true },
  ]);
});

void test('pricing constraints allow adjacent periods and reject invalid or overlapping history', async () => {
  const current = await fixture('A'); const other = await fixture('B');
  try {
    await owner.query(
      `INSERT INTO global_prices
         (id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,effective_to,created_by,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
      globalValues(current, '2026-07-20T00:00:00Z', '2026-08-01T00:00:00Z'),
    );
    await owner.query(
      `INSERT INTO global_prices
         (id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,effective_to,created_by,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
      globalValues(current, '2026-08-01T00:00:00Z'),
    );
    for (const values of [
      globalValues(current, '2026-07-25T00:00:00Z', '2026-07-26T00:00:00Z'),
      globalValues(current, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
    ]) await assert.rejects(owner.query(
      `INSERT INTO global_prices
         (id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,effective_to,created_by,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`, values,
    ));
    await assert.rejects(owner.query(
      `INSERT INTO global_prices
         (id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,created_by,updated_at)
       VALUES ($1,$2,$3,$4,-1,'INR','2027-01-01T00:00:00Z',$5,now())`,
      [randomUUID(), current.vendorId, current.productId, current.unitId, current.userId],
    ), /global_prices_amount_minor_check/);
    await assert.rejects(owner.query(
      `INSERT INTO customer_price_overrides
         (id,vendor_id,household_id,product_id,unit_id,amount_minor,currency,effective_from,reason,created_by,updated_at)
       VALUES ($1,$2,$3,$4,$5,1000,'inr','2027-01-01T00:00:00Z','Reason',$6,now())`,
      [randomUUID(), current.vendorId, current.householdId, current.productId, current.unitId, current.userId],
    ), /customer_price_overrides_currency_check/);
    await assert.rejects(owner.query(
      `INSERT INTO customer_price_overrides
         (id,vendor_id,household_id,product_id,unit_id,amount_minor,currency,effective_from,reason,created_by,updated_at)
       VALUES ($1,$2,$3,$4,$5,1000,'INR','2027-01-01T00:00:00Z',' Padded ',$6,now())`,
      [randomUUID(), current.vendorId, current.householdId, current.productId, current.unitId, current.userId],
    ), /customer_price_overrides_reason_check/);
    await assert.rejects(owner.query(
      `INSERT INTO global_prices
         (id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,created_by,updated_at)
       VALUES ($1,$2,$3,$4,1000,'INR','2027-01-01T00:00:00Z',$5,now())`,
      [randomUUID(), current.vendorId, other.productId, other.unitId, current.userId],
    ), /global_prices_product_unit_fkey/);
    await assert.rejects(owner.query(
      `INSERT INTO customer_price_overrides
         (id,vendor_id,household_id,product_id,unit_id,amount_minor,currency,effective_from,reason,created_by,updated_at)
       VALUES ($1,$2,$3,$4,$5,1000,'INR','2027-01-01T00:00:00Z','Cross household',$6,now())`,
      [randomUUID(), current.vendorId, other.householdId, current.productId, current.unitId, current.userId],
    ), /customer_price_overrides_household_fkey/);
  } finally { await cleanup([current, other]); }
});

void test('exclusion constraints reject competing overlapping global and override inserts', async () => {
  const current = await fixture('A');
  try {
    const globalSql = `INSERT INTO global_prices
      (id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,effective_to,created_by,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`;
    const globalResults = await Promise.allSettled([
      owner.query(globalSql, globalValues(current, '2027-01-01T00:00:00Z', '2027-02-01T00:00:00Z')),
      owner.query(globalSql, globalValues(current, '2027-01-15T00:00:00Z', '2027-03-01T00:00:00Z')),
    ]);
    assert.deepEqual(globalResults.map(({ status }) => status).sort(), ['fulfilled', 'rejected']);
    const overrideSql = `INSERT INTO customer_price_overrides
      (id,vendor_id,household_id,product_id,unit_id,amount_minor,currency,effective_from,effective_to,reason,created_by,updated_at)
      VALUES ($1,$2,$3,$4,$5,1100,'INR',$6,$7,'Customer agreement',$8,now())`;
    const values = (from: string, to: string) => [randomUUID(), current.vendorId, current.householdId, current.productId, current.unitId, from, to, current.userId];
    const overrideResults = await Promise.allSettled([
      owner.query(overrideSql, values('2027-04-01T00:00:00Z', '2027-05-01T00:00:00Z')),
      owner.query(overrideSql, values('2027-04-15T00:00:00Z', '2027-06-01T00:00:00Z')),
    ]);
    assert.deepEqual(overrideResults.map(({ status }) => status).sort(), ['fulfilled', 'rejected']);
  } finally { await cleanup([current]); }
});

void test('runtime role allows own prices and denies bidirectional tenant access and hard deletes', async () => {
  const fixtures = [await fixture('A'), await fixture('B')] as const;
  try {
    const priceIds: string[] = []; const overrideIds: string[] = [];
    for (const current of fixtures) {
      const id = randomUUID(); const overrideId = randomUUID(); priceIds.push(id); overrideIds.push(overrideId);
      await owner.query(
        `INSERT INTO global_prices
           (id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,effective_to,created_by,updated_at)
         VALUES ($1,$2,$3,$4,1250,'INR','2030-01-01T00:00:00Z','2031-01-01T00:00:00Z',$5,now())`,
        [id, current.vendorId, current.productId, current.unitId, current.userId],
      );
      await owner.query(
        `INSERT INTO customer_price_overrides
           (id,vendor_id,household_id,product_id,unit_id,amount_minor,currency,effective_from,effective_to,reason,created_by,updated_at)
         VALUES ($1,$2,$3,$4,$5,1100,'INR','2030-01-01T00:00:00Z','2031-01-01T00:00:00Z','Contract',$6,now())`,
        [overrideId, current.vendorId, current.householdId, current.productId, current.unitId, current.userId],
      );
    }
    for (const [index, own, other] of [[0, fixtures[0], fixtures[1]], [1, fixtures[1], fixtures[0]]] as const) {
      await asTenant(own.vendorId, async (client) => {
        assert.deepEqual((await client.query('SELECT id FROM global_prices WHERE id=$1', [priceIds[index]])).rows, [{ id: priceIds[index] }]);
        assert.equal((await client.query('UPDATE global_prices SET updated_at=now() WHERE id=$1', [priceIds[index]])).rowCount, 1);
        assert.equal((await client.query(
          `INSERT INTO global_prices
             (id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,effective_to,created_by,updated_at)
           VALUES ($1,$2,$3,$4,1300,'INR','2031-01-01T00:00:00Z','2032-01-01T00:00:00Z',$5,now())`,
          [randomUUID(), own.vendorId, own.productId, own.unitId, own.userId],
        )).rowCount, 1);
        assert.deepEqual((await client.query('SELECT id FROM customer_price_overrides WHERE id=$1', [overrideIds[index]])).rows, [{ id: overrideIds[index] }]);
        assert.equal((await client.query('UPDATE customer_price_overrides SET updated_at=now() WHERE id=$1', [overrideIds[index]])).rowCount, 1);
        assert.equal((await client.query(
          `INSERT INTO customer_price_overrides
             (id,vendor_id,household_id,product_id,unit_id,amount_minor,currency,effective_from,effective_to,reason,created_by,updated_at)
           VALUES ($1,$2,$3,$4,$5,1150,'INR','2031-01-01T00:00:00Z','2032-01-01T00:00:00Z','New contract',$6,now())`,
          [randomUUID(), own.vendorId, own.householdId, own.productId, own.unitId, own.userId],
        )).rowCount, 1);
        assert.equal((await client.query('SELECT id FROM global_prices WHERE id=$1', [priceIds[1 - index]])).rowCount, 0);
        assert.equal((await client.query('UPDATE global_prices SET updated_at=now() WHERE id=$1', [priceIds[1 - index]])).rowCount, 0);
        assert.equal((await client.query('SELECT id FROM customer_price_overrides WHERE id=$1', [overrideIds[1 - index]])).rowCount, 0);
        assert.equal((await client.query('UPDATE customer_price_overrides SET updated_at=now() WHERE id=$1', [overrideIds[1 - index]])).rowCount, 0);
      });
      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(client.query('DELETE FROM global_prices WHERE id=$1', [priceIds[index]]), /permission denied/);
      });
      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(client.query('DELETE FROM customer_price_overrides WHERE id=$1', [overrideIds[index]]), /permission denied/);
      });
      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(client.query(
          `INSERT INTO customer_price_overrides
             (id,vendor_id,household_id,product_id,unit_id,amount_minor,currency,effective_from,reason,created_by,updated_at)
           VALUES ($1,$2,$3,$4,$5,1000,'INR','2031-01-01T00:00:00Z','Cross tenant',$6,now())`,
          [randomUUID(), other.vendorId, other.householdId, other.productId, other.unitId, own.userId],
        ), /row-level security policy/);
      });
    }
  } finally { await cleanup(fixtures); }
});
