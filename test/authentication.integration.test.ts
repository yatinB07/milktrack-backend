import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { requestContextStore } from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  PrismaAuthenticationService,
  type SessionTokens,
} from '../src/identity/application/authentication.service.js';
import { PasswordHasher } from '../src/identity/domain/password.js';
import { SecretBox } from '../src/identity/domain/secret-box.js';
import { LocalOtpDelivery } from '../src/identity/infrastructure/local-otp.delivery.js';
import { PrismaIdentityStore } from '../src/identity/infrastructure/prisma-identity.store.js';

const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});
const authKey = Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64');
const mfaKey = Buffer.from(process.env.MFA_ENCRYPTION_KEY!, 'base64');

async function expectForcedAuditFailure(
  correlationId: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const suffix = randomUUID().replaceAll('-', '');
  const trigger = `reject_auth_audit_${suffix}`;
  const triggerFunction = `reject_auth_audit_fn_${suffix}`;
  try {
    await ownerPool.query(
      `CREATE FUNCTION ${triggerFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.correlation_id = '${correlationId}'::uuid THEN
           RAISE EXCEPTION 'forced authentication audit failure';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await ownerPool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events
       FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()`,
    );
    await assert.rejects(
      requestContextStore.run({ correlationId }, operation),
      /forced authentication audit failure/,
    );
  } finally {
    await ownerPool.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`);
    await ownerPool.query(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
  }
}

type Fixture = Readonly<{
  userId: string;
  identityId: string;
  vendorId: string;
  membershipId: string;
  phone: string;
}>;

const tokenHash = (value: string) =>
  createHmac('sha256', authKey).update(value).digest('hex');

const guaranteedWrongCode = (code: string) =>
  ((Number(code) + 1) % 1_000_000).toString().padStart(6, '0');

async function waitForLockWaiters(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(result.rows[0]?.count) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Expected at least ${expected} database lock waiters`);
}

function totpCode(secret: string, timeMs = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const character of secret.replace(/=+$/, '')) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest.at(-1)! & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000)
    .toString()
    .padStart(6, '0');
}

function guaranteedWrongTotp(secret: string): string {
  const now = Date.now();
  const valid = new Set([
    totpCode(secret, now - 30_000),
    totpCode(secret, now),
    totpCode(secret, now + 30_000),
  ]);
  for (let candidate = 0; candidate < 4; candidate += 1) {
    const code = String(candidate).padStart(6, '0');
    if (!valid.has(code)) return code;
  }
  throw new Error('Unable to choose a non-TOTP test code');
}

function expectAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof ApplicationError &&
    error.code === 'AUTHENTICATION_FAILED' &&
    error.status === 401 &&
    error.message === 'Authentication failed'
  );
}

function createService(): Readonly<{
  prisma: PrismaService;
  delivery: LocalOtpDelivery;
  service: PrismaAuthenticationService;
}> {
  const prisma = new PrismaService();
  const delivery = new LocalOtpDelivery({ appEnv: 'test', provider: 'local' });
  return {
    prisma,
    delivery,
    service: new PrismaAuthenticationService(
      new PrismaIdentityStore(prisma),
      delivery,
      {
        authHmacKey: authKey,
        mfaEncryptionKey: mfaKey,
        sessionTtlSeconds: 2_592_000,
      },
    ),
  };
}

async function insertPhoneFixture(phone: string): Promise<Fixture> {
  const fixture = {
    userId: randomUUID(),
    identityId: randomUUID(),
    vendorId: randomUUID(),
    membershipId: randomUUID(),
    phone,
  };
  await ownerPool.query('DELETE FROM otp_challenges WHERE destination_hash = $1', [
    tokenHash(phone),
  ]);
  await ownerPool.query(
    "INSERT INTO users (id, display_name, updated_at) VALUES ($1, 'Phone User', now())",
    [fixture.userId],
  );
  await ownerPool.query(
    `INSERT INTO user_identities
       (id, user_id, type, normalized_value, verified_at, is_primary, updated_at)
       VALUES ($1, $2, 'phone', $3, now(), true, now())`,
    [fixture.identityId, fixture.userId, phone],
  );
  await ownerPool.query(
    `INSERT INTO vendors
       (id, code, legal_name, display_name, timezone, currency,
        skip_cutoff_minutes, billing_day, status, updated_at)
       VALUES ($1, $2, 'Phone Vendor', 'Phone Vendor', 'Asia/Kolkata', 'INR',
               0, 1, 'active', now())`,
    [fixture.vendorId, `auth-${fixture.vendorId}`],
  );
  await ownerPool.query(
    `INSERT INTO vendor_memberships
       (id, vendor_id, user_id, role, status, joined_at, updated_at)
       VALUES ($1, $2, $3, 'customer', 'active', now(), now())`,
    [fixture.membershipId, fixture.vendorId, fixture.userId],
  );
  return fixture;
}

async function insertAdministrator(
  email: string,
  password: string,
  secret: string,
  options: Readonly<{ platformRole?: boolean }> = {},
): Promise<Readonly<{ userId: string; identityId: string; factorId: string; roleId: string }>> {
  await ownerPool.query(
    'DELETE FROM administrator_authentication_attempts WHERE account_key = $1',
    [tokenHash(email)],
  );
  const userId = randomUUID();
  const identityId = randomUUID();
  const roleId = randomUUID();
  const factorId = randomUUID();
  const encoded = await new PasswordHasher().hash(password);
  const encryptedSecret = new SecretBox(mfaKey).encrypt(secret);
  await ownerPool.query(
    "INSERT INTO users (id, display_name, updated_at) VALUES ($1, 'Platform Administrator', now())",
    [userId],
  );
  await ownerPool.query(
    `INSERT INTO user_identities
       (id, user_id, type, normalized_value, verified_at, is_primary, updated_at)
       VALUES ($1, $2, 'email', $3, now(), true, now())`,
    [identityId, userId, email],
  );
  await ownerPool.query(
    `INSERT INTO password_credentials
       (user_id, password_hash, salt, algorithm, parameters, changed_at)
       VALUES ($1, $2, $3, 'scrypt', $4::jsonb, now())`,
    [userId, encoded.hash, encoded.salt, JSON.stringify(encoded.parameters)],
  );
  await ownerPool.query(
    `INSERT INTO mfa_factors
       (id, user_id, type, encrypted_secret, enabled_at)
       VALUES ($1, $2, 'totp', $3, now())`,
    [factorId, userId, encryptedSecret],
  );
  if (options.platformRole !== false) {
    await ownerPool.query(
      `INSERT INTO platform_role_assignments
         (id, user_id, role, granted_by)
         VALUES ($1, $2, 'platform_administrator', $2)`,
      [roleId, userId],
    );
  }
  return { userId, identityId, factorId, roleId };
}

async function cleanupUsers(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await ownerPool.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[])', [
    userIds,
  ]);
  await ownerPool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
  await ownerPool.query(
    'DELETE FROM pending_mfa_authentications WHERE user_id = ANY($1::uuid[])',
    [userIds],
  );
  await ownerPool.query(
    'DELETE FROM otp_challenges WHERE identity_id IN (SELECT id FROM user_identities WHERE user_id = ANY($1::uuid[]))',
    [userIds],
  );
  await ownerPool.query('DELETE FROM platform_role_assignments WHERE user_id = ANY($1::uuid[])', [
    userIds,
  ]);
  await ownerPool.query('DELETE FROM vendor_memberships WHERE user_id = ANY($1::uuid[])', [userIds]);
  await ownerPool.query('DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])', [userIds]);
  await ownerPool.query('DELETE FROM password_credentials WHERE user_id = ANY($1::uuid[])', [
    userIds,
  ]);
  await ownerPool.query('DELETE FROM user_identities WHERE user_id = ANY($1::uuid[])', [userIds]);
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await ownerPool.query('DELETE FROM otp_challenges WHERE destination_hash = $1', [
    tokenHash(fixture.phone),
  ]);
  await cleanupUsers([fixture.userId]);
  await ownerPool.query('DELETE FROM vendors WHERE id = $1', [fixture.vendorId]);
}

async function requestPhoneSession(
  service: PrismaAuthenticationService,
  delivery: LocalOtpDelivery,
  phone: string,
  deviceId: string,
): Promise<SessionTokens> {
  const challenge = await service.requestPhoneOtp({ phone, purpose: 'sign_in' });
  const code = delivery.takeLastCodeForTest(phone);
  assert.ok(code);
  const session = await service.verifyPhoneOtp({
    challengeToken: challenge.challengeToken,
    code,
    deviceId,
  });
  await ownerPool.query(
    `UPDATE otp_challenges SET created_at = now() - interval '61 seconds'
     WHERE token_hash = $1`,
    [tokenHash(challenge.challengeToken)],
  );
  return session;
}

test.after(() => ownerPool.end());

void test('known and unknown phone requests are indistinguishable while only known identities receive OTP delivery', async () => {
  const fixture = await insertPhoneFixture('+919876500001');
  const { prisma, delivery, service } = createService();
  const before = Date.now();
  try {
    const known = await service.requestPhoneOtp({
      phone: ' +919876500001 ',
      purpose: 'sign_in',
      ipHash: 'known-ip',
    });
    const unknown = await service.requestPhoneOtp({
      phone: '+919876599999',
      purpose: 'sign_in',
      ipHash: 'unknown-ip',
    });

    assert.equal(known.accepted, true);
    assert.equal(unknown.accepted, true);
    assert.equal(Buffer.from(known.challengeToken, 'base64url').length, 32);
    assert.equal(Buffer.from(unknown.challengeToken, 'base64url').length, 32);
    assert.ok(known.expiresAt.getTime() >= before + 299_000);
    assert.ok(known.expiresAt.getTime() <= before + 301_000);
    assert.ok(unknown.expiresAt.getTime() >= before + 299_000);
    assert.ok(unknown.expiresAt.getTime() <= before + 301_000);
    const code = delivery.takeLastCodeForTest(fixture.phone);
    assert.match(code ?? '', /^\d{6}$/);
    assert.equal(delivery.takeLastCodeForTest('+919876599999'), undefined);

    const rows = await ownerPool.query<{
      id: string;
      identity_id: string | null;
      token_hash: string;
      destination_hash: string;
      code_hash: string;
    }>(
      `SELECT id, identity_id, token_hash, destination_hash, code_hash
       FROM otp_challenges WHERE token_hash = ANY($1) ORDER BY identity_id NULLS FIRST`,
      [[tokenHash(known.challengeToken), tokenHash(unknown.challengeToken)]],
    );
    assert.equal(rows.rowCount, 2);
    assert.equal(rows.rows[0]?.identity_id, null);
    assert.equal(rows.rows[1]?.identity_id, fixture.identityId);
    assert.ok(rows.rows.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash)));
    assert.ok(rows.rows.every((row) => /^[0-9a-f]{64}$/.test(row.destination_hash)));
    assert.ok(rows.rows.every((row) => /^[0-9a-f]{64}$/.test(row.code_hash)));
    const stored = JSON.stringify(rows.rows);
    assert.doesNotMatch(stored, /\+919876500001|\+919876599999/);
    assert.ok(!stored.includes(known.challengeToken));
    assert.ok(!stored.includes(unknown.challengeToken));
    assert.ok(!stored.includes(code!));
    const audits = await ownerPool.query<{ actor_user_id: string | null }>(
      `SELECT actor_user_id FROM audit_events
       WHERE action = 'auth.otp_challenge_issued' AND entity_id = ANY($1::uuid[])
       ORDER BY actor_user_id NULLS FIRST`,
      [rows.rows.map((row) => row.id)],
    );
    assert.deepEqual(audits.rows, [
      { actor_user_id: null },
      { actor_user_id: fixture.userId },
    ]);
    await assert.rejects(
      service.verifyPhoneOtp({
        challengeToken: unknown.challengeToken,
        code: '000000',
        deviceId: 'unknown-device',
      }),
      expectAuthenticationFailure,
    );
  } finally {
    await prisma.$disconnect();
    await ownerPool.query(
      `DELETE FROM audit_events
       WHERE entity_id IN (
         SELECT id FROM otp_challenges
         WHERE request_ip_hash IN ('known-ip', 'unknown-ip')
       )`,
    );
    await ownerPool.query(
      `DELETE FROM otp_challenges
       WHERE request_ip_hash IN ('known-ip', 'unknown-ip')`,
    );
    await cleanupFixture(fixture);
  }
});

void test('authentication audits exist and audit failure rolls back challenge and session state', async () => {
  const fixture = await insertPhoneFixture('+919876500023');
  const { prisma, delivery, service } = createService();
  const failedChallengeCorrelation = randomUUID();
  const failedSessionCorrelation = randomUUID();
  const suffix = randomUUID().replaceAll('-', '');
  const trigger = `reject_auth_audit_${suffix}`;
  const triggerFunction = `reject_auth_audit_fn_${suffix}`;
  try {
    await ownerPool.query(
      `CREATE FUNCTION ${triggerFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.correlation_id IN ('${failedChallengeCorrelation}'::uuid, '${failedSessionCorrelation}'::uuid) THEN
           RAISE EXCEPTION 'forced authentication audit failure';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await ownerPool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events
       FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()`,
    );

    const before = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM otp_challenges WHERE destination_hash = $1',
      [tokenHash(fixture.phone)],
    );
    await assert.rejects(
      requestContextStore.run(
        { correlationId: failedChallengeCorrelation },
        () => service.requestPhoneOtp({ phone: fixture.phone, purpose: 'sign_in' }),
      ),
      /forced authentication audit failure/,
    );
    const after = await ownerPool.query<{ count: string }>(
      'SELECT count(*) FROM otp_challenges WHERE destination_hash = $1',
      [tokenHash(fixture.phone)],
    );
    assert.deepEqual(after.rows, before.rows);

    const challenge = await service.requestPhoneOtp({ phone: fixture.phone, purpose: 'sign_in' });
    const code = delivery.takeLastCodeForTest(fixture.phone);
    assert.ok(code);
    await assert.rejects(
      requestContextStore.run(
        { correlationId: failedSessionCorrelation },
        () =>
          service.verifyPhoneOtp({
            challengeToken: challenge.challengeToken,
            code,
            deviceId: 'audit-rollback-device',
          }),
      ),
      /forced authentication audit failure/,
    );
    const rolledBack = await ownerPool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM otp_challenges WHERE token_hash = $1',
      [tokenHash(challenge.challengeToken)],
    );
    assert.equal(rolledBack.rows[0]?.consumed_at, null);
    assert.equal(
      (await ownerPool.query('SELECT id FROM sessions WHERE user_id = $1', [fixture.userId]))
        .rowCount,
      0,
    );

    const session = await service.verifyPhoneOtp({
      challengeToken: challenge.challengeToken,
      code,
      deviceId: 'audit-rollback-device',
    });
    assert.equal((await service.authenticate(session.accessToken)).userId, fixture.userId);
    const audits = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit_events
       WHERE actor_user_id = $1
         AND action IN ('auth.otp_challenge_issued', 'auth.session_created')
       ORDER BY action`,
      [fixture.userId],
    );
    assert.deepEqual(audits.rows, [
      { action: 'auth.otp_challenge_issued' },
      { action: 'auth.session_created' },
    ]);
  } finally {
    await ownerPool.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`);
    await ownerPool.query(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
    await prisma.$disconnect();
    await cleanupFixture(fixture);
  }
});

void test('audit failure rolls back OTP, MFA, refresh, replay, logout, and logout-all mutations', async () => {
  const password = 'audit rollback password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const administrator = await insertAdministrator('audit-rollback@example.test', password, secret);
  const fixtures = await Promise.all([
    insertPhoneFixture('+919876500024'),
    insertPhoneFixture('+919876500025'),
    insertPhoneFixture('+919876500026'),
    insertPhoneFixture('+919876500027'),
  ]);
  const { prisma, delivery, service } = createService();
  try {
    await expectForcedAuditFailure(randomUUID(), () =>
      service.startAdministratorSignIn({
        email: 'audit-rollback@example.test',
        password: 'wrong password',
        deviceId: 'password-failure-rollback-device',
      }),
    );
    assert.deepEqual(
      (await ownerPool.query<{ failed_attempts: number; locked_until: Date | null }>(
        `SELECT failed_attempts, locked_until FROM password_credentials WHERE user_id = $1`,
        [administrator.userId],
      )).rows,
      [{ failed_attempts: 0, locked_until: null }],
    );
    assert.equal(
      (await ownerPool.query(
        `SELECT id FROM administrator_authentication_attempts WHERE account_key = $1`,
        [tokenHash('audit-rollback@example.test')],
      )).rowCount,
      0,
    );

    const otpLockChallenge = await service.requestPhoneOtp({
      phone: fixtures[3].phone,
      purpose: 'sign_in',
    });
    const otpCode = delivery.takeLastCodeForTest(fixtures[3].phone);
    assert.ok(otpCode);
    const wrongOtpCode = guaranteedWrongCode(otpCode);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(
        service.verifyPhoneOtp({
          challengeToken: otpLockChallenge.challengeToken,
          code: wrongOtpCode,
          deviceId: 'otp-lock-rollback-device',
        }),
        expectAuthenticationFailure,
      );
    }
    await expectForcedAuditFailure(randomUUID(), () =>
      service.verifyPhoneOtp({
        challengeToken: otpLockChallenge.challengeToken,
        code: wrongOtpCode,
        deviceId: 'otp-lock-rollback-device',
      }),
    );
    assert.equal(
      (await ownerPool.query<{ attempt_count: number }>(
        'SELECT attempt_count FROM otp_challenges WHERE token_hash = $1',
        [tokenHash(otpLockChallenge.challengeToken)],
      )).rows[0]?.attempt_count,
      4,
    );
    assert.equal(
      (await ownerPool.query(
        `SELECT id FROM audit_events
         WHERE actor_user_id = $1 AND action = 'auth.otp_locked'`,
        [fixtures[3].userId],
      )).rowCount,
      0,
    );
    assert.equal(
      (await ownerPool.query(
        `SELECT id FROM administrator_authentication_attempts WHERE account_key = $1`,
        [tokenHash('audit-rollback@example.test')],
      )).rowCount,
      0,
    );
    await assert.rejects(
      service.verifyPhoneOtp({
        challengeToken: otpLockChallenge.challengeToken,
        code: wrongOtpCode,
        deviceId: 'otp-lock-rollback-device',
      }),
      expectAuthenticationFailure,
    );
    assert.equal(
      (await ownerPool.query<{ attempt_count: number }>(
        'SELECT attempt_count FROM otp_challenges WHERE token_hash = $1',
        [tokenHash(otpLockChallenge.challengeToken)],
      )).rows[0]?.attempt_count,
      5,
    );

    await ownerPool.query(
      `UPDATE password_credentials SET failed_attempts = 3, locked_until = NULL
       WHERE user_id = $1`,
      [administrator.userId],
    );
    await expectForcedAuditFailure(randomUUID(), () =>
      service.startAdministratorSignIn({
        email: 'audit-rollback@example.test',
        password,
        deviceId: 'pending-rollback-device',
      }),
    );
    assert.equal(
      (await ownerPool.query(
        'SELECT id FROM pending_mfa_authentications WHERE user_id = $1',
        [administrator.userId],
      )).rowCount,
      0,
    );
    assert.deepEqual(
      (await ownerPool.query<{ failed_attempts: number; locked_until: Date | null }>(
        `SELECT failed_attempts, locked_until FROM password_credentials WHERE user_id = $1`,
        [administrator.userId],
      )).rows,
      [{ failed_attempts: 3, locked_until: null }],
    );
    assert.equal(
      (await ownerPool.query(
        `SELECT id FROM administrator_authentication_attempts
         WHERE account_key = $1 AND stage = 'pending_mfa'`,
        [tokenHash('audit-rollback@example.test')],
      )).rowCount,
      0,
    );

    const lockedPending = await service.startAdministratorSignIn({
      email: 'audit-rollback@example.test',
      password,
      deviceId: 'lock-rollback-device',
    });
    const wrongCode = guaranteedWrongTotp(secret);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(
        service.verifyAdministratorMfa({
          pendingMfaToken: lockedPending.pendingMfaToken,
          code: wrongCode,
          deviceId: 'lock-rollback-device',
        }),
        expectAuthenticationFailure,
      );
    }
    await expectForcedAuditFailure(randomUUID(), () =>
      service.verifyAdministratorMfa({
        pendingMfaToken: lockedPending.pendingMfaToken,
        code: wrongCode,
        deviceId: 'lock-rollback-device',
      }),
    );
    assert.equal(
      (await ownerPool.query<{ attempt_count: number }>(
        'SELECT attempt_count FROM pending_mfa_authentications WHERE token_hash = $1',
        [tokenHash(lockedPending.pendingMfaToken)],
      )).rows[0]?.attempt_count,
      4,
    );
    assert.deepEqual(
      (await ownerPool.query<{ failed_attempts: number; locked_until: Date | null }>(
        `SELECT failed_attempts, locked_until FROM password_credentials WHERE user_id = $1`,
        [administrator.userId],
      )).rows,
      [{ failed_attempts: 0, locked_until: null }],
    );
    await assert.rejects(
      service.verifyAdministratorMfa({
        pendingMfaToken: lockedPending.pendingMfaToken,
        code: wrongCode,
        deviceId: 'lock-rollback-device',
      }),
      expectAuthenticationFailure,
    );

    // This test now moves beyond the security window before exercising an unrelated audit rollback.
    await ownerPool.query(
      `UPDATE password_credentials SET failed_attempts = 0, locked_until = NULL
       WHERE user_id = $1`,
      [administrator.userId],
    );
    await ownerPool.query(
      `UPDATE pending_mfa_authentications
       SET created_at = now() - interval '16 minutes'
       WHERE user_id = $1`,
      [administrator.userId],
    );

    const successfulPending = await service.startAdministratorSignIn({
      email: 'audit-rollback@example.test',
      password,
      deviceId: 'mfa-rollback-device',
    });
    await expectForcedAuditFailure(randomUUID(), () =>
      service.verifyAdministratorMfa({
        pendingMfaToken: successfulPending.pendingMfaToken,
        code: totpCode(secret),
        deviceId: 'mfa-rollback-device',
      }),
    );
    const mfaRollback = await ownerPool.query<{
      consumed_at: Date | null;
      last_used_at: Date | null;
      last_used_counter: string | null;
      session_count: string;
    }>(
      `SELECT pending.consumed_at, factor.last_used_at,
              factor.last_used_counter::text,
              (SELECT count(*) FROM sessions WHERE user_id = pending.user_id) AS session_count
       FROM pending_mfa_authentications pending
       JOIN mfa_factors factor ON factor.user_id = pending.user_id
       WHERE pending.token_hash = $1`,
      [tokenHash(successfulPending.pendingMfaToken)],
    );
    assert.deepEqual(mfaRollback.rows, [
      {
        consumed_at: null,
        last_used_at: null,
        last_used_counter: null,
        session_count: '0',
      },
    ]);
    await service.verifyAdministratorMfa({
      pendingMfaToken: successfulPending.pendingMfaToken,
      code: totpCode(secret),
      deviceId: 'mfa-rollback-device',
    });

    const refreshPredecessor = await requestPhoneSession(
      service,
      delivery,
      fixtures[0].phone,
      'refresh-rollback-device',
    );
    await expectForcedAuditFailure(randomUUID(), () =>
      service.refresh(refreshPredecessor.refreshToken, 'refresh-rollback-device'),
    );
    assert.equal(
      (await ownerPool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM sessions WHERE refresh_token_hash = $1',
        [tokenHash(refreshPredecessor.refreshToken)],
      )).rows[0]?.revoked_at,
      null,
    );
    assert.equal(
      (await ownerPool.query('SELECT id FROM sessions WHERE user_id = $1', [fixtures[0].userId]))
        .rowCount,
      1,
    );
    const refreshSuccessor = await service.refresh(
      refreshPredecessor.refreshToken,
      'refresh-rollback-device',
    );
    await expectForcedAuditFailure(randomUUID(), () =>
      service.refresh(refreshPredecessor.refreshToken, 'refresh-rollback-device'),
    );
    assert.equal(
      (await service.authenticate(refreshSuccessor.accessToken)).userId,
      fixtures[0].userId,
    );
    await assert.rejects(
      service.refresh(refreshPredecessor.refreshToken, 'refresh-rollback-device'),
      expectAuthenticationFailure,
    );
    await assert.rejects(
      service.authenticate(refreshSuccessor.accessToken),
      expectAuthenticationFailure,
    );

    const logoutSession = await requestPhoneSession(
      service,
      delivery,
      fixtures[1].phone,
      'logout-rollback-device',
    );
    await expectForcedAuditFailure(randomUUID(), () => service.logout(logoutSession.accessToken));
    assert.equal((await service.authenticate(logoutSession.accessToken)).userId, fixtures[1].userId);
    await service.logout(logoutSession.accessToken);

    const logoutAllOne = await requestPhoneSession(
      service,
      delivery,
      fixtures[2].phone,
      'logout-all-rollback-a',
    );
    const logoutAllTwo = await requestPhoneSession(
      service,
      delivery,
      fixtures[2].phone,
      'logout-all-rollback-b',
    );
    await expectForcedAuditFailure(randomUUID(), () => service.logoutAll(logoutAllOne.accessToken));
    assert.equal((await service.authenticate(logoutAllOne.accessToken)).userId, fixtures[2].userId);
    assert.equal((await service.authenticate(logoutAllTwo.accessToken)).userId, fixtures[2].userId);
    await service.logoutAll(logoutAllOne.accessToken);

    const exactAudits = await ownerPool.query<{
      actor_user_id: string | null;
      action: string;
      vendor_id: string | null;
      old_value: unknown;
      new_value: unknown;
    }>(
      `SELECT actor_user_id, action, vendor_id, old_value, new_value
       FROM audit_events
       WHERE actor_user_id = ANY($1::uuid[])
         AND action IN (
           'auth.mfa_pending_created', 'auth.mfa_locked', 'auth.session_created',
           'auth.otp_locked',
           'auth.session_rotated', 'auth.session_replay_detected',
           'auth.session_revoked', 'auth.all_sessions_revoked'
         )`,
      [[administrator.userId, ...fixtures.map((fixture) => fixture.userId)]],
    );
    const count = (actorUserId: string, action: string) =>
      exactAudits.rows.filter(
        (audit) => audit.actor_user_id === actorUserId && audit.action === action,
      ).length;
    assert.equal(count(administrator.userId, 'auth.mfa_pending_created'), 2);
    assert.equal(count(administrator.userId, 'auth.mfa_locked'), 1);
    assert.equal(count(administrator.userId, 'auth.session_created'), 1);
    assert.equal(count(fixtures[3].userId, 'auth.otp_locked'), 1);
    assert.equal(count(fixtures[0].userId, 'auth.session_rotated'), 1);
    assert.equal(count(fixtures[0].userId, 'auth.session_replay_detected'), 1);
    assert.equal(count(fixtures[1].userId, 'auth.session_revoked'), 1);
    assert.equal(count(fixtures[2].userId, 'auth.all_sessions_revoked'), 1);
    assert.ok(
      exactAudits.rows.every(
        (audit) => audit.vendor_id === null && audit.old_value === null && audit.new_value === null,
      ),
    );
  } finally {
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
    await Promise.all(fixtures.map(cleanupFixture));
  }
});

void test('unverified phone identities remain undisclosed and cannot receive an OTP', async () => {
  const fixture = await insertPhoneFixture('+919876500011');
  const { prisma, delivery, service } = createService();
  try {
    await ownerPool.query(
      'UPDATE user_identities SET verified_at = NULL WHERE id = $1',
      [fixture.identityId],
    );
    const challenge = await service.requestPhoneOtp({
      phone: fixture.phone,
      purpose: 'sign_in',
    });

    assert.equal(delivery.takeLastCodeForTest(fixture.phone), undefined);
    const row = await ownerPool.query<{ identity_id: string | null }>(
      'SELECT identity_id FROM otp_challenges WHERE token_hash = $1',
      [tokenHash(challenge.challengeToken)],
    );
    assert.equal(row.rows[0]?.identity_id, null);
  } finally {
    await prisma.$disconnect();
    await cleanupFixture(fixture);
  }
});

void test('phone OTP cannot create a privileged platform session for a mixed-role user', async () => {
  const fixture = await insertPhoneFixture('+919876500012');
  const { prisma, delivery, service } = createService();
  try {
    await ownerPool.query(
      `INSERT INTO platform_role_assignments (id, user_id, role, granted_by)
       VALUES ($1, $2, 'platform_administrator', $2)`,
      [randomUUID(), fixture.userId],
    );
    const challenge = await service.requestPhoneOtp({
      phone: fixture.phone,
      purpose: 'sign_in',
    });
    assert.equal(delivery.takeLastCodeForTest(fixture.phone), undefined);
    const challengeRow = await ownerPool.query<{ identity_id: string | null }>(
      'SELECT identity_id FROM otp_challenges WHERE token_hash = $1',
      [tokenHash(challenge.challengeToken)],
    );
    assert.equal(challengeRow.rows[0]?.identity_id, null);
    assert.equal(
      (await ownerPool.query('SELECT id FROM sessions WHERE user_id = $1', [fixture.userId]))
        .rowCount,
      0,
    );
  } finally {
    await prisma.$disconnect();
    await cleanupFixture(fixture);
  }
});

void test('phone OTP rejects vendor-owner and vendor-administrator memberships', async () => {
  const fixtures = await Promise.all([
    insertPhoneFixture('+919876500013'),
    insertPhoneFixture('+919876500014'),
    insertPhoneFixture('+919876500018'),
  ]);
  const { prisma, delivery, service } = createService();
  try {
    for (const [index, role] of ['vendor_owner', 'vendor_administrator'].entries()) {
      const fixture = fixtures[index];
      await ownerPool.query(
        'UPDATE vendor_memberships SET role = $1 WHERE id = $2',
        [role, fixture.membershipId],
      );
      const challenge = await service.requestPhoneOtp({
        phone: fixture.phone,
        purpose: 'sign_in',
      });
      assert.equal(delivery.takeLastCodeForTest(fixture.phone), undefined);
      const challengeRow = await ownerPool.query<{ identity_id: string | null }>(
        'SELECT identity_id FROM otp_challenges WHERE token_hash = $1',
        [tokenHash(challenge.challengeToken)],
      );
      assert.equal(challengeRow.rows[0]?.identity_id, null);
    }

    await ownerPool.query(
      `INSERT INTO vendor_memberships
         (id, vendor_id, user_id, role, status, joined_at, updated_at)
       VALUES ($1, $2, $3, 'vendor_owner', 'active', now(), now())`,
      [randomUUID(), fixtures[2].vendorId, fixtures[2].userId],
    );
    const mixed = await service.requestPhoneOtp({
      phone: fixtures[2].phone,
      purpose: 'sign_in',
    });
    assert.equal(delivery.takeLastCodeForTest(fixtures[2].phone), undefined);
    const mixedChallengeRow = await ownerPool.query<{ identity_id: string | null }>(
      'SELECT identity_id FROM otp_challenges WHERE token_hash = $1',
      [tokenHash(mixed.challengeToken)],
    );
    assert.equal(mixedChallengeRow.rows[0]?.identity_id, null);
  } finally {
    await prisma.$disconnect();
    await Promise.all(fixtures.map(cleanupFixture));
  }
});

void test('a phone session cannot inherit a platform role granted after OTP verification', async () => {
  const fixture = await insertPhoneFixture('+919876500015');
  const { prisma, delivery, service } = createService();
  try {
    const session = await requestPhoneSession(
      service,
      delivery,
      fixture.phone,
      'post-grant-device',
    );
    await ownerPool.query(
      `INSERT INTO platform_role_assignments (id, user_id, role, granted_by)
       VALUES ($1, $2, 'platform_administrator', $2)`,
      [randomUUID(), fixture.userId],
    );

    await assert.rejects(
      service.authenticate(session.accessToken),
      expectAuthenticationFailure,
    );
    await assert.rejects(
      service.refresh(session.refreshToken, 'post-grant-device'),
      expectAuthenticationFailure,
    );
    const persisted = await ownerPool.query<{ authentication_method: string }>(
      'SELECT authentication_method FROM sessions WHERE user_id = $1',
      [fixture.userId],
    );
    assert.deepEqual(persisted.rows, [{ authentication_method: 'phone_otp' }]);
  } finally {
    await prisma.$disconnect();
    await cleanupFixture(fixture);
  }
});

void test('phone OTP resend, destination, and IP rate limits return stable positive retry metadata', async () => {
  const { prisma, service } = createService();
  const phones = Array.from({ length: 6 }, (_, index) => `+91987550${String(index).padStart(4, '0')}`);
  try {
    await service.requestPhoneOtp({ phone: phones[0], purpose: 'sign_in', ipHash: 'resend-ip' });
    await assert.rejects(
      service.requestPhoneOtp({ phone: phones[0], purpose: 'sign_in', ipHash: 'other-ip' }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATE_LIMITED' &&
        error.status === 429 &&
        error.retryable &&
        Number.isInteger(error.retryAfterSeconds) &&
        error.retryAfterSeconds! > 0,
    );

    for (let index = 0; index < 5; index += 1) {
      await service.requestPhoneOtp({
        phone: phones[index + 1],
        purpose: 'sign_in',
        ipHash: 'shared-ip',
      });
    }
    await assert.rejects(
      service.requestPhoneOtp({
        phone: '+919875509999',
        purpose: 'sign_in',
        ipHash: 'shared-ip',
      }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATE_LIMITED' &&
        error.retryable === true &&
        Number.isInteger(error.retryAfterSeconds) &&
        error.retryAfterSeconds! > 0,
    );

    for (let index = 0; index < 4; index += 1) {
      await ownerPool.query(
        `UPDATE otp_challenges SET created_at = now() - interval '61 seconds'
         WHERE destination_hash = $1`,
        [tokenHash('+919875588888')],
      );
      await service.requestPhoneOtp({
        phone: '+919875588888',
        purpose: 'sign_in',
        ipHash: `destination-${index}`,
      });
    }
    await ownerPool.query(
      `UPDATE otp_challenges SET created_at = now() - interval '61 seconds'
       WHERE request_ip_hash LIKE 'destination-%'`,
    );
    await service.requestPhoneOtp({
      phone: '+919875588888',
      purpose: 'sign_in',
      ipHash: 'destination-4',
    });
    await assert.rejects(
      service.requestPhoneOtp({
        phone: '+919875588888',
        purpose: 'sign_in',
        ipHash: 'destination-5',
      }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATE_LIMITED' &&
        error.retryable === true &&
        error.retryAfterSeconds !== undefined &&
        error.retryAfterSeconds > 800,
    );
  } finally {
    await prisma.$disconnect();
    await ownerPool.query(
      `DELETE FROM otp_challenges WHERE request_ip_hash IN
       ('resend-ip', 'other-ip', 'shared-ip', 'destination-0', 'destination-1',
        'destination-2', 'destination-3', 'destination-4', 'destination-5')`,
    );
  }
});

void test('concurrent OTP requests cannot bypass destination or IP limits', async () => {
  const { prisma, service } = createService();
  const destinationIp = `destination-race-${randomUUID()}`;
  const sharedIp = `ip-race-${randomUUID()}`;
  const destinationPhone = '+919875577777';
  try {
    const sameDestination = await Promise.allSettled(
      Array.from({ length: 7 }, (_, index) =>
        service.requestPhoneOtp({
          phone: destinationPhone,
          purpose: 'sign_in',
          ipHash: `${destinationIp}-${index}`,
        }),
      ),
    );
    assert.equal(
      sameDestination.filter(({ status }) => status === 'fulfilled').length,
      1,
    );
    for (const result of sameDestination.filter(
      (candidate): candidate is PromiseRejectedResult => candidate.status === 'rejected',
    )) {
      assert.ok(result.reason instanceof ApplicationError);
      assert.equal(result.reason.code, 'RATE_LIMITED');
      assert.equal(result.reason.retryable, true);
      assert.ok(Number.isInteger(result.reason.retryAfterSeconds));
      assert.ok(result.reason.retryAfterSeconds! > 0);
    }

    const sameIp = await Promise.allSettled(
      Array.from({ length: 7 }, (_, index) =>
        service.requestPhoneOtp({
          phone: `+91987440${String(index).padStart(4, '0')}`,
          purpose: 'sign_in',
          ipHash: sharedIp,
        }),
      ),
    );
    assert.equal(sameIp.filter(({ status }) => status === 'fulfilled').length, 5);
    assert.equal(sameIp.filter(({ status }) => status === 'rejected').length, 2);
    for (const result of sameIp.filter(
      (candidate): candidate is PromiseRejectedResult => candidate.status === 'rejected',
    )) {
      assert.ok(result.reason instanceof ApplicationError);
      assert.equal(result.reason.code, 'RATE_LIMITED');
      assert.ok(Number.isInteger(result.reason.retryAfterSeconds));
      assert.ok(result.reason.retryAfterSeconds! > 0);
    }
  } finally {
    await prisma.$disconnect();
    await ownerPool.query(
      `DELETE FROM otp_challenges
       WHERE request_ip_hash = $1 OR request_ip_hash LIKE $2`,
      [sharedIp, `${destinationIp}-%`],
    );
  }
});

void test('OTP failures commit and lock exactly at five, including concurrent wrong attempts', async () => {
  const fixtures = await Promise.all([
    insertPhoneFixture('+919876500002'),
    insertPhoneFixture('+919876500003'),
  ]);
  const { prisma, delivery, service } = createService();
  try {
    const sequential = await service.requestPhoneOtp({
      phone: fixtures[0].phone,
      purpose: 'sign_in',
    });
    const sequentialCode = delivery.takeLastCodeForTest(fixtures[0].phone);
    assert.ok(sequentialCode);
    const sequentialWrongCode = guaranteedWrongCode(sequentialCode);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await assert.rejects(
        service.verifyPhoneOtp({
          challengeToken: sequential.challengeToken,
          code: sequentialWrongCode,
          deviceId: 'device-sequential',
        }),
        expectAuthenticationFailure,
      );
      const row = await ownerPool.query<{ attempt_count: number }>(
        'SELECT attempt_count FROM otp_challenges WHERE token_hash = $1',
        [tokenHash(sequential.challengeToken)],
      );
      assert.equal(row.rows[0]?.attempt_count, attempt);
    }
    await assert.rejects(
      service.verifyPhoneOtp({
        challengeToken: sequential.challengeToken,
        code: sequentialWrongCode,
        deviceId: 'device-sequential',
      }),
      expectAuthenticationFailure,
    );

    const concurrent = await service.requestPhoneOtp({
      phone: fixtures[1].phone,
      purpose: 'sign_in',
    });
    const concurrentCode = delivery.takeLastCodeForTest(fixtures[1].phone);
    assert.ok(concurrentCode);
    const concurrentWrongCode = guaranteedWrongCode(concurrentCode);
    const results = await Promise.allSettled(
      Array.from({ length: 7 }, () =>
        service.verifyPhoneOtp({
          challengeToken: concurrent.challengeToken,
          code: concurrentWrongCode,
          deviceId: 'device-concurrent',
        }),
      ),
    );
    assert.ok(results.every((result) => result.status === 'rejected'));
    const row = await ownerPool.query<{ attempt_count: number }>(
      'SELECT attempt_count FROM otp_challenges WHERE token_hash = $1',
      [tokenHash(concurrent.challengeToken)],
    );
    assert.equal(row.rows[0]?.attempt_count, 5);
    const lockAudits = await ownerPool.query(
      `SELECT id FROM audit_events
       WHERE actor_user_id = ANY($1::uuid[]) AND action = 'auth.otp_locked'`,
      [fixtures.map((fixture) => fixture.userId)],
    );
    assert.equal(lockAudits.rowCount, 2);
  } finally {
    await prisma.$disconnect();
    await Promise.all(fixtures.map(cleanupFixture));
  }
});

void test('OTP expires and is single-use under concurrent verification', async () => {
  const fixtures = await Promise.all([
    insertPhoneFixture('+919876500004'),
    insertPhoneFixture('+919876500005'),
  ]);
  const { prisma, delivery, service } = createService();
  try {
    const expired = await service.requestPhoneOtp({
      phone: fixtures[0].phone,
      purpose: 'sign_in',
    });
    const expiredCode = delivery.takeLastCodeForTest(fixtures[0].phone)!;
    await ownerPool.query(
      `UPDATE otp_challenges SET expires_at = now() - interval '1 second'
       WHERE token_hash = $1`,
      [tokenHash(expired.challengeToken)],
    );
    await assert.rejects(
      service.verifyPhoneOtp({
        challengeToken: expired.challengeToken,
        code: expiredCode,
        deviceId: 'expired-device',
      }),
      expectAuthenticationFailure,
    );

    const concurrent = await service.requestPhoneOtp({
      phone: fixtures[1].phone,
      purpose: 'sign_in',
    });
    const code = delivery.takeLastCodeForTest(fixtures[1].phone)!;
    const results = await Promise.allSettled([
      service.verifyPhoneOtp({
        challengeToken: concurrent.challengeToken,
        code,
        deviceId: 'same-device',
      }),
      service.verifyPhoneOtp({
        challengeToken: concurrent.challengeToken,
        code,
        deviceId: 'same-device',
      }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const rows = await ownerPool.query(
      'SELECT id FROM sessions WHERE user_id = $1',
      [fixtures[1].userId],
    );
    assert.equal(rows.rowCount, 1);
  } finally {
    await prisma.$disconnect();
    await Promise.all(fixtures.map(cleanupFixture));
  }
});

void test('administrator password authentication is non-disclosing and only issues a password/device-bound pending MFA credential', async () => {
  const email = 'admin-auth@example.test';
  const password = 'correct horse battery staple';
  const secret = 'JBSWY3DPEHPK3PXP';
  const administrator = await insertAdministrator(email, password, secret);
  await ownerPool.query(
    'DELETE FROM administrator_authentication_attempts WHERE account_key = $1',
    [tokenHash('missing@example.test')],
  );
  const { prisma, service } = createService();
  try {
    const failures = await Promise.allSettled([
      service.startAdministratorSignIn({
        email: 'missing@example.test',
        password,
        deviceId: 'admin-device',
      }),
      service.startAdministratorSignIn({
        email,
        password: 'wrong password',
        deviceId: 'admin-device',
      }),
    ]);
    assert.ok(
      failures.every(
        (result) => result.status === 'rejected' && expectAuthenticationFailure(result.reason),
      ),
    );

    const before = Date.now();
    const pending = await service.startAdministratorSignIn({
      email: ' ADMIN-AUTH@EXAMPLE.TEST ',
      password,
      deviceId: 'admin-device',
      deviceName: 'Browser',
    });
    assert.equal(Buffer.from(pending.pendingMfaToken, 'base64url').length, 32);
    assert.ok(pending.expiresAt.getTime() >= before + 299_000);
    assert.ok(pending.expiresAt.getTime() <= before + 301_000);
    assert.equal(
      (await ownerPool.query('SELECT id FROM sessions WHERE user_id = $1', [administrator.userId]))
        .rowCount,
      0,
    );
    const row = await ownerPool.query<{
      token_hash: string;
      user_id: string;
      device_id: string;
      password_credential_changed_at: Date;
      expires_at: Date;
      attempt_count: number;
      consumed_at: Date | null;
    }>(
      `SELECT token_hash, user_id, device_id, password_credential_changed_at,
              expires_at, attempt_count, consumed_at
       FROM pending_mfa_authentications WHERE token_hash = $1`,
      [tokenHash(pending.pendingMfaToken)],
    );
    assert.equal(row.rows[0]?.token_hash, tokenHash(pending.pendingMfaToken));
    assert.equal(row.rows[0]?.user_id, administrator.userId);
    assert.equal(row.rows[0]?.device_id, 'admin-device');
    assert.equal(row.rows[0]?.attempt_count, 0);
    assert.equal(row.rows[0]?.consumed_at, null);
    assert.ok(row.rows[0]?.password_credential_changed_at instanceof Date);
    assert.ok(row.rows[0]?.expires_at instanceof Date);
    assert.doesNotMatch(JSON.stringify(row.rows), new RegExp(pending.pendingMfaToken));
  } finally {
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
  }
});

void test('vendor owners can complete administrator password and MFA sign-in', async () => {
  const email = 'vendor-owner-auth@example.test';
  const password = 'vendor owner password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const administrator = await insertAdministrator(email, password, secret, {
    platformRole: false,
  });
  const vendorId = randomUUID();
  const membershipId = randomUUID();
  const { prisma, service } = createService();
  try {
    await ownerPool.query(
      `INSERT INTO vendors
         (id, code, legal_name, display_name, timezone, currency,
          skip_cutoff_minutes, billing_day, status, updated_at)
       VALUES ($1, $2, 'Vendor Admin', 'Vendor Admin', 'Asia/Kolkata', 'INR',
               0, 1, 'active', now())`,
      [vendorId, `vendor-admin-${vendorId}`],
    );
    await ownerPool.query(
      `INSERT INTO vendor_memberships
         (id, vendor_id, user_id, role, status, joined_at, updated_at)
       VALUES ($1, $2, $3, 'vendor_owner', 'active', now(), now())`,
      [membershipId, vendorId, administrator.userId],
    );
    const pending = await service.startAdministratorSignIn({
      email,
      password,
      deviceId: 'vendor-owner-device',
    });
    const session = await service.verifyAdministratorMfa({
      pendingMfaToken: pending.pendingMfaToken,
      code: totpCode(secret),
      deviceId: 'vendor-owner-device',
    });

    const actor = await service.authenticate(session.accessToken);
    assert.equal(actor.userId, administrator.userId);
    assert.deepEqual(actor.platformRoles, []);
    assert.deepEqual(actor.memberships, [
      {
        id: membershipId,
        vendorId,
        vendorName: 'Vendor Admin',
        role: 'vendor_owner',
        status: 'active',
      },
    ]);
  } finally {
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
    await ownerPool.query('DELETE FROM vendors WHERE id = $1', [vendorId]);
  }
});

void test('vendor administrators sign in during onboarding and trial but not suspension or closure', async () => {
  const password = 'vendor administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const users: string[] = [];
  const vendorIds: string[] = [];
  const { prisma, service } = createService();
  try {
    for (const status of ['onboarding', 'trial', 'suspended', 'closed'] as const) {
      const email = `vendor-${status}@example.test`;
      const administrator = await insertAdministrator(email, password, secret, {
        platformRole: false,
      });
      const vendorId = randomUUID();
      users.push(administrator.userId);
      vendorIds.push(vendorId);
      await ownerPool.query(
        `INSERT INTO vendors
           (id, code, legal_name, display_name, timezone, currency,
            skip_cutoff_minutes, billing_day, status, updated_at)
         VALUES ($1, $2, 'Lifecycle Auth', 'Lifecycle Auth', 'Asia/Kolkata', 'INR',
                 0, 1, $3, now())`,
        [vendorId, `lifecycle-auth-${vendorId}`, status],
      );
      await ownerPool.query(
        `INSERT INTO vendor_memberships
           (id, vendor_id, user_id, role, status, joined_at, updated_at)
         VALUES ($1, $2, $3, 'vendor_administrator', 'active', now(), now())`,
        [randomUUID(), vendorId, administrator.userId],
      );
      const command = { email, password, deviceId: `${status}-device` };
      if (status === 'onboarding' || status === 'trial') {
        const pending = await service.startAdministratorSignIn(command);
        const session = await service.verifyAdministratorMfa({
          pendingMfaToken: pending.pendingMfaToken,
          code: totpCode(secret),
          deviceId: command.deviceId,
        });
        assert.equal(
          (await service.authenticate(session.accessToken)).authenticationMethod,
          'administrator_mfa',
        );
      } else {
        await assert.rejects(
          service.startAdministratorSignIn(command),
          expectAuthenticationFailure,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
    await cleanupUsers(users);
    await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [vendorIds]);
  }
});

void test('an onboarding administrator membership prevents a customer phone session', async () => {
  const fixture = await insertPhoneFixture('+919876500019');
  const administratorVendorId = randomUUID();
  const { prisma, delivery, service } = createService();
  try {
    await ownerPool.query(
      `INSERT INTO vendors
         (id, code, legal_name, display_name, timezone, currency,
          skip_cutoff_minutes, billing_day, status, updated_at)
       VALUES ($1, $2, 'Onboarding Admin', 'Onboarding Admin', 'Asia/Kolkata', 'INR',
               0, 1, 'onboarding', now())`,
      [administratorVendorId, `onboarding-admin-${administratorVendorId}`],
    );
    await ownerPool.query(
      `INSERT INTO vendor_memberships
         (id, vendor_id, user_id, role, status, joined_at, updated_at)
       VALUES ($1, $2, $3, 'vendor_owner', 'active', now(), now())`,
      [randomUUID(), administratorVendorId, fixture.userId],
    );
    const challenge = await service.requestPhoneOtp({ phone: fixture.phone, purpose: 'sign_in' });
    assert.equal(delivery.takeLastCodeForTest(fixture.phone), undefined);
    const challengeRow = await ownerPool.query<{ identity_id: string | null }>(
      'SELECT identity_id FROM otp_challenges WHERE token_hash = $1',
      [tokenHash(challenge.challengeToken)],
    );
    assert.equal(challengeRow.rows[0]?.identity_id, null);
  } finally {
    await prisma.$disconnect();
    await cleanupFixture(fixture);
    await ownerPool.query('DELETE FROM vendors WHERE id = $1', [administratorVendorId]);
  }
});

void test('pending MFA rejects a revoked factor and suspended or deleted administrator', async () => {
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const users: string[] = [];
  const { prisma, service } = createService();
  try {
    for (const state of ['revoked-factor', 'suspended', 'deleted'] as const) {
      const administrator = await insertAdministrator(
        `${state}@example.test`,
        password,
        secret,
      );
      users.push(administrator.userId);
      const pending = await service.startAdministratorSignIn({
        email: `${state}@example.test`,
        password,
        deviceId: `${state}-device`,
      });
      if (state === 'revoked-factor') {
        await ownerPool.query('UPDATE mfa_factors SET revoked_at = now() WHERE id = $1', [
          administrator.factorId,
        ]);
      } else if (state === 'suspended') {
        await ownerPool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [
          administrator.userId,
        ]);
      } else {
        await ownerPool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [
          administrator.userId,
        ]);
      }
      await assert.rejects(
        service.verifyAdministratorMfa({
          pendingMfaToken: pending.pendingMfaToken,
          code: totpCode(secret),
          deviceId: `${state}-device`,
        }),
        expectAuthenticationFailure,
      );
    }
  } finally {
    await prisma.$disconnect();
    await cleanupUsers(users);
  }
});

void test('administrator sessions stop authenticating after suspension or deletion', async () => {
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const users: string[] = [];
  const { prisma, service } = createService();
  try {
    for (const state of ['suspended', 'deleted'] as const) {
      const email = `session-${state}@example.test`;
      const administrator = await insertAdministrator(email, password, secret);
      users.push(administrator.userId);
      const pending = await service.startAdministratorSignIn({
        email,
        password,
        deviceId: `session-${state}-device`,
      });
      const session = await service.verifyAdministratorMfa({
        pendingMfaToken: pending.pendingMfaToken,
        code: totpCode(secret),
        deviceId: `session-${state}-device`,
      });
      const actor = await service.authenticate(session.accessToken);
      assert.equal(actor.authenticationMethod, 'administrator_mfa');
      if (state === 'suspended') {
        await ownerPool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [
          administrator.userId,
        ]);
      } else {
        await ownerPool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [
          administrator.userId,
        ]);
      }
      await assert.rejects(
        service.authenticate(session.accessToken),
        expectAuthenticationFailure,
      );
    }
  } finally {
    await prisma.$disconnect();
    await cleanupUsers(users);
  }
});

void test('an administrator session fails after its last platform authority is revoked', async () => {
  const email = 'revoked-authority@example.test';
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const administrator = await insertAdministrator(email, password, secret);
  const { prisma, service } = createService();
  try {
    const pending = await service.startAdministratorSignIn({
      email,
      password,
      deviceId: 'revoked-authority-device',
    });
    const session = await service.verifyAdministratorMfa({
      pendingMfaToken: pending.pendingMfaToken,
      code: totpCode(secret),
      deviceId: 'revoked-authority-device',
    });
    await ownerPool.query(
      'UPDATE platform_role_assignments SET revoked_at = now() WHERE id = $1',
      [administrator.roleId],
    );

    await assert.rejects(
      service.authenticate(session.accessToken),
      expectAuthenticationFailure,
    );
    await assert.rejects(
      service.refresh(session.refreshToken, 'revoked-authority-device'),
      expectAuthenticationFailure,
    );
    assert.equal(
      (await ownerPool.query('SELECT id FROM sessions WHERE user_id = $1', [administrator.userId]))
        .rowCount,
      1,
    );
  } finally {
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
  }
});

void test('pending MFA rejects expiry, device/password changes and commits sequential and concurrent lockout at five', async () => {
  const users: string[] = [];
  const { prisma, service } = createService();
  const email = (suffix: string) => `mfa-${suffix}@example.test`;
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  try {
    for (const suffix of ['expired', 'device', 'password', 'sequential', 'concurrent']) {
      const administrator = await insertAdministrator(email(suffix), password, secret);
      users.push(administrator.userId);
      const pending = await service.startAdministratorSignIn({
        email: email(suffix),
        password,
        deviceId: `${suffix}-device`,
      });

      if (suffix === 'expired') {
        await ownerPool.query(
          `UPDATE pending_mfa_authentications SET expires_at = now() - interval '1 second'
           WHERE token_hash = $1`,
          [tokenHash(pending.pendingMfaToken)],
        );
        await assert.rejects(
          service.verifyAdministratorMfa({
            pendingMfaToken: pending.pendingMfaToken,
            code: totpCode(secret),
            deviceId: `${suffix}-device`,
          }),
          expectAuthenticationFailure,
        );
      } else if (suffix === 'device') {
        await assert.rejects(
          service.verifyAdministratorMfa({
            pendingMfaToken: pending.pendingMfaToken,
            code: totpCode(secret),
            deviceId: 'another-device',
          }),
          expectAuthenticationFailure,
        );
      } else if (suffix === 'password') {
        await ownerPool.query(
          `UPDATE password_credentials SET changed_at = changed_at + interval '1 second'
           WHERE user_id = $1`,
          [administrator.userId],
        );
        await assert.rejects(
          service.verifyAdministratorMfa({
            pendingMfaToken: pending.pendingMfaToken,
            code: totpCode(secret),
            deviceId: `${suffix}-device`,
          }),
          expectAuthenticationFailure,
        );
      } else if (suffix === 'sequential') {
        const wrongCode = guaranteedWrongTotp(secret);
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          await assert.rejects(
            service.verifyAdministratorMfa({
              pendingMfaToken: pending.pendingMfaToken,
              code: wrongCode,
              deviceId: `${suffix}-device`,
            }),
            expectAuthenticationFailure,
          );
          const row = await ownerPool.query<{ attempt_count: number }>(
            'SELECT attempt_count FROM pending_mfa_authentications WHERE token_hash = $1',
            [tokenHash(pending.pendingMfaToken)],
          );
          assert.equal(row.rows[0]?.attempt_count, attempt);
        }
      } else {
        const wrongCode = guaranteedWrongTotp(secret);
        const results = await Promise.allSettled(
          Array.from({ length: 7 }, () =>
            service.verifyAdministratorMfa({
              pendingMfaToken: pending.pendingMfaToken,
              code: wrongCode,
              deviceId: `${suffix}-device`,
            }),
          ),
        );
        assert.ok(results.every((result) => result.status === 'rejected'));
        const row = await ownerPool.query<{ attempt_count: number }>(
          'SELECT attempt_count FROM pending_mfa_authentications WHERE token_hash = $1',
          [tokenHash(pending.pendingMfaToken)],
        );
        assert.equal(row.rows[0]?.attempt_count, 5);
      }
    }
    const lockAudits = await ownerPool.query(
      `SELECT id FROM audit_events
       WHERE actor_user_id = ANY($1::uuid[]) AND action = 'auth.mfa_locked'`,
      [users],
    );
    assert.equal(lockAudits.rowCount, 2);
  } finally {
    await prisma.$disconnect();
    await cleanupUsers(users);
  }
});

void test('pending MFA is single-use under concurrency and cannot be replayed', async () => {
  const email = 'mfa-race@example.test';
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const administrator = await insertAdministrator(email, password, secret);
  const { prisma, service } = createService();
  try {
    const pending = await service.startAdministratorSignIn({
      email,
      password,
      deviceId: 'mfa-race-device',
    });
    const command = {
      pendingMfaToken: pending.pendingMfaToken,
      code: totpCode(secret),
      deviceId: 'mfa-race-device',
    };
    const results = await Promise.allSettled([
      service.verifyAdministratorMfa(command),
      service.verifyAdministratorMfa(command),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    await assert.rejects(service.verifyAdministratorMfa(command), expectAuthenticationFailure);
    assert.equal(
      (await ownerPool.query('SELECT id FROM sessions WHERE user_id = $1', [administrator.userId]))
        .rowCount,
      1,
    );
  } finally {
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
  }
});

void test('a normal refresh rotates once, preserves assurance, and stores only token hashes', async () => {
  const fixture = await insertPhoneFixture('+919876500016');
  const { prisma, delivery, service } = createService();
  try {
    const predecessor = await requestPhoneSession(
      service,
      delivery,
      fixture.phone,
      'normal-refresh-device',
    );
    const successor = await service.refresh(
      predecessor.refreshToken,
      'normal-refresh-device',
    );

    await assert.rejects(
      service.authenticate(predecessor.accessToken),
      expectAuthenticationFailure,
    );
    const actor = await service.authenticate(successor.accessToken);
    assert.deepEqual(actor, {
      userId: fixture.userId,
      sessionId: actor.sessionId,
      displayName: 'Phone User',
      authenticationMethod: 'phone_otp',
      platformRoles: [],
      memberships: [
        {
          id: fixture.membershipId,
          vendorId: fixture.vendorId,
          vendorName: 'Phone Vendor',
          role: 'customer',
          status: 'active',
        },
      ],
    });
    assert.deepEqual(Object.keys(actor).sort(), [
      'authenticationMethod',
      'displayName',
      'memberships',
      'platformRoles',
      'sessionId',
      'userId',
    ]);
    const rows = await ownerPool.query<{
      access_token_hash: string;
      refresh_token_hash: string;
      predecessor_id: string | null;
      authentication_method: string;
      revoked_at: Date | null;
    }>(
      `SELECT access_token_hash, refresh_token_hash, predecessor_id,
              authentication_method, revoked_at
       FROM sessions WHERE user_id = $1 ORDER BY created_at`,
      [fixture.userId],
    );
    assert.equal(rows.rowCount, 2);
    assert.equal(rows.rows.filter(({ predecessor_id }) => predecessor_id !== null).length, 1);
    assert.ok(
      rows.rows.find(({ predecessor_id }) => predecessor_id === null)?.revoked_at instanceof Date,
    );
    assert.equal(
      rows.rows.find(({ predecessor_id }) => predecessor_id !== null)?.revoked_at,
      null,
    );
    assert.ok(rows.rows.every(({ authentication_method }) => authentication_method === 'phone_otp'));
    assert.ok(rows.rows.every(({ access_token_hash }) => /^[0-9a-f]{64}$/.test(access_token_hash)));
    assert.ok(rows.rows.every(({ refresh_token_hash }) => /^[0-9a-f]{64}$/.test(refresh_token_hash)));
    const stored = JSON.stringify(rows.rows);
    for (const raw of [
      predecessor.accessToken,
      predecessor.refreshToken,
      successor.accessToken,
      successor.refreshToken,
    ]) {
      assert.ok(!stored.includes(raw));
    }
    const rotationAudit = await ownerPool.query(
      `SELECT id FROM audit_events
       WHERE actor_user_id = $1 AND action = 'auth.session_rotated'`,
      [fixture.userId],
    );
    assert.equal(rotationAudit.rowCount, 1);
  } finally {
    await prisma.$disconnect();
    await cleanupFixture(fixture);
  }
});

void test('refresh rotation locks the predecessor, creates one successor, and replay revokes every active user session', async () => {
  const fixture = await insertPhoneFixture('+919876500006');
  const { prisma, delivery, service } = createService();
  try {
    const first = await requestPhoneSession(service, delivery, fixture.phone, 'device-a');
    const other = await requestPhoneSession(service, delivery, fixture.phone, 'device-b');
    await assert.rejects(service.refresh(first.refreshToken, 'wrong-device'), expectAuthenticationFailure);

    const results = await Promise.allSettled([
      service.refresh(first.refreshToken, 'device-a'),
      service.refresh(first.refreshToken, 'device-a'),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const issued = results.find(
      (result): result is PromiseFulfilledResult<SessionTokens> => result.status === 'fulfilled',
    )!.value;
    const sessions = await ownerPool.query<{
      predecessor_id: string | null;
      revoked_at: Date | null;
    }>(
      'SELECT predecessor_id, revoked_at FROM sessions WHERE user_id = $1 ORDER BY created_at',
      [fixture.userId],
    );
    assert.equal(sessions.rows.filter((row) => row.predecessor_id !== null).length, 1);
    assert.ok(sessions.rows.every((row) => row.revoked_at instanceof Date));
    await assert.rejects(service.authenticate(issued.accessToken), expectAuthenticationFailure);
    await assert.rejects(service.authenticate(other.accessToken), expectAuthenticationFailure);
    const replayAudit = await ownerPool.query(
      `SELECT id FROM audit_events
       WHERE actor_user_id = $1 AND action = 'auth.session_replay_detected'`,
      [fixture.userId],
    );
    assert.equal(replayAudit.rowCount, 1);
  } finally {
    await prisma.$disconnect();
    await cleanupFixture(fixture);
  }
});

void test('logout cannot succeed behind an in-flight refresh and leave its successor active', async () => {
  const fixture = await insertPhoneFixture('+919876500023');
  const { prisma, delivery, service } = createService();
  const blocker = await ownerPool.connect();
  const suffix = randomUUID().replaceAll('-', '');
  const trigger = `block_refresh_insert_${suffix}`;
  const triggerFunction = `block_refresh_insert_fn_${suffix}`;
  const lockKey = 7_718_007;
  try {
    const predecessor = await requestPhoneSession(
      service,
      delivery,
      fixture.phone,
      'logout-refresh-race',
    );
    await ownerPool.query(
      `CREATE FUNCTION ${triggerFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.user_id = '${fixture.userId}'::uuid AND NEW.predecessor_id IS NOT NULL THEN
           PERFORM pg_advisory_xact_lock(${lockKey});
         END IF;
         RETURN NEW;
       END $$`,
    );
    await ownerPool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON sessions
       FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()`,
    );
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

    const refresh = service.refresh(predecessor.refreshToken, 'logout-refresh-race');
    await waitForLockWaiters(1);
    const logout = service.logout(predecessor.accessToken);
    await waitForLockWaiters(2);
    await blocker.query('COMMIT');

    const [refreshResult, logoutResult] = await Promise.allSettled([refresh, logout]);
    assert.equal(refreshResult.status, 'fulfilled');
    assert.ok(
      logoutResult.status === 'rejected' && expectAuthenticationFailure(logoutResult.reason),
    );
    assert.equal(
      (
        await ownerPool.query(
          'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
          [fixture.userId],
        )
      ).rowCount,
      1,
    );
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await ownerPool.query(`DROP TRIGGER IF EXISTS ${trigger} ON sessions`);
    await ownerPool.query(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
    await prisma.$disconnect();
    await cleanupFixture(fixture);
  }
});

void test('wrong-device and expired rotated-token replay revoke their successors', async () => {
  const fixtures = await Promise.all([
    insertPhoneFixture('+919876500020'),
    insertPhoneFixture('+919876500021'),
  ]);
  const { prisma, delivery, service } = createService();
  try {
    for (const [index, replayKind] of ['wrong-device', 'expired'].entries()) {
      const fixture = fixtures[index];
      const predecessor = await requestPhoneSession(
        service,
        delivery,
        fixture.phone,
        `${replayKind}-device`,
      );
      const successor = await service.refresh(
        predecessor.refreshToken,
        `${replayKind}-device`,
      );
      if (replayKind === 'expired') {
        await ownerPool.query(
          `UPDATE sessions SET expires_at = now() - interval '1 second'
           WHERE refresh_token_hash = $1`,
          [tokenHash(predecessor.refreshToken)],
        );
      }
      await assert.rejects(
        service.refresh(
          predecessor.refreshToken,
          replayKind === 'wrong-device' ? 'attacker-device' : `${replayKind}-device`,
        ),
        expectAuthenticationFailure,
      );
      await assert.rejects(
        service.authenticate(successor.accessToken),
        expectAuthenticationFailure,
      );
    }
  } finally {
    await prisma.$disconnect();
    await Promise.all(fixtures.map(cleanupFixture));
  }
});

void test('replaying two different predecessors concurrently cannot deadlock', async () => {
  const fixture = await insertPhoneFixture('+919876500022');
  const { prisma, delivery, service } = createService();
  try {
    const first = await requestPhoneSession(service, delivery, fixture.phone, 'replay-a');
    const second = await requestPhoneSession(service, delivery, fixture.phone, 'replay-b');
    await service.refresh(first.refreshToken, 'replay-a');
    await service.refresh(second.refreshToken, 'replay-b');

    const results = await Promise.allSettled([
      service.refresh(first.refreshToken, 'replay-a'),
      service.refresh(second.refreshToken, 'replay-b'),
    ]);
    assert.ok(
      results.every(
        (result) => result.status === 'rejected' && expectAuthenticationFailure(result.reason),
      ),
    );
  } finally {
    await prisma.$disconnect();
    await cleanupFixture(fixture);
  }
});

void test('authenticate, logout, and logout-all enforce user and membership state', async () => {
  const fixtures = await Promise.all([
    insertPhoneFixture('+919876500007'),
    insertPhoneFixture('+919876500008'),
    insertPhoneFixture('+919876500009'),
    insertPhoneFixture('+919876500010'),
    insertPhoneFixture('+919876500017'),
  ]);
  const { prisma, delivery, service } = createService();
  try {
    const current = await requestPhoneSession(service, delivery, fixtures[0].phone, 'logout-one');
    const actor = await service.authenticate(current.accessToken);
    assert.equal(actor.userId, fixtures[0].userId);
    assert.deepEqual(actor.platformRoles, []);
    await service.logout(current.accessToken);
    await assert.rejects(service.authenticate(current.accessToken), expectAuthenticationFailure);

    const allOne = await requestPhoneSession(service, delivery, fixtures[1].phone, 'logout-all-a');
    const allTwo = await requestPhoneSession(service, delivery, fixtures[1].phone, 'logout-all-b');
    await service.logoutAll(allOne.accessToken);
    await assert.rejects(service.authenticate(allOne.accessToken), expectAuthenticationFailure);
    await assert.rejects(service.authenticate(allTwo.accessToken), expectAuthenticationFailure);

    const suspended = await requestPhoneSession(service, delivery, fixtures[2].phone, 'suspended');
    await ownerPool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [fixtures[2].userId]);
    await assert.rejects(service.authenticate(suspended.accessToken), expectAuthenticationFailure);

    const noMembership = await requestPhoneSession(service, delivery, fixtures[3].phone, 'membership');
    await ownerPool.query(
      "UPDATE vendor_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1",
      [fixtures[3].userId],
    );
    await assert.rejects(service.authenticate(noMembership.accessToken), expectAuthenticationFailure);

    const deleted = await requestPhoneSession(service, delivery, fixtures[4].phone, 'deleted');
    await ownerPool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [fixtures[4].userId]);
    await assert.rejects(service.authenticate(deleted.accessToken), expectAuthenticationFailure);
    const revocationAudits = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit_events
       WHERE actor_user_id = ANY($1::uuid[])
         AND action IN ('auth.session_revoked', 'auth.all_sessions_revoked')
       ORDER BY action`,
      [fixtures.map((fixture) => fixture.userId)],
    );
    assert.deepEqual(revocationAudits.rows, [
      { action: 'auth.all_sessions_revoked' },
      { action: 'auth.session_revoked' },
    ]);
  } finally {
    await prisma.$disconnect();
    await Promise.all(fixtures.map(cleanupFixture));
  }
});

void test('administrator password failures lock the account transactionally and audit redacted outcomes', async () => {
  const suffix = randomUUID();
  const email = `password-lock-${suffix}@example.test`;
  const password = 'administrator password';
  const administrator = await insertAdministrator(email, password, 'JBSWY3DPEHPK3PXP');
  const { prisma, service } = createService();
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        service.startAdministratorSignIn({
          email,
          password: 'wrong password',
          deviceId: 'password-lock-device',
          ipHash: `password-lock-ip-${suffix}`,
        }),
      ),
    );
    assert.ok(attempts.every((result) => result.status === 'rejected'));
    await assert.rejects(
      service.startAdministratorSignIn({
        email,
        password,
        deviceId: 'password-lock-device',
        ipHash: `password-lock-retry-ip-${suffix}`,
      }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATE_LIMITED' &&
        error.status === 429 &&
        error.retryable === true &&
        error.retryAfterSeconds !== undefined &&
        error.retryAfterSeconds > 0,
    );

    const credential = await ownerPool.query<{
      failed_attempts: number;
      locked_until: Date | null;
    }>(
      'SELECT failed_attempts, locked_until FROM password_credentials WHERE user_id = $1',
      [administrator.userId],
    );
    assert.equal(credential.rows[0]?.failed_attempts, 5);
    assert.ok(credential.rows[0]?.locked_until instanceof Date);
    const audits = await ownerPool.query<{
      action: string;
      old_value: unknown;
      new_value: unknown;
      reason: string | null;
      ip_hash: string | null;
    }>(
      `SELECT action, old_value, new_value, reason, ip_hash FROM audit_events
       WHERE actor_user_id = $1 AND action LIKE 'auth.password_%'
       ORDER BY created_at, id`,
      [administrator.userId],
    );
    assert.equal(audits.rows.filter(({ action }) => action === 'auth.password_failed').length, 5);
    assert.equal(audits.rows.filter(({ action }) => action === 'auth.password_locked').length, 1);
    assert.ok(
      audits.rows.every(
        ({ old_value, new_value, reason, ip_hash }) =>
          old_value === null &&
          new_value === null &&
          reason === null &&
          ip_hash === `password-lock-ip-${suffix}`,
      ),
    );
  } finally {
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
  }
});

void test('administrator password and pending-MFA issuance share bounded account and IP windows', async () => {
  const suffix = randomUUID();
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const users = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      insertAdministrator(`ip-limit-${index}-${suffix}@example.test`, password, secret),
    ),
  );
  const { prisma, service } = createService();
  try {
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(
        service.startAdministratorSignIn({
          email: `ip-limit-${index}-${suffix}@example.test`,
          password: 'wrong password',
          deviceId: `ip-limit-${index}`,
          ipHash: `shared-password-ip-${suffix}`,
        }),
        expectAuthenticationFailure,
      );
    }
    await assert.rejects(
      service.startAdministratorSignIn({
        email: `ip-limit-5-${suffix}@example.test`,
        password: 'wrong password',
        deviceId: 'ip-limit-5',
        ipHash: `shared-password-ip-${suffix}`,
      }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATE_LIMITED' &&
        error.status === 429 &&
        error.retryable &&
        Number.isInteger(error.retryAfterSeconds) &&
        error.retryAfterSeconds! > 0,
    );

    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(
        service.startAdministratorSignIn({
          email: `missing-${suffix}@example.test`,
          password: 'wrong password',
          deviceId: `missing-${index}`,
          ipHash: `missing-ip-${index}-${suffix}`,
        }),
        expectAuthenticationFailure,
      );
    }
    await assert.rejects(
      service.startAdministratorSignIn({
        email: `missing-${suffix}@example.test`,
        password: 'wrong password',
        deviceId: 'missing-5',
        ipHash: `missing-ip-5-${suffix}`,
      }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATE_LIMITED' &&
        error.status === 429,
    );

    for (let index = 0; index < 5; index += 1) {
      await service.startAdministratorSignIn({
        email: `ip-limit-${index}-${suffix}@example.test`,
        password,
        deviceId: `shared-pending-${index}`,
        ipHash: `shared-pending-ip-${suffix}`,
      });
    }
    await assert.rejects(
      service.startAdministratorSignIn({
        email: `ip-limit-5-${suffix}@example.test`,
        password,
        deviceId: 'shared-pending-5',
        ipHash: `shared-pending-ip-${suffix}`,
      }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATE_LIMITED' &&
        error.status === 429,
    );

    const accountEmail = `pending-limit-${suffix}@example.test`;
    const account = await insertAdministrator(accountEmail, password, secret);
    users.push(account);
    for (let index = 0; index < 5; index += 1) {
      await service.startAdministratorSignIn({
        email: accountEmail,
        password,
        deviceId: `pending-limit-${index}`,
        ipHash: `pending-ip-${index}-${suffix}`,
      });
    }
    await assert.rejects(
      service.startAdministratorSignIn({
        email: accountEmail,
        password,
        deviceId: 'pending-limit-5',
        ipHash: `pending-ip-5-${suffix}`,
      }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATE_LIMITED' &&
        error.retryable === true &&
        error.retryAfterSeconds !== undefined &&
        error.retryAfterSeconds > 0,
    );
  } finally {
    await prisma.$disconnect();
    await cleanupUsers(users.map(({ userId }) => userId));
  }
});

void test('fresh pending MFA tokens cannot reset the five-failure account budget', async () => {
  const suffix = randomUUID();
  const email = `aggregate-mfa-${suffix}@example.test`;
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const administrator = await insertAdministrator(email, password, secret);
  const { prisma, service } = createService();
  try {
    const pending = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.startAdministratorSignIn({
          email,
          password,
          deviceId: `aggregate-mfa-${index}`,
          ipHash: `aggregate-mfa-ip-${suffix}`,
        }),
      ),
    );
    const wrong = guaranteedWrongTotp(secret);
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(
        service.verifyAdministratorMfa({
          pendingMfaToken: pending[index].pendingMfaToken,
          code: wrong,
          deviceId: `aggregate-mfa-${index}`,
          ipHash: `aggregate-mfa-ip-${suffix}`,
        }),
        expectAuthenticationFailure,
      );
    }
    await assert.rejects(
      service.verifyAdministratorMfa({
        pendingMfaToken: pending[0].pendingMfaToken,
        code: totpCode(secret),
        deviceId: 'aggregate-mfa-0',
        ipHash: `aggregate-mfa-ip-${suffix}`,
      }),
      expectAuthenticationFailure,
    );
    const audits = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE actor_user_id = $1
       AND action IN ('auth.mfa_failed', 'auth.mfa_locked', 'auth.mfa_succeeded')`,
      [administrator.userId],
    );
    assert.equal(audits.rows.filter(({ action }) => action === 'auth.mfa_failed').length, 6);
    assert.equal(audits.rows.filter(({ action }) => action === 'auth.mfa_locked').length, 1);
    assert.equal(audits.rows.filter(({ action }) => action === 'auth.mfa_succeeded').length, 0);
  } finally {
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
  }
});

void test('one TOTP counter succeeds once across sequential and concurrent pending tokens', async () => {
  const users: string[] = [];
  const { prisma, service } = createService();
  try {
    for (const mode of ['sequential', 'concurrent'] as const) {
      const suffix = randomUUID();
      const email = `totp-replay-${mode}-${suffix}@example.test`;
      const password = 'administrator password';
      const secret = 'JBSWY3DPEHPK3PXP';
      const administrator = await insertAdministrator(email, password, secret);
      users.push(administrator.userId);
      const first = await service.startAdministratorSignIn({
        email,
        password,
        deviceId: `${mode}-first`,
      });
      const second = await service.startAdministratorSignIn({
        email,
        password,
        deviceId: `${mode}-second`,
      });
      const code = totpCode(secret);
      const commands = [first, second].map((pending, index) => ({
        pendingMfaToken: pending.pendingMfaToken,
        code,
        deviceId: `${mode}-${index === 0 ? 'first' : 'second'}`,
      }));
      const results = mode === 'sequential'
        ? [
            await service.verifyAdministratorMfa(commands[0]).then(
              () => 'fulfilled',
              () => 'rejected',
            ),
            await service.verifyAdministratorMfa(commands[1]).then(
              () => 'fulfilled',
              () => 'rejected',
            ),
          ]
        : (await Promise.allSettled(commands.map((command) =>
            service.verifyAdministratorMfa(command),
          ))).map(({ status }) => status);
      assert.deepEqual(results.sort(), ['fulfilled', 'rejected'].sort());
      const factor = await ownerPool.query<{ last_used_counter: string | null }>(
        'SELECT last_used_counter::text FROM mfa_factors WHERE id = $1',
        [administrator.factorId],
      );
      assert.equal(factor.rows[0]?.last_used_counter, String(Math.floor(Date.now() / 30_000)));
    }
  } finally {
    await prisma.$disconnect();
    await cleanupUsers(users);
  }
});

void test('revoking the active MFA factor atomically revokes and defensively rejects administrator sessions', async () => {
  const suffix = randomUUID();
  const email = `factor-revoke-${suffix}@example.test`;
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const administrator = await insertAdministrator(email, password, secret);
  const { prisma, service } = createService();
  try {
    const pending = await service.startAdministratorSignIn({
      email,
      password,
      deviceId: 'factor-revoke-device',
    });
    const session = await service.verifyAdministratorMfa({
      pendingMfaToken: pending.pendingMfaToken,
      code: totpCode(secret),
      deviceId: 'factor-revoke-device',
    });
    await ownerPool.query('UPDATE mfa_factors SET revoked_at = now() WHERE id = $1', [
      administrator.factorId,
    ]);
    const persisted = await ownerPool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM sessions WHERE user_id = $1',
      [administrator.userId],
    );
    assert.ok(persisted.rows[0]?.revoked_at instanceof Date);
    await assert.rejects(service.authenticate(session.accessToken), expectAuthenticationFailure);
    await assert.rejects(
      service.refresh(session.refreshToken, 'factor-revoke-device'),
      expectAuthenticationFailure,
    );
  } finally {
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
  }
});

void test('administrator throttling returns the latest saturated account or IP release time', async () => {
  const suffix = randomUUID();
  const email = `staggered-limit-${suffix}@example.test`;
  const ipHash = `staggered-limit-ip-${suffix}`;
  const administrator = await insertAdministrator(
    email,
    'administrator password',
    'JBSWY3DPEHPK3PXP',
  );
  const { prisma, service } = createService();
  try {
    await ownerPool.query(
      `INSERT INTO administrator_authentication_attempts
         (id, account_key, ip_hash, stage, succeeded, created_at)
       SELECT gen_random_uuid(), $1, 'other-ip', 'password', false,
              now() - interval '14 minutes'
       FROM generate_series(1, 5)`,
      [tokenHash(email)],
    );
    await ownerPool.query(
      `INSERT INTO administrator_authentication_attempts
         (id, account_key, ip_hash, stage, succeeded, created_at)
       SELECT gen_random_uuid(), $1, $2, 'password', false,
              now() - interval '2 minutes'
       FROM generate_series(1, 5)`,
      [tokenHash(`other-${email}`), ipHash],
    );
    await assert.rejects(
      service.startAdministratorSignIn({
        email,
        password: 'administrator password',
        deviceId: 'staggered-limit-device',
        ipHash,
      }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATE_LIMITED' &&
        error.retryAfterSeconds !== undefined &&
        error.retryAfterSeconds > 700,
    );
  } finally {
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
  }
});

void test('replayed valid TOTP counters consume the aggregate failure budget and lock the account', async () => {
  const suffix = randomUUID();
  const email = `totp-budget-${suffix}@example.test`;
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const administrator = await insertAdministrator(email, password, secret);
  const { prisma, service } = createService();
  try {
    const pending = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.startAdministratorSignIn({
          email,
          password,
          deviceId: `totp-budget-${index}`,
        }),
      ),
    );
    await ownerPool.query(
      `UPDATE administrator_authentication_attempts
       SET created_at = now() - interval '16 minutes'
       WHERE account_key = $1`,
      [tokenHash(email)],
    );
    pending.push(await service.startAdministratorSignIn({
      email,
      password,
      deviceId: 'totp-budget-5',
    }));
    const code = totpCode(secret);
    await service.verifyAdministratorMfa({
      pendingMfaToken: pending[0].pendingMfaToken,
      code,
      deviceId: 'totp-budget-0',
    });
    for (let index = 1; index < pending.length; index += 1) {
      await assert.rejects(
        service.verifyAdministratorMfa({
          pendingMfaToken: pending[index].pendingMfaToken,
          code,
          deviceId: `totp-budget-${index}`,
        }),
        expectAuthenticationFailure,
      );
    }
    const attempts = await ownerPool.query<{ total: string }>(
      `SELECT sum(attempt_count)::text AS total
       FROM pending_mfa_authentications WHERE user_id = $1`,
      [administrator.userId],
    );
    assert.deepEqual(attempts.rows, [{ total: '5' }]);
    const credential = await ownerPool.query<{ locked_until: Date | null }>(
      'SELECT locked_until FROM password_credentials WHERE user_id = $1',
      [administrator.userId],
    );
    assert.ok(credential.rows[0]?.locked_until instanceof Date);
    assert.equal(
      (await ownerPool.query(
        `SELECT id FROM audit_events WHERE actor_user_id = $1
         AND action = 'auth.mfa_locked'`,
        [administrator.userId],
      )).rowCount,
      1,
    );
  } finally {
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
  }
});

void test('administrator authenticate and refresh reject a revoked factor under session data drift', async () => {
  const suffix = randomUUID();
  const email = `factor-drift-${suffix}@example.test`;
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const administrator = await insertAdministrator(email, password, secret);
  const { prisma, service } = createService();
  try {
    const pending = await service.startAdministratorSignIn({
      email,
      password,
      deviceId: 'factor-drift-device',
    });
    const session = await service.verifyAdministratorMfa({
      pendingMfaToken: pending.pendingMfaToken,
      code: totpCode(secret),
      deviceId: 'factor-drift-device',
    });
    await ownerPool.query('UPDATE mfa_factors SET revoked_at = now() WHERE id = $1', [
      administrator.factorId,
    ]);
    // Simulate a privileged/manual repair that accidentally reactivates a session after revocation.
    await ownerPool.query('UPDATE sessions SET revoked_at = NULL WHERE user_id = $1', [
      administrator.userId,
    ]);
    await assert.rejects(service.authenticate(session.accessToken), expectAuthenticationFailure);
    await assert.rejects(
      service.refresh(session.refreshToken, 'factor-drift-device'),
      expectAuthenticationFailure,
    );
  } finally {
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
  }
});

void test('factor revocation and refresh serialize without leaving an active administrator session', async () => {
  const suffix = randomUUID();
  const email = `factor-refresh-race-${suffix}@example.test`;
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const administrator = await insertAdministrator(email, password, secret);
  const { prisma, service } = createService();
  const blocker = await ownerPool.connect();
  try {
    const pending = await service.startAdministratorSignIn({
      email,
      password,
      deviceId: 'factor-refresh-race-device',
    });
    const session = await service.verifyAdministratorMfa({
      pendingMfaToken: pending.pendingMfaToken,
      code: totpCode(secret),
      deviceId: 'factor-refresh-race-device',
    });
    await blocker.query('BEGIN');
    await blocker.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`session-user:${administrator.userId}`],
    );
    const refresh = service.refresh(session.refreshToken, 'factor-refresh-race-device');
    const revoke = ownerPool.query('UPDATE mfa_factors SET revoked_at = now() WHERE id = $1', [
      administrator.factorId,
    ]);
    await waitForLockWaiters(2);
    await blocker.query('COMMIT');
    const [refreshResult, revokeResult] = await Promise.allSettled([refresh, revoke]);
    assert.equal(revokeResult.status, 'fulfilled');
    if (refreshResult.status === 'fulfilled') {
      await assert.rejects(
        service.authenticate(refreshResult.value.accessToken),
        expectAuthenticationFailure,
      );
    }
    assert.equal(
      (await ownerPool.query(
        'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
        [administrator.userId],
      )).rowCount,
      0,
    );
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
  }
});

void test('factor revocation wins against in-flight MFA verification without deadlock', async () => {
  const suffix = randomUUID();
  const email = `factor-verify-race-${suffix}@example.test`;
  const password = 'administrator password';
  const secret = 'JBSWY3DPEHPK3PXP';
  const administrator = await insertAdministrator(email, password, secret);
  const { prisma, service } = createService();
  const blocker = await ownerPool.connect();
  let verification: Promise<SessionTokens> | undefined;
  try {
    const pending = await service.startAdministratorSignIn({
      email,
      password,
      deviceId: 'factor-verify-race-device',
    });
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM mfa_factors WHERE id = $1 FOR UPDATE', [
      administrator.factorId,
    ]);
    verification = service.verifyAdministratorMfa({
      pendingMfaToken: pending.pendingMfaToken,
      code: totpCode(secret),
      deviceId: 'factor-verify-race-device',
    });
    void verification.catch(() => undefined);
    await waitForLockWaiters(1);
    await blocker.query('UPDATE mfa_factors SET revoked_at = now() WHERE id = $1', [
      administrator.factorId,
    ]);
    await blocker.query('COMMIT');
    await assert.rejects(verification, expectAuthenticationFailure);
    assert.equal(
      (await ownerPool.query(
        'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
        [administrator.userId],
      )).rowCount,
      0,
    );
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await verification?.catch(() => undefined);
    await prisma.$disconnect();
    await cleanupUsers([administrator.userId]);
  }
});
