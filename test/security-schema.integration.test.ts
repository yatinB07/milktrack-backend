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

void test('migrations safely upgrade legacy data without resetting it', async () => {
  const schema = `migration_${randomUUID().replaceAll('-', '')}`;
  const migrationDirectories = [
    '202607180001_phase_1_security_foundation',
    '202607180002_preserve_vendor_audit_history',
    '202607180003_bind_session_authentication_method',
    '202607180004_allow_anonymous_auth_audits',
    '202607180005_constrain_anonymous_auth_audits',
    '202607180006_align_vendor_cursor_precision',
    '202607180007_align_audit_cursor_precision',
    '202607180008_authentication_hardening',
    '202607180009_align_membership_cursor_precision',
    '202607180010_owner_enrollment',
    '202607200001_households',
    '202607200002_vendor_catalog',
    '202607200003_delivery_slots',
    '202607200004_effective_pricing',
    '202607200005_subscriptions',
    '202607200006_routes',
    '202607200007_route_stop_plans',
    '202607200008_route_assignments',
    '202607200009_scheduled_deliveries',
    '202607200010_schedule_generation_runs',
    '202607210001_authentication_authority_lookup',
    '202607220001_phase_3_online_delivery',
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
    const factorId = randomUUID();
    await client.query(
      `INSERT INTO users (id, display_name, updated_at)
       VALUES ($1, 'Legacy Session User', now())`,
      [userId],
    );
    await client.query(
      `INSERT INTO mfa_factors
         (id, user_id, type, encrypted_secret, enabled_at, last_used_at)
       VALUES ($1, $2, 'totp', 'legacy-encrypted', now() - interval '1 day',
               '2026-07-18T12:00:30Z'::timestamptz)`,
      [factorId, userId],
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
    await client.query(migrations[7]);
    await client.query(migrations[8]);
    await client.query(migrations[9]);
    await client.query(migrations[10]);
    const legacyHouseholdId = randomUUID();
    await client.query(
      `INSERT INTO households
         (id, vendor_id, account_number, name, address_line_1, city, region,
          postal_code, country_code, updated_at)
       VALUES ($1, $2, 'LEGACY-HOUSEHOLD', 'Legacy Household', '1 Legacy Road',
               'Pune', 'Maharashtra', '411001', 'IN', now())`,
      [legacyHouseholdId, legacyVendorId],
    );
    await client.query(migrations[11]);
    const legacyUnitId = randomUUID(); const legacyProductId = randomUUID();
    await client.query(
      `INSERT INTO units (id,vendor_id,code,name,decimal_scale,updated_at)
       VALUES ($1,$2,'LEGACY_UNIT','Legacy Unit',2,now())`,
      [legacyUnitId, legacyVendorId],
    );
    await client.query(
      `INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at)
       VALUES ($1,$2,'LEGACY_PRODUCT','Legacy Product',$3,now())`,
      [legacyProductId, legacyVendorId, legacyUnitId],
    );
    await client.query(migrations[12]);
    const legacySlotId = randomUUID();
    await client.query(
      `INSERT INTO delivery_slots
         (id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
       VALUES ($1,$2,'LEGACY_SLOT','Legacy Slot','06:00','09:00',now())`,
      [legacySlotId, legacyVendorId],
    );
    await client.query(migrations[13]);
    const legacyGlobalPriceId = randomUUID(); const legacyOverrideId = randomUUID();
    await client.query(
      `INSERT INTO global_prices
         (id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,created_by,updated_at)
       VALUES ($1,$2,$3,$4,6500,'INR','2026-07-20T00:00:00Z',$5,now())`,
      [legacyGlobalPriceId, legacyVendorId, legacyProductId, legacyUnitId, userId],
    );
    await client.query(
      `INSERT INTO customer_price_overrides
         (id,vendor_id,household_id,product_id,unit_id,amount_minor,currency,effective_from,reason,created_by,updated_at)
       VALUES ($1,$2,$3,$4,$5,6250,'INR','2026-07-20T00:00:00Z','Legacy negotiated price',$6,now())`,
      [legacyOverrideId, legacyVendorId, legacyHouseholdId, legacyProductId, legacyUnitId, userId],
    );
    await client.query(migrations[14]);
    await client.query(migrations[15]);
    await client.query(migrations[16]);
    await client.query(migrations[17]);
    await client.query(migrations[18]);
    await client.query(migrations[19]);
    await client.query(migrations[20]);

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
    const migratedFactor = await client.query<{ last_used_counter: string | null }>(
      'SELECT last_used_counter::text FROM mfa_factors WHERE id = $1',
      [factorId],
    );
    assert.deepEqual(migratedFactor.rows, [{ last_used_counter: '59479201' }]);

    assert.equal(
      (await client.query('SELECT id FROM vendors WHERE id = $1', [legacyVendorId])).rowCount,
      1,
    );
    assert.equal(
      (await client.query('SELECT id FROM households WHERE id = $1', [legacyHouseholdId])).rowCount,
      1,
    );
    assert.equal((await client.query('SELECT id FROM units WHERE id=$1', [legacyUnitId])).rowCount, 1);
    assert.equal((await client.query('SELECT id FROM products WHERE id=$1', [legacyProductId])).rowCount, 1);
    assert.equal((await client.query('SELECT id FROM delivery_slots WHERE id=$1', [legacySlotId])).rowCount, 1);
    assert.equal((await client.query('SELECT id FROM global_prices WHERE id=$1', [legacyGlobalPriceId])).rowCount, 1);
    assert.equal((await client.query('SELECT id FROM customer_price_overrides WHERE id=$1', [legacyOverrideId])).rowCount, 1);
    assert.equal((await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'schedule_generation_runs'`,
      [schema],
    )).rowCount, 1);

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
    [[
      'vendor_memberships',
      'support_access_grants',
      'audit_events',
      'owner_enrollments',
      'leave_requests',
      'leave_request_revisions',
      'leave_revision_subscriptions',
      'leave_occurrence_decisions',
      'delivery_events',
      'delivery_price_snapshots',
      'notifications',
    ]],
  );
  assert.equal(rls.rows.length, 11);
  assert.ok(
    rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
  );

  const role = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
  );
  assert.deepEqual(role.rows[0], { rolbypassrls: false, rolsuper: false });
});

void test('authentication authority functions expose narrow contracts only to runtime', async () => {
  const functions = await ownerPool.query<{
    name: string;
    security_definer: boolean;
    configuration: string[] | null;
    public_execute: boolean;
    runtime_execute: boolean;
  }>(
    `SELECT p.proname AS name,
            p.prosecdef AS security_definer,
            p.proconfig AS configuration,
            EXISTS (
              SELECT 1
              FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
              WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
            ) AS public_execute,
            has_function_privilege('milktrack_app', p.oid, 'EXECUTE') AS runtime_execute
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY($1::text[])
     ORDER BY p.proname`,
    [[
      'activate_invited_phone_memberships',
      'authentication_authority_memberships',
      'has_phone_auth_membership',
    ]],
  );
  assert.deepEqual(
    functions.rows.map(({ name, security_definer, configuration, public_execute, runtime_execute }) => ({
      name,
      security_definer,
      configuration,
      public_execute,
      runtime_execute,
    })),
    [
      'activate_invited_phone_memberships',
      'authentication_authority_memberships',
      'has_phone_auth_membership',
    ].map((name) => ({
      name,
      security_definer: true,
      configuration: ['search_path=pg_catalog, public'],
      public_execute: false,
      runtime_execute: true,
    })),
  );

  const index = await ownerPool.query<{ definition: string }>(
    `SELECT indexdef AS definition FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'vendor_memberships_user_id_status_vendor_id_auth_idx'`,
  );
  assert.equal(index.rowCount, 1);
  assert.match(index.rows[0].definition, /\(user_id, status, vendor_id\)/);
  assert.match(index.rows[0].definition, /ended_at IS NULL.*deleted_at IS NULL/);

  const unknownUserId = randomUUID();
  const client = await pool.connect();
  try {
    assert.deepEqual(
      (await client.query(
        'SELECT * FROM authentication_authority_memberships($1, true, true, true)',
        [unknownUserId],
      )).rows,
      [],
    );
    assert.deepEqual(
      (await client.query(
        'SELECT has_phone_auth_membership($1, true, true)',
        [unknownUserId],
      )).rows,
      [{ has_phone_auth_membership: false }],
    );
    assert.deepEqual(
      (await client.query(
        'SELECT * FROM activate_invited_phone_memberships($1, now(), $2, NULL, NULL)',
        [unknownUserId, randomUUID()],
      )).rows,
      [],
    );
  } finally {
    client.release();
  }
});

void test('owner enrollment storage is tenant-forced and its resolver exposes only exact eligible handles', async () => {
  const vendorIds = [randomUUID(), randomUUID()];
  const userIds = [randomUUID(), randomUUID()];
  const identityIds = [randomUUID(), randomUUID()];
  const membershipIds = [randomUUID(), randomUUID()];
  const enrollmentIds = [randomUUID(), randomUUID()];
  const setupHashes = [`setup-${randomUUID()}`, `setup-${randomUUID()}`];
  await ownerPool.query(
    `INSERT INTO vendors
       (id, code, legal_name, display_name, status, timezone, currency,
        skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'RLS One', 'RLS One', 'onboarding', 'Asia/Kolkata', 'INR', 0, 1, now()),
            ($3, $4, 'RLS Two', 'RLS Two', 'onboarding', 'Asia/Kolkata', 'INR', 0, 1, now())`,
    [vendorIds[0], `rls-${vendorIds[0]}`, vendorIds[1], `rls-${vendorIds[1]}`],
  );
  for (let index = 0; index < 2; index += 1) {
    await ownerPool.query(
      `INSERT INTO users (id, display_name, updated_at) VALUES ($1, $2, now())`,
      [userIds[index], `RLS User ${index}`],
    );
    await ownerPool.query(
      `INSERT INTO user_identities
         (id, user_id, type, normalized_value, is_primary, updated_at)
       VALUES ($1, $2, 'email', $3, true, now())`,
      [identityIds[index], userIds[index], `rls-${userIds[index]}@example.com`],
    );
    await ownerPool.query(
      `INSERT INTO vendor_memberships
         (id, vendor_id, user_id, role, status, updated_at)
       VALUES ($1, $2, $3, 'vendor_owner', 'invited', now())`,
      [membershipIds[index], vendorIds[index], userIds[index]],
    );
    await ownerPool.query(
      `INSERT INTO owner_enrollments
         (id, vendor_id, membership_id, user_id, identity_id,
          setup_token_hash, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 hour', now())`,
      [
        enrollmentIds[index], vendorIds[index], membershipIds[index],
        userIds[index], identityIds[index], setupHashes[index],
      ],
    );
  }

  const client = await pool.connect();
  try {
    const invisible = await client.query<{ count: string }>(
      'SELECT count(*) FROM owner_enrollments',
    );
    assert.equal(invisible.rows[0]?.count, '0');
    assert.equal(
      (await client.query(
        "UPDATE owner_enrollments SET delivery_state = 'failed' RETURNING id",
      )).rowCount,
      0,
    );
    const insertEnrollment = (vendorIndex: number) => client.query(
      `INSERT INTO owner_enrollments
         (id, vendor_id, membership_id, user_id, identity_id,
          setup_token_hash, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 hour', now())`,
      [
        randomUUID(), vendorIds[vendorIndex], membershipIds[vendorIndex],
        userIds[vendorIndex], identityIds[vendorIndex], `runtime-${randomUUID()}`,
      ],
    );
    await assert.rejects(insertEnrollment(0), /row-level security policy/);
    await assert.rejects(
      client.query('DELETE FROM owner_enrollments WHERE id = $1', [enrollmentIds[0]]),
      /permission denied/,
    );

    const exact = await client.query(
      'SELECT * FROM resolve_owner_enrollment_handle($1, $2)',
      [setupHashes[0], 'setup'],
    );
    assert.deepEqual(exact.rows, [{
      enrollment_id: enrollmentIds[0],
      vendor_id: vendorIds[0],
      user_id: userIds[0],
    }]);
    for (const [hash, phase] of [
      ['wrong-hash', 'setup'],
      [setupHashes[0], 'completion'],
      [setupHashes[0], 'invalid-phase'],
    ]) {
      assert.equal(
        (await client.query(
          'SELECT * FROM resolve_owner_enrollment_handle($1, $2)',
          [hash, phase],
        )).rowCount,
        0,
      );
    }

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.vendor_id', $1, true)", [vendorIds[0]]);
    assert.deepEqual(
      (await client.query('SELECT id FROM owner_enrollments')).rows,
      [{ id: enrollmentIds[0] }],
    );
    assert.equal(
      (await client.query(
        "UPDATE owner_enrollments SET delivery_state = 'failed' WHERE id = $1",
        [enrollmentIds[1]],
      )).rowCount,
      0,
    );
    await assert.rejects(insertEnrollment(1), /row-level security policy/);
    await client.query('ROLLBACK');

    await ownerPool.query('DELETE FROM owner_enrollments WHERE id = $1', [
      enrollmentIds[0],
    ]);
    await assert.rejects(
      ownerPool.query(
        `INSERT INTO owner_enrollments
           (id, vendor_id, membership_id, user_id, identity_id,
            setup_token_hash, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 hour', now())`,
        [
          randomUUID(), vendorIds[0], membershipIds[0], userIds[0],
          identityIds[1], `mismatch-${randomUUID()}`,
        ],
      ),
      /owner_enrollments_identity_id_user_id_fkey/,
    );
  } finally {
    client.release();
    await ownerPool.query('DELETE FROM owner_enrollments WHERE id = ANY($1::uuid[])', [enrollmentIds]);
    await ownerPool.query('DELETE FROM vendor_memberships WHERE id = ANY($1::uuid[])', [membershipIds]);
    await ownerPool.query('DELETE FROM user_identities WHERE id = ANY($1::uuid[])', [identityIds]);
    await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [vendorIds]);
  }
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
