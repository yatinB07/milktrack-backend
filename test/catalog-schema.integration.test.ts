import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

const runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
test.after(() => Promise.all([runtime.end(), owner.end()]));

const tables = ['units', 'products'];
const constraints = [
  'units_code_check',
  'units_name_check',
  'units_decimal_scale_check',
  'products_code_check',
  'products_name_check',
  'products_version_check',
  'products_deletion_check',
  'products_default_unit_fkey',
];
const indexes = [
  'units_vendor_id_code_key',
  'units_vendor_id_status_created_at_id_idx',
  'products_non_deleted_code_key',
  'products_vendor_id_status_created_at_id_idx',
];

async function vendor(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO vendors
       (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
     VALUES ($1,$2,$3,$3,'active','Asia/Kolkata','INR',0,1,now())`,
    [id, `catalog-${id}`, `Catalog ${label}`],
  );
  return id;
}

async function fixture(label: 'A' | 'B') {
  const vendorId = await vendor(label);
  const unitId = randomUUID();
  const productId = randomUUID();
  await owner.query(
    `INSERT INTO units (id,vendor_id,code,name,decimal_scale,updated_at)
     VALUES ($1,$2,$3,$4,2,now())`,
    [unitId, vendorId, `UNIT_${label}`, `Unit ${label}`],
  );
  await owner.query(
    `INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at)
     VALUES ($1,$2,$3,$4,$5,now())`,
    [productId, vendorId, `PRODUCT_${label}`, `Product ${label}`, unitId],
  );
  return { vendorId, unitId, productId };
}

async function cleanup(fixtures: readonly Awaited<ReturnType<typeof fixture>>[]) {
  const vendorIds = fixtures.map(({ vendorId }) => vendorId);
  await owner.query('DELETE FROM products WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM units WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendorIds]);
}

async function asTenant(vendorId: string, work: (client: pg.PoolClient) => Promise<void>) {
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.vendor_id',$1,true)", [vendorId]);
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

void test('catalog tables publish the approved constraints, indexes, and forced RLS', async () => {
  const foundTables = await owner.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name=ANY($1::text[])`,
    [tables],
  );
  assert.deepEqual(foundTables.rows.map(({ table_name }) => table_name).sort(), [...tables].sort());
  const foundConstraints = await owner.query<{ conname: string }>(
    'SELECT conname FROM pg_constraint WHERE conname=ANY($1::text[])',
    [constraints],
  );
  assert.deepEqual(foundConstraints.rows.map(({ conname }) => conname).sort(), [...constraints].sort());
  const foundIndexes = await owner.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($1::text[])`,
    [indexes],
  );
  assert.deepEqual(foundIndexes.rows.map(({ indexname }) => indexname).sort(), [...indexes].sort());
  const productCursorIndex = await owner.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname='public' AND indexname='products_vendor_id_status_created_at_id_idx'`,
  );
  assert.match(productCursorIndex.rows[0]?.indexdef ?? '', /WHERE \(deleted_at IS NULL\)$/);
  const rls = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])',
    [tables],
  );
  assert.equal(rls.rows.length, 2);
  assert.ok(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
});

void test('catalog constraints preserve tenant-safe units and non-deleted code uniqueness', async () => {
  const a = await fixture('A');
  const b = await fixture('B');
  try {
    for (const [code, name, scale, pattern] of [
      ['lower', 'Valid', 1, /units_code_check/],
      ['VALID', ' Valid ', 1, /units_name_check/],
      ['VALID', 'Valid', 4, /units_decimal_scale_check/],
    ] as const)
      await assert.rejects(
        owner.query(
          'INSERT INTO units (id,vendor_id,code,name,decimal_scale,updated_at) VALUES ($1,$2,$3,$4,$5,now())',
          [randomUUID(), a.vendorId, code, name, scale],
        ),
        pattern,
      );
    await owner.query("UPDATE units SET status='inactive' WHERE id=$1", [a.unitId]);
    await assert.rejects(
      owner.query(
        "INSERT INTO units (id,vendor_id,code,name,decimal_scale,updated_at) VALUES ($1,$2,'UNIT_A','Duplicate',1,now())",
        [randomUUID(), a.vendorId],
      ),
      /units_vendor_id_code_key/,
    );
    await assert.rejects(
      owner.query(
        "INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at) VALUES ($1,$2,'CROSS_UNIT','Cross',$3,now())",
        [randomUUID(), a.vendorId, b.unitId],
      ),
      /products_default_unit_fkey/,
    );
    for (const [code, version, deletedAt, deletedBy, reason, pattern] of [
      ['INVALID_VERSION', 0, null, null, null, /products_version_check/],
      ['INVALID_DELETION', 1, new Date(), null, null, /products_deletion_check/],
    ] as const)
      await assert.rejects(
        owner.query(
          `INSERT INTO products
             (id,vendor_id,code,name,default_unit_id,version,deleted_at,deleted_by,deletion_reason,updated_at)
           VALUES ($1,$2,$3,'Valid',$4,$5,$6,$7,$8,now())`,
          [randomUUID(), a.vendorId, code, a.unitId, version, deletedAt, deletedBy, reason],
        ),
        pattern,
      );
    await assert.rejects(
      owner.query(
        "INSERT INTO products (id,vendor_id,code,name,default_unit_id,status,updated_at) VALUES ($1,$2,'PRODUCT_A','Duplicate',$3,'inactive',now())",
        [randomUUID(), a.vendorId, a.unitId],
      ),
      /products_non_deleted_code_key/,
    );
    await assert.rejects(
      owner.query(
        "INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at) VALUES ($1,$2,'lower','Valid',$3,now())",
        [randomUUID(), a.vendorId, a.unitId],
      ),
      /products_code_check/,
    );
    for (const name of [' Padded ', '', 'x'.repeat(161)]) {
      await assert.rejects(
        owner.query(
          "INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at) VALUES ($1,$2,'VALID_NAME',$4,$3,now())",
          [randomUUID(), a.vendorId, a.unitId, name],
        ),
        /products_name_check/,
      );
    }
    await owner.query(
      "UPDATE products SET deleted_at=now(),deleted_by=$1,deletion_reason='Replace',version=version+1 WHERE id=$2",
      [randomUUID(), a.productId],
    );
    await owner.query(
      "INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at) VALUES ($1,$2,'PRODUCT_A','Replacement',$3,now())",
      [randomUUID(), a.vendorId, a.unitId],
    );
  } finally {
    await cleanup([a, b]);
  }
});

void test('runtime role denies cross-tenant catalog access in both directions and hard deletes', async () => {
  const fixtures = [await fixture('A'), await fixture('B')] as const;
  try {
    for (const [own, other] of [[fixtures[0], fixtures[1]], [fixtures[1], fixtures[0]]] as const) {
      await asTenant(own.vendorId, async (client) => {
        assert.deepEqual((await client.query('SELECT id FROM units WHERE id=$1', [own.unitId])).rows, [{ id: own.unitId }]);
        assert.deepEqual((await client.query('SELECT id FROM products WHERE id=$1', [own.productId])).rows, [{ id: own.productId }]);
        assert.equal((await client.query('UPDATE units SET updated_at=now() WHERE id=$1', [own.unitId])).rowCount, 1);
        assert.equal((await client.query('UPDATE products SET updated_at=now() WHERE id=$1', [own.productId])).rowCount, 1);
        const insertedUnitId = randomUUID();
        assert.equal((await client.query(
          "INSERT INTO units (id,vendor_id,code,name,decimal_scale,updated_at) VALUES ($1,$2,'OWN_INSERT','Own insert',1,now())",
          [insertedUnitId, own.vendorId],
        )).rowCount, 1);
        assert.equal((await client.query(
          "INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at) VALUES ($1,$2,'OWN_INSERT','Own insert',$3,now())",
          [randomUUID(), own.vendorId, insertedUnitId],
        )).rowCount, 1);
        for (const [table, id] of [['units', other.unitId], ['products', other.productId]] as const) {
          assert.equal((await client.query(`SELECT id FROM ${table} WHERE id=$1`, [id])).rowCount, 0);
          assert.equal((await client.query(`UPDATE ${table} SET updated_at=now() WHERE id=$1`, [id])).rowCount, 0);
        }
      });
      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(
          client.query(
            "INSERT INTO units (id,vendor_id,code,name,decimal_scale,updated_at) VALUES ($1,$2,'CROSS','Cross',1,now())",
            [randomUUID(), other.vendorId],
          ),
          /row-level security policy/,
        );
      });
      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(
          client.query(
            "INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at) VALUES ($1,$2,'CROSS','Cross',$3,now())",
            [randomUUID(), other.vendorId, other.unitId],
          ),
          /row-level security policy/,
        );
      });
      for (const [table, id] of [['units', own.unitId], ['products', own.productId]] as const)
        await asTenant(own.vendorId, async (client) => {
          await assert.rejects(client.query(`DELETE FROM ${table} WHERE id=$1`, [id]), /permission denied/);
        });
    }
  } finally {
    await cleanup(fixtures);
  }
});
