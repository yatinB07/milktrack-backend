import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

const runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ownerPool = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
test.after(() => Promise.all([runtime.end(), ownerPool.end()]));

const tables = ['households', 'household_members'];
const expectedChecks = [
  'households_coordinates_pair_check',
  'households_latitude_check',
  'households_longitude_check',
  'household_members_lifecycle_check',
];

async function insertVendor(id: string): Promise<void> {
  await ownerPool.query(
    `INSERT INTO vendors
       (id, code, legal_name, display_name, status, timezone, currency,
        skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'Household Test', 'Household Test', 'active',
             'Asia/Kolkata', 'INR', 0, 1, now())`,
    [id, `household-${id}`],
  );
}

async function insertCustomer(vendorId: string, role: 'customer' | 'delivery_agent' = 'customer') {
  const userId = randomUUID();
  const membershipId = randomUUID();
  await ownerPool.query(`INSERT INTO users (id, display_name, updated_at) VALUES ($1, 'Customer', now())`, [userId]);
  await ownerPool.query(
    `INSERT INTO user_identities (id, user_id, type, normalized_value, verified_at, is_primary, updated_at)
     VALUES ($1, $2, 'phone', $3, now(), true, now())`,
    [randomUUID(), userId, `+91${randomUUID().replaceAll('-', '').slice(0, 10)}`],
  );
  await ownerPool.query(
    `INSERT INTO vendor_memberships (id, vendor_id, user_id, role, status, joined_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', now(), now())`,
    [membershipId, vendorId, userId, role],
  );
  return { userId, membershipId };
}

async function insertTenantFixture(label: 'A' | 'B') {
  const vendorId = randomUUID();
  const householdId = randomUUID();
  const memberId = randomUUID();
  await insertVendor(vendorId);
  const customer = await insertCustomer(vendorId);
  await ownerPool.query(
    `INSERT INTO households
       (id, vendor_id, account_number, name, address_line_1, city, region, postal_code, country_code, latitude, longitude, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'Ahmedabad', 'Gujarat', '380001', 'IN', 23, 72, now())`,
    [householdId, vendorId, `HH-${label}`, `Household ${label}`, `${label} Road`],
  );
  await ownerPool.query(
    `INSERT INTO household_members
       (id, vendor_id, household_id, customer_membership_id, joined_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [memberId, vendorId, householdId, customer.membershipId],
  );
  return { vendorId, householdId, memberId, ...customer };
}

async function cleanupTenantFixtures(fixtures: readonly Awaited<ReturnType<typeof insertTenantFixture>>[]) {
  const vendorIds = fixtures.map(({ vendorId }) => vendorId);
  const householdIds = fixtures.map(({ householdId }) => householdId);
  const membershipIds = fixtures.map(({ membershipId }) => membershipId);
  const userIds = fixtures.map(({ userId }) => userId);
  await ownerPool.query('DELETE FROM household_members WHERE vendor_id = ANY($1::uuid[])', [vendorIds]);
  await ownerPool.query('DELETE FROM households WHERE id = ANY($1::uuid[])', [householdIds]);
  await ownerPool.query('DELETE FROM vendor_memberships WHERE id = ANY($1::uuid[])', [membershipIds]);
  await ownerPool.query('DELETE FROM user_identities WHERE user_id = ANY($1::uuid[])', [userIds]);
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
  await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [vendorIds]);
}

async function asTenant(
  vendorId: string,
  work: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.vendor_id', $1, true)", [vendorId]);
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

void test('household tables are tenant-forced and constrained', async () => {
  const tableRows = await ownerPool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [tables],
  );
  assert.deepEqual(tableRows.rows.map((row) => row.table_name).sort(), [...tables].sort());

  const rls = await ownerPool.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
     WHERE relname = ANY($1::text[])`,
    [tables],
  );
  assert.equal(rls.rows.length, 2);
  assert.ok(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));

  const checks = await ownerPool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`,
    [expectedChecks],
  );
  assert.deepEqual(checks.rows.map((row) => row.conname).sort(), expectedChecks.sort());
});

void test('households enforce tenant identity and coordinate, account, and member constraints', async () => {
  const fixtureA = await insertTenantFixture('A');
  const fixtureB = await insertTenantFixture('B');
  const { vendorId: vendorA, householdId: householdA, membershipId: customerA } = fixtureA;
  try {
    for (const [latitude, longitude] of [[null, 72], [91, 72], [23, 181]] as const) {
      await assert.rejects(ownerPool.query(
        `INSERT INTO households
           (id, vendor_id, account_number, name, address_line_1, city, region, postal_code, country_code, latitude, longitude, updated_at)
         VALUES ($1, $2, $3, 'Invalid', '1 A', 'Ahmedabad', 'Gujarat', '380001', 'IN', $4, $5, now())`,
        [randomUUID(), vendorA, `invalid-${randomUUID()}`, latitude, longitude],
      ));
    }
    await assert.rejects(ownerPool.query(
      `INSERT INTO households
         (id, vendor_id, account_number, name, address_line_1, city, region, postal_code, country_code, updated_at)
       VALUES ($1, $2, 'HH-A', 'Duplicate', '1 A', 'Ahmedabad', 'Gujarat', '380001', 'IN', now())`,
      [randomUUID(), vendorA],
    ), /households_active_account_number_key/);
    await assert.rejects(ownerPool.query(
      `INSERT INTO household_members (id, vendor_id, household_id, customer_membership_id, joined_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), vendorA, householdA, customerA],
    ), /household_members_active_link_key/);
  } finally {
    await cleanupTenantFixtures([fixtureA, fixtureB]);
  }
});

void test('runtime role denies cross-tenant access in both directions and hard deletes', async () => {
  const fixtures = [await insertTenantFixture('A'), await insertTenantFixture('B')] as const;
  try {
    for (const [own, other] of [[fixtures[0], fixtures[1]], [fixtures[1], fixtures[0]]] as const) {
      await asTenant(own.vendorId, async (client) => {
        for (const [table, otherId] of [
          ['households', other.householdId],
          ['household_members', other.memberId],
        ] as const) {
          assert.equal((await client.query(`SELECT id FROM ${table} WHERE id=$1`, [otherId])).rowCount, 0);
          assert.equal((await client.query(`UPDATE ${table} SET updated_at=now() WHERE id=$1`, [otherId])).rowCount, 0);
        }
      });

      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(
          client.query(
            `INSERT INTO households
               (id, vendor_id, account_number, name, address_line_1, city, region, postal_code, country_code, updated_at)
             VALUES ($1, $2, $3, 'Cross tenant', 'Road', 'City', 'Region', '12345', 'IN', now())`,
            [randomUUID(), other.vendorId, `CROSS-${randomUUID()}`],
          ),
          /row-level security policy/,
        );
      });

      await asTenant(own.vendorId, async (client) => {
        await assert.rejects(
          client.query(
            `INSERT INTO household_members
               (id, vendor_id, household_id, customer_membership_id, joined_at, updated_at)
             VALUES ($1, $2, $3, $4, now(), now())`,
            [randomUUID(), other.vendorId, other.householdId, other.membershipId],
          ),
          /row-level security policy/,
        );
      });

      for (const [table, ownId] of [
        ['households', own.householdId],
        ['household_members', own.memberId],
      ] as const) {
        await asTenant(own.vendorId, async (client) => {
          await assert.rejects(
            client.query(`DELETE FROM ${table} WHERE id=$1`, [ownId]),
            new RegExp(`permission denied for table ${table}`),
          );
        });
      }
    }
  } finally {
    await cleanupTenantFixtures(fixtures);
  }
});
