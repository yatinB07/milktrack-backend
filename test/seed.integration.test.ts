import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import test from 'node:test';

import pg from 'pg';

import type { PasswordHash } from '../src/identity/domain/password.js';
import { PasswordHasher } from '../src/identity/domain/password.js';
import { SecretBox } from '../src/identity/domain/secret-box.js';

const ownerPool = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });

const IDS = {
  users: [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000004',
  ],
  identities: [
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000006',
    '20000000-0000-4000-8000-000000000007',
    '20000000-0000-4000-8000-000000000008',
  ],
  vendors: [
    '30000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002',
  ],
  memberships: [
    '40000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000002',
  ],
  platformRoles: [
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
  ],
  mfaFactors: [
    '60000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000002',
    '60000000-0000-4000-8000-000000000003',
    '60000000-0000-4000-8000-000000000004',
  ],
} as const;

const BASE_EMAIL = 'seed-suite@example.test';
const PASSWORD = 'Task12-only-strong-passphrase';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const EMAILS = [
  'seed-suite+platform-admin@example.test',
  'seed-suite+product-owner@example.test',
  'seed-suite+vendor-a-owner@example.test',
  'seed-suite+vendor-b-owner@example.test',
] as const;

type SeedResult = Readonly<{ code: number | null; stdout: string; stderr: string }>;

function runSeed(overrides: NodeJS.ProcessEnv = {}): Promise<SeedResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'db:seed'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_ENV: 'test',
        NODE_ENV: 'test',
        SEED_ADMIN_EMAIL: BASE_EMAIL,
        SEED_ADMIN_PASSWORD: PASSWORD,
        SEED_TOTP_SECRET: TOTP_SECRET,
        ...overrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function cleanupSeed(): Promise<void> {
  await ownerPool.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[])', [
    IDS.users,
  ]);
  await ownerPool.query('DELETE FROM vendor_memberships WHERE id = ANY($1::uuid[])', [
    IDS.memberships,
  ]);
  await ownerPool.query('DELETE FROM platform_role_assignments WHERE id = ANY($1::uuid[])', [
    IDS.platformRoles,
  ]);
  await ownerPool.query('DELETE FROM mfa_factors WHERE id = ANY($1::uuid[])', [IDS.mfaFactors]);
  await ownerPool.query('DELETE FROM password_credentials WHERE user_id = ANY($1::uuid[])', [
    IDS.users,
  ]);
  await ownerPool.query('DELETE FROM user_identities WHERE id = ANY($1::uuid[])', [
    IDS.identities,
  ]);
  await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [IDS.vendors]);
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [IDS.users]);
}

async function seedOwnedCount(table: string, column: string, ids: readonly string[]): Promise<number> {
  const result = await ownerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE ${column} = ANY($1::uuid[])`,
    [ids],
  );
  return Number(result.rows[0]?.count);
}

test.before(cleanupSeed);
test.after(async () => {
  await cleanupSeed();
  await ownerPool.end();
});

void test('seed rejects production and non-local APP_ENV before attempting a database connection', async () => {
  for (const environment of [
    { APP_ENV: 'development', NODE_ENV: 'production' },
    { APP_ENV: 'staging', NODE_ENV: 'test' },
  ]) {
    const result = await runSeed({
      ...environment,
      DATABASE_URL: 'not-a-database-url',
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /development seed is disabled/i);
    assert.doesNotMatch(result.stderr, /database|connection|prisma/i);
  }
  assert.equal(await seedOwnedCount('users', 'id', IDS.users), 0);
});

void test('seed preflight rejects a natural-key collision without committing seed records', async () => {
  const collisionUserId = randomUUID();
  const collisionIdentityId = randomUUID();
  try {
    await ownerPool.query(
      `INSERT INTO users (id, display_name, updated_at) VALUES ($1, 'Collision User', now())`,
      [collisionUserId],
    );
    await ownerPool.query(
      `INSERT INTO user_identities
         (id, user_id, type, normalized_value, verified_at, is_primary, updated_at)
       VALUES ($1, $2, 'email', $3, now(), true, now())`,
      [collisionIdentityId, collisionUserId, EMAILS[0]],
    );

    const result = await runSeed();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /seed collision/i);
    assert.equal(await seedOwnedCount('users', 'id', IDS.users), 0);
    assert.equal(await seedOwnedCount('vendors', 'id', IDS.vendors), 0);
    assert.equal(await seedOwnedCount('user_identities', 'id', IDS.identities), 0);
  } finally {
    await ownerPool.query('DELETE FROM user_identities WHERE id = $1', [collisionIdentityId]);
    await ownerPool.query('DELETE FROM users WHERE id = $1', [collisionUserId]);
  }
});

void test('seed rejects an unrelated occupant of a stable user UUID without adopting it', async () => {
  await ownerPool.query(
    `INSERT INTO users (id, display_name, locale, updated_at)
     VALUES ($1, 'Unrelated UUID Occupant', 'fr', now())`,
    [IDS.users[0]],
  );
  try {
    const result = await runSeed();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /seed collision.*user/i);
    const occupant = await ownerPool.query<{ display_name: string; locale: string }>(
      'SELECT display_name, locale FROM users WHERE id = $1',
      [IDS.users[0]],
    );
    assert.deepEqual(occupant.rows, [{ display_name: 'Unrelated UUID Occupant', locale: 'fr' }]);
    assert.equal(await seedOwnedCount('users', 'id', IDS.users), 1);
    assert.equal(await seedOwnedCount('user_identities', 'id', IDS.identities), 0);
    assert.equal(await seedOwnedCount('vendors', 'id', IDS.vendors), 0);
  } finally {
    await cleanupSeed();
  }
});

void test('cross-tenant membership UUID collision rolls back every seed write', async () => {
  const unrelatedUserId = randomUUID();
  const unrelatedVendorId = randomUUID();
  await ownerPool.query(
    `INSERT INTO users (id, display_name, updated_at)
     VALUES ($1, 'Unrelated Membership User', now())`,
    [unrelatedUserId],
  );
  await ownerPool.query(
    `INSERT INTO vendors
       (id, code, legal_name, display_name, status, timezone, currency,
        skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'Unrelated Membership Vendor', 'Unrelated Membership Vendor',
             'active', 'Asia/Kolkata', 'INR', 0, 1, now())`,
    [unrelatedVendorId, `UNRELATED_${unrelatedVendorId.replaceAll('-', '').slice(0, 20)}`],
  );
  await ownerPool.query(
    `INSERT INTO vendor_memberships
       (id, vendor_id, user_id, role, status, joined_at, updated_at)
     VALUES ($1, $2, $3, 'customer', 'active', now(), now())`,
    [IDS.memberships[0], unrelatedVendorId, unrelatedUserId],
  );
  try {
    const result = await runSeed();
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), 'Seed collision detected for vendor membership');
    const collision = await ownerPool.query<{
      vendor_id: string;
      user_id: string;
      role: string;
    }>(
      'SELECT vendor_id, user_id, role::text FROM vendor_memberships WHERE id = $1',
      [IDS.memberships[0]],
    );
    assert.deepEqual(collision.rows, [
      { vendor_id: unrelatedVendorId, user_id: unrelatedUserId, role: 'customer' },
    ]);
    assert.equal(await seedOwnedCount('users', 'id', IDS.users), 0);
    assert.equal(await seedOwnedCount('user_identities', 'id', IDS.identities), 0);
    assert.equal(await seedOwnedCount('password_credentials', 'user_id', IDS.users), 0);
    assert.equal(await seedOwnedCount('mfa_factors', 'id', IDS.mfaFactors), 0);
    assert.equal(await seedOwnedCount('platform_role_assignments', 'id', IDS.platformRoles), 0);
    assert.equal(await seedOwnedCount('vendors', 'id', IDS.vendors), 0);
  } finally {
    await ownerPool.query('DELETE FROM vendor_memberships WHERE id = $1', [IDS.memberships[0]]);
    await ownerPool.query('DELETE FROM vendors WHERE id = $1', [unrelatedVendorId]);
    await ownerPool.query('DELETE FROM users WHERE id = $1', [unrelatedUserId]);
  }
});

void test('seed is idempotent, uses production crypto, and creates exact deterministic records', async () => {
  const first = await runSeed();
  assert.equal(first.code, 0, first.stderr);
  assert.doesNotMatch(`${first.stdout}${first.stderr}`, new RegExp(`${PASSWORD}|${TOTP_SECRET}`));

  const credentialsBefore = await ownerPool.query<{
    user_id: string;
    password_hash: string;
    salt: string;
    parameters: PasswordHash['parameters'];
  }>(
    `SELECT user_id, password_hash, salt, parameters
     FROM password_credentials WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`,
    [IDS.users],
  );
  const factorsBefore = await ownerPool.query<{ id: string; encrypted_secret: string }>(
    `SELECT id, encrypted_secret FROM mfa_factors
     WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [IDS.mfaFactors],
  );

  const second = await runSeed();
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(`${second.stdout}${second.stderr}`, new RegExp(`${PASSWORD}|${TOTP_SECRET}`));

  assert.equal(await seedOwnedCount('users', 'id', IDS.users), 4);
  assert.equal(await seedOwnedCount('user_identities', 'id', IDS.identities), 8);
  assert.equal(await seedOwnedCount('password_credentials', 'user_id', IDS.users), 4);
  assert.equal(await seedOwnedCount('mfa_factors', 'id', IDS.mfaFactors), 4);
  assert.equal(await seedOwnedCount('platform_role_assignments', 'id', IDS.platformRoles), 2);
  assert.equal(await seedOwnedCount('vendors', 'id', IDS.vendors), 2);
  assert.equal(await seedOwnedCount('vendor_memberships', 'id', IDS.memberships), 2);

  const identities = await ownerPool.query<{
    normalized_value: string;
    verified: boolean;
    is_primary: boolean;
  }>(
    `SELECT normalized_value, verified_at IS NOT NULL AS verified, is_primary
     FROM user_identities WHERE id = ANY($1::uuid[]) ORDER BY normalized_value`,
    [IDS.identities],
  );
  assert.equal(identities.rows.length, 8);
  assert.ok(EMAILS.every((email) => identities.rows.some((row) => row.normalized_value === email)));
  assert.ok(identities.rows.every((row) => row.verified && row.is_primary));

  const activeAssignments = await ownerPool.query<{ platform_roles: string; owners: string }>(
    `SELECT
       (SELECT count(*)::text FROM platform_role_assignments
        WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL) AS platform_roles,
       (SELECT count(*)::text FROM vendor_memberships
        WHERE id = ANY($2::uuid[]) AND role = 'vendor_owner' AND status = 'active'
          AND ended_at IS NULL AND deleted_at IS NULL) AS owners`,
    [IDS.platformRoles, IDS.memberships],
  );
  assert.deepEqual(activeAssignments.rows, [{ platform_roles: '2', owners: '2' }]);
  const roleMappings = await ownerPool.query<{ user_id: string; role: string }>(
    `SELECT user_id, role::text FROM platform_role_assignments
     WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [IDS.platformRoles],
  );
  assert.deepEqual(roleMappings.rows, [
    { user_id: IDS.users[0], role: 'platform_administrator' },
    { user_id: IDS.users[1], role: 'product_owner' },
  ]);
  const vendorMappings = await ownerPool.query<{
    id: string;
    code: string;
    status: string;
  }>(
    `SELECT id, code, status::text FROM vendors
     WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [IDS.vendors],
  );
  assert.deepEqual(vendorMappings.rows, [
    { id: IDS.vendors[0], code: 'DEV_VENDOR_A', status: 'active' },
    { id: IDS.vendors[1], code: 'DEV_VENDOR_B', status: 'active' },
  ]);
  const membershipMappings = await ownerPool.query<{
    vendor_id: string;
    user_id: string;
    role: string;
  }>(
    `SELECT vendor_id, user_id, role::text FROM vendor_memberships
     WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [IDS.memberships],
  );
  assert.deepEqual(membershipMappings.rows, [
    { vendor_id: IDS.vendors[0], user_id: IDS.users[2], role: 'vendor_owner' },
    { vendor_id: IDS.vendors[1], user_id: IDS.users[3], role: 'vendor_owner' },
  ]);

  const credentialsAfter = await ownerPool.query<{
    user_id: string;
    password_hash: string;
    salt: string;
    parameters: PasswordHash['parameters'];
  }>(
    `SELECT user_id, password_hash, salt, parameters
     FROM password_credentials WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`,
    [IDS.users],
  );
  const factorsAfter = await ownerPool.query<{ id: string; encrypted_secret: string }>(
    `SELECT id, encrypted_secret FROM mfa_factors
     WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [IDS.mfaFactors],
  );
  assert.deepEqual(credentialsAfter.rows, credentialsBefore.rows);
  assert.deepEqual(factorsAfter.rows, factorsBefore.rows);

  const hasher = new PasswordHasher();
  for (const credential of credentialsAfter.rows) {
    assert.equal(
      await hasher.verify(PASSWORD, {
        hash: credential.password_hash,
        salt: credential.salt,
        parameters: credential.parameters,
      }),
      true,
    );
  }
  const box = new SecretBox(Buffer.from(process.env.MFA_ENCRYPTION_KEY!, 'base64'));
  assert.ok(factorsAfter.rows.every((factor) => box.decrypt(factor.encrypted_secret) === TOTP_SECRET));
});

void test('rerun repairs missing seed rows without overwriting or resurrecting drift', async () => {
  const initial = await runSeed();
  assert.equal(initial.code, 0, initial.stderr);
  const driftedName = 'Locally Customized Administrator';
  const encryptedBefore = await ownerPool.query<{ encrypted_secret: string }>(
    'SELECT encrypted_secret FROM mfa_factors WHERE id = $1',
    [IDS.mfaFactors[0]],
  );
  const passwordBefore = await ownerPool.query<{ password_hash: string; salt: string }>(
    'SELECT password_hash, salt FROM password_credentials WHERE user_id = $1',
    [IDS.users[0]],
  );
  await ownerPool.query('UPDATE users SET display_name = $1 WHERE id = $2', [
    driftedName,
    IDS.users[0],
  ]);
  await ownerPool.query('UPDATE mfa_factors SET revoked_at = now() WHERE id = $1', [
    IDS.mfaFactors[0],
  ]);
  await ownerPool.query(
    `UPDATE vendor_memberships SET status = 'ended', ended_at = now() WHERE id = $1`,
    [IDS.memberships[0]],
  );
  await ownerPool.query('DELETE FROM user_identities WHERE id = $1', [IDS.identities[2]]);

  const result = await runSeed();
  assert.equal(result.code, 0, result.stderr);

  const drift = await ownerPool.query<{
    display_name: string;
    revoked: boolean;
    membership_status: string;
    identity_restored: boolean;
    encrypted_secret: string;
    password_hash: string;
    salt: string;
  }>(
    `SELECT
       u.display_name,
       f.revoked_at IS NOT NULL AS revoked,
       m.status::text AS membership_status,
       EXISTS (SELECT 1 FROM user_identities WHERE id = $4) AS identity_restored,
       f.encrypted_secret,
       p.password_hash,
       p.salt
     FROM users u
     JOIN mfa_factors f ON f.id = $2
     JOIN password_credentials p ON p.user_id = u.id
     JOIN vendor_memberships m ON m.id = $3
     WHERE u.id = $1`,
    [IDS.users[0], IDS.mfaFactors[0], IDS.memberships[0], IDS.identities[2]],
  );
  assert.deepEqual(drift.rows, [
    {
      display_name: driftedName,
      revoked: true,
      membership_status: 'ended',
      identity_restored: true,
      encrypted_secret: encryptedBefore.rows[0]?.encrypted_secret,
      password_hash: passwordBefore.rows[0]?.password_hash,
      salt: passwordBefore.rows[0]?.salt,
    },
  ]);

  const committedFiles = await Promise.all(
    ['prisma/seed.ts', '.env.example', 'README.md'].map((path) => readFile(path, 'utf8')),
  );
  assert.doesNotMatch(committedFiles.join('\n'), new RegExp(`${PASSWORD}|${TOTP_SECRET}`));
  const leakedAudit = await ownerPool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
     WHERE coalesce(old_value::text, '') LIKE ANY($1::text[])
       OR coalesce(new_value::text, '') LIKE ANY($1::text[])
       OR coalesce(reason, '') LIKE ANY($1::text[])`,
    [[`%${PASSWORD}%`, `%${TOTP_SECRET}%`]],
  );
  assert.deepEqual(leakedAudit.rows, [{ count: '0' }]);
  assert.equal(
    (
      await ownerPool.query(
        'SELECT id FROM audit_events WHERE actor_user_id = ANY($1::uuid[])',
        [IDS.users],
      )
    ).rowCount,
    0,
  );
});
