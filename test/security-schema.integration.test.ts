import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});
test.after(() => Promise.all([pool.end(), ownerPool.end()]));

void test('Phase 1 tables, soft-delete columns, forced RLS and runtime role exist', async () => {
  const tables = [
    'users',
    'user_identities',
    'password_credentials',
    'mfa_factors',
    'pending_mfa_authentications',
    'otp_challenges',
    'sessions',
    'vendors',
    'vendor_memberships',
    'platform_role_assignments',
    'support_access_grants',
    'audit_events',
  ];
  const tableRows = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [tables],
  );
  assert.deepEqual(
    tableRows.rows.map((row) => row.table_name).sort(),
    tables.sort(),
  );

  for (const table of ['users', 'vendors', 'vendor_memberships']) {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       AND column_name IN ('deleted_at', 'deleted_by', 'deletion_reason')`,
      [table],
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name).sort(),
      ['deleted_at', 'deleted_by', 'deletion_reason'],
    );
  }

  const rls = await pool.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
     WHERE relname = ANY($1::text[])`,
    [['vendor_memberships', 'support_access_grants', 'audit_events']],
  );
  assert.equal(rls.rows.length, 3);
  assert.ok(
    rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
  );

  const role = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
  );
  assert.deepEqual(role.rows[0], { rolbypassrls: false, rolsuper: false });
});

void test('audit inserts enforce global and exact tenant context', async () => {
  const vendorIds = [randomUUID(), randomUUID()];
  const auditIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await ownerPool.query(
    `INSERT INTO vendors
      (id, code, legal_name, display_name, timezone, currency, skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'Vendor One', 'Vendor One', 'Asia/Kolkata', 'INR', 0, 1, now()),
            ($3, $4, 'Vendor Two', 'Vendor Two', 'Asia/Kolkata', 'INR', 0, 1, now())`,
    [vendorIds[0], `test-${vendorIds[0]}`, vendorIds[1], `test-${vendorIds[1]}`],
  );

  const client = await pool.connect();
  const insertAudit = (id: string, vendorId: string | null) =>
    client.query(
      `INSERT INTO audit_events
        (id, vendor_id, actor_user_id, action, entity_type, entity_id, correlation_id)
       VALUES ($1, $2, $3, 'test', 'vendor', $4, $5)`,
      [id, vendorId, randomUUID(), randomUUID(), randomUUID()],
    );

  try {
    await insertAudit(auditIds[0], null);

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.vendor_id', $1, true)", [
      vendorIds[0],
    ]);
    await assert.rejects(
      insertAudit(auditIds[1], null),
      /row-level security policy/,
    );
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.vendor_id', $1, true)", [
      vendorIds[0],
    ]);
    await assert.rejects(
      insertAudit(auditIds[2], vendorIds[1]),
      /row-level security policy/,
    );
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.vendor_id', $1, true)", [
      vendorIds[0],
    ]);
    await insertAudit(auditIds[3], vendorIds[0]);
    await client.query('COMMIT');
  } finally {
    client.release();
    await ownerPool.query('DELETE FROM audit_events WHERE id = ANY($1::uuid[])', [
      auditIds,
    ]);
    await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [
      vendorIds,
    ]);
  }
});

void test('vendor identity changes cannot rewrite tenant audit history', async () => {
  const constraint = await ownerPool.query<{
    delete_action: string;
    update_action: string;
  }>(
    `SELECT confdeltype AS delete_action, confupdtype AS update_action
     FROM pg_constraint
     WHERE conname = 'audit_events_vendor_id_fkey'`,
  );
  assert.deepEqual(constraint.rows, [
    { delete_action: 'r', update_action: 'r' },
  ]);

  const vendorIds = [randomUUID(), randomUUID()];
  const replacementVendorId = randomUUID();
  const auditIds = [randomUUID(), randomUUID()];

  await ownerPool.query(
    `INSERT INTO vendors
      (id, code, legal_name, display_name, timezone, currency, skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'Delete Vendor', 'Delete Vendor', 'Asia/Kolkata', 'INR', 0, 1, now()),
            ($3, $4, 'Update Vendor', 'Update Vendor', 'Asia/Kolkata', 'INR', 0, 1, now())`,
    [vendorIds[0], `test-${vendorIds[0]}`, vendorIds[1], `test-${vendorIds[1]}`],
  );
  await ownerPool.query(
    `INSERT INTO audit_events
      (id, vendor_id, actor_user_id, action, entity_type, entity_id, correlation_id)
     VALUES ($1, $2, $3, 'test', 'vendor', $2, $4),
            ($5, $6, $7, 'test', 'vendor', $6, $8)`,
    [
      auditIds[0],
      vendorIds[0],
      randomUUID(),
      randomUUID(),
      auditIds[1],
      vendorIds[1],
      randomUUID(),
      randomUUID(),
    ],
  );

  try {
    const mutations = await Promise.allSettled([
      pool.query('DELETE FROM vendors WHERE id = $1', [vendorIds[0]]),
      pool.query('UPDATE vendors SET id = $1 WHERE id = $2', [
        replacementVendorId,
        vendorIds[1],
      ]),
    ]);
    const auditRows = await ownerPool.query<{ vendor_id: string }>(
      `SELECT vendor_id FROM audit_events
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [auditIds],
    );

    for (const mutation of mutations) {
      if (mutation.status !== 'rejected') assert.fail('vendor mutation succeeded');
      assert.match(String(mutation.reason), /audit_events_vendor_id_fkey/);
    }
    assert.deepEqual(
      auditRows.rows.map((row) => row.vendor_id).sort(),
      vendorIds.sort(),
    );
  } finally {
    await ownerPool.query('DELETE FROM audit_events WHERE id = ANY($1::uuid[])', [
      auditIds,
    ]);
    await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [
      [...vendorIds, replacementVendorId],
    ]);
  }
});
