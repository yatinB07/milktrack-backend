import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});
test.after(() => Promise.all([pool.end(), ownerPool.end()]));

void test('migrations 003 through 007 safely upgrade legacy data without resetting it', async () => {
  const schema = `migration_${randomUUID().replaceAll('-', '')}`;
  const migrationDirectories = [
    '202607180001_phase_1_security_foundation',
    '202607180002_preserve_vendor_audit_history',
    '202607180003_bind_session_authentication_method',
    '202607180004_allow_anonymous_auth_audits',
    '202607180005_constrain_anonymous_auth_audits',
    '202607180006_align_vendor_cursor_precision',
    '202607180007_align_audit_cursor_precision',
  ] as const;
  const migrations = await Promise.all(
    migrationDirectories.map((directory) =>
      readFile(
        new URL(`../prisma/migrations/${directory}/migration.sql`, import.meta.url),
        'utf8',
      ),
    ),
  );
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(migrations[0]);
    await client.query(migrations[1]);

    const userId = randomUUID();
    const sessionId = randomUUID();
    await client.query(
      `INSERT INTO users (id, display_name, updated_at)
       VALUES ($1, 'Legacy Session User', now())`,
      [userId],
    );
    await client.query(
      `INSERT INTO sessions
         (id, user_id, access_token_hash, refresh_token_hash, device_id,
          access_expires_at, expires_at, last_seen_at)
       VALUES ($1, $2, 'legacy-access', 'legacy-refresh', 'legacy-device',
               now() + interval '15 minutes', now() + interval '30 days', now())`,
      [sessionId, userId],
    );

    await client.query(migrations[2]);
    await client.query(migrations[3]);
    await client.query(migrations[4]);
    const legacyVendorId = randomUUID();
    await client.query(
      `INSERT INTO vendors
         (id, code, legal_name, display_name, timezone, currency,
          skip_cutoff_minutes, billing_day, created_at, updated_at)
       VALUES ($1, $2, 'Legacy Precision', 'Legacy Precision',
               'Asia/Kolkata', 'INR', 0, 1,
               '2026-07-18T12:00:00.123900Z'::timestamptz, now())`,
      [legacyVendorId, `legacy-${legacyVendorId}`],
    );
    await client.query(migrations[5]);
    const legacyAuditId = randomUUID();
    await client.query(
      `INSERT INTO audit_events
         (id, vendor_id, actor_user_id, action, entity_type, entity_id,
          correlation_id, created_at)
       VALUES ($1, $2, $3, 'legacy.precision', 'vendor', $2, $4,
               '2026-07-18T12:00:00.123900Z'::timestamptz)`,
      [legacyAuditId, legacyVendorId, userId, randomUUID()],
    );
    await client.query(migrations[6]);

    const session = await client.query<{
      authentication_method: string;
      access_token_hash: string;
      refresh_token_hash: string;
      device_id: string;
      access_expired: boolean;
      refresh_expired: boolean;
    }>(
      `SELECT authentication_method,
              access_token_hash, refresh_token_hash, device_id,
              access_expires_at <= now() AS access_expired,
              expires_at <= now() AS refresh_expired
       FROM sessions WHERE id = $1`,
      [sessionId],
    );
    assert.deepEqual(session.rows, [
      {
        authentication_method: 'phone_otp',
        access_token_hash: 'legacy-access',
        refresh_token_hash: 'legacy-refresh',
        device_id: 'legacy-device',
        access_expired: true,
        refresh_expired: true,
      },
    ]);
    const column = await client.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'sessions'
         AND column_name = 'authentication_method'`,
      [schema],
    );
    assert.deepEqual(column.rows, [{ column_default: null }]);
    const auditActor = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'audit_events'
         AND column_name = 'actor_user_id'`,
      [schema],
    );
    assert.deepEqual(auditActor.rows, [{ is_nullable: 'YES' }]);
    const vendorCreatedAt = await client.query<{ datetime_precision: number }>(
      `SELECT datetime_precision FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'vendors'
         AND column_name = 'created_at'`,
      [schema],
    );
    assert.deepEqual(vendorCreatedAt.rows, [{ datetime_precision: 3 }]);
    const migratedVendor = await client.query<{ created_at: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created_at
       FROM vendors WHERE id = $1`,
      [legacyVendorId],
    );
    assert.deepEqual(migratedVendor.rows, [{ created_at: '2026-07-18T12:00:00.124' }]);
    const auditCreatedAt = await client.query<{ datetime_precision: number }>(
      `SELECT datetime_precision FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'audit_events'
         AND column_name = 'created_at'`,
      [schema],
    );
    assert.deepEqual(auditCreatedAt.rows, [{ datetime_precision: 3 }]);
    const migratedAudit = await client.query<{ created_at: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created_at
       FROM audit_events WHERE id = $1`,
      [legacyAuditId],
    );
    assert.deepEqual(migratedAudit.rows, [{ created_at: '2026-07-18T12:00:00.124' }]);

    const anonymousChallengeId = randomUUID();
    await client.query(
      `INSERT INTO audit_events
         (id, actor_user_id, action, entity_type, entity_id, correlation_id)
       VALUES ($1, NULL, 'auth.otp_challenge_issued', 'authentication', $1, $2)`,
      [anonymousChallengeId, randomUUID()],
    );

    const vendorId = randomUUID();
    await client.query(
      `INSERT INTO vendors
         (id, code, legal_name, display_name, timezone, currency,
          skip_cutoff_minutes, billing_day, updated_at)
       VALUES ($1, $2, 'Audit Constraint', 'Audit Constraint',
               'Asia/Kolkata', 'INR', 0, 1, now())`,
      [vendorId, `audit-${vendorId}`],
    );
    const forbiddenAnonymousEvents = [
      [null, 'auth.session_created', 'authentication'],
      [null, 'vendor.created', 'vendor'],
      [null, 'auth.otp_challenge_issued', 'vendor'],
      [vendorId, 'auth.otp_challenge_issued', 'authentication'],
    ] as const;
    for (const [eventVendorId, action, entityType] of forbiddenAnonymousEvents) {
      await client.query('SAVEPOINT anonymous_audit_check');
      await assert.rejects(
        client.query(
          `INSERT INTO audit_events
             (id, vendor_id, actor_user_id, action, entity_type, entity_id, correlation_id)
           VALUES ($1, $2, NULL, $3, $4, $1, $5)`,
          [randomUUID(), eventVendorId, action, entityType, randomUUID()],
        ),
        /audit_events_actor_required_check/,
      );
      await client.query('ROLLBACK TO SAVEPOINT anonymous_audit_check');
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

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
