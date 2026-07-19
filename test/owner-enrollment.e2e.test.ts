import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { INestApplication } from '@nestjs/common';
import pg from 'pg';

import { LocalOwnerEnrollmentDelivery } from '../src/memberships/infrastructure/local-owner-enrollment.delivery.js';

const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});
const hmacKey = Buffer.from('0123456789abcdef0123456789abcdef');

type Seed = { vendorIds: string[]; userIds: string[] };

function tokenHash(token: string): string {
  return createHmac('sha256', hmacKey).update(token).digest('hex');
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

async function insertUser(seed: Seed, displayName: string): Promise<string> {
  const id = randomUUID();
  seed.userIds.push(id);
  await ownerPool.query(
    'INSERT INTO users (id, display_name, updated_at) VALUES ($1, $2, now())',
    [id, displayName],
  );
  return id;
}

async function platformAdministrator(seed: Seed): Promise<{
  id: string;
  token: string;
}> {
  const id = await insertUser(seed, 'Enrollment Platform Administrator');
  await ownerPool.query(
    `INSERT INTO platform_role_assignments (id, user_id, role, granted_by)
     VALUES ($1, $2, 'platform_administrator', $2)`,
    [randomUUID(), id],
  );
  // Administrator sessions must retain an active MFA factor after auth hardening.
  await ownerPool.query(
    `INSERT INTO mfa_factors (id, user_id, type, encrypted_secret, enabled_at)
     VALUES ($1, $2, 'totp', 'owner-enrollment-admin-fixture', now())`,
    [randomUUID(), id],
  );
  const token = randomUUID();
  await ownerPool.query(
    `INSERT INTO sessions
       (id, user_id, access_token_hash, refresh_token_hash,
        authentication_method, device_id, access_expires_at, expires_at,
        last_seen_at)
     VALUES ($1, $2, $3, $4, 'administrator_mfa', 'owner-enrollment-admin',
             now() + interval '1 hour', now() + interval '1 day', now())`,
    [randomUUID(), id, tokenHash(token), tokenHash(randomUUID())],
  );
  return { id, token };
}

async function platformProductOwner(seed: Seed): Promise<{
  id: string;
  token: string;
}> {
  const id = await insertUser(seed, 'Enrollment Product Owner');
  await ownerPool.query(
    `INSERT INTO platform_role_assignments (id, user_id, role, granted_by)
     VALUES ($1, $2, 'product_owner', $2)`,
    [randomUUID(), id],
  );
  await ownerPool.query(
    `INSERT INTO mfa_factors (id, user_id, type, encrypted_secret, enabled_at)
     VALUES ($1, $2, 'totp', 'owner-enrollment-product-owner-fixture', now())`,
    [randomUUID(), id],
  );
  const token = randomUUID();
  await ownerPool.query(
    `INSERT INTO sessions
       (id, user_id, access_token_hash, refresh_token_hash,
        authentication_method, device_id, access_expires_at, expires_at,
        last_seen_at)
     VALUES ($1, $2, $3, $4, 'administrator_mfa', 'owner-enrollment-product-owner',
             now() + interval '1 hour', now() + interval '1 day', now())`,
    [randomUUID(), id, tokenHash(token), tokenHash(randomUUID())],
  );
  return { id, token };
}

async function vendorAdministrator(seed: Seed, vendorId: string): Promise<string> {
  const userId = await insertUser(seed, 'Enrollment Vendor Administrator');
  await ownerPool.query(
    `INSERT INTO vendor_memberships
       (id, vendor_id, user_id, role, status, joined_at, updated_at)
     VALUES ($1, $2, $3, 'vendor_administrator', 'active', now(), now())`,
    [randomUUID(), vendorId, userId],
  );
  await ownerPool.query(
    `INSERT INTO mfa_factors (id, user_id, type, encrypted_secret, enabled_at)
     VALUES ($1, $2, 'totp', 'owner-enrollment-vendor-admin-fixture', now())`,
    [randomUUID(), userId],
  );
  const token = randomUUID();
  await ownerPool.query(
    `INSERT INTO sessions
       (id, user_id, access_token_hash, refresh_token_hash,
        authentication_method, device_id, access_expires_at, expires_at,
        last_seen_at)
     VALUES ($1, $2, $3, $4, 'administrator_mfa', 'owner-enrollment-vendor-admin',
             now() + interval '1 hour', now() + interval '1 day', now())`,
    [randomUUID(), userId, tokenHash(token), tokenHash(randomUUID())],
  );
  return token;
}

async function insertVendor(
  seed: Seed,
  status: 'pending_approval' | 'onboarding' | 'suspended' = 'onboarding',
): Promise<string> {
  const id = randomUUID();
  seed.vendorIds.push(id);
  await ownerPool.query(
    `INSERT INTO vendors
       (id, code, legal_name, display_name, status, timezone, currency,
        skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'Enrollment Vendor', 'Enrollment Vendor', $3::"VendorStatus",
             'Asia/Kolkata', 'INR', 0, 1, now())`,
    [id, `enrollment-${id}`, status],
  );
  return id;
}

async function cleanup(seed: Seed): Promise<void> {
  await ownerPool.query(
    `DELETE FROM audit_events
     WHERE actor_user_id = ANY($1::uuid[])
        OR vendor_id = ANY($2::uuid[])
        OR entity_id = ANY($1::uuid[])`,
    [seed.userIds, seed.vendorIds],
  );
  await ownerPool.query(
    'DELETE FROM owner_enrollments WHERE vendor_id = ANY($1::uuid[])',
    [seed.vendorIds],
  );
  await ownerPool.query(
    'DELETE FROM vendor_memberships WHERE vendor_id = ANY($1::uuid[])',
    [seed.vendorIds],
  );
  for (const table of [
    'pending_mfa_authentications',
    'sessions',
    'mfa_factors',
    'password_credentials',
    'user_identities',
    'platform_role_assignments',
  ]) {
    await ownerPool.query(`DELETE FROM ${table} WHERE user_id = ANY($1::uuid[])`, [
      seed.userIds,
    ]);
  }
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    seed.userIds,
  ]);
  await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [
    seed.vendorIds,
  ]);
}

function request(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function waitForAdvisoryLockWait(
  holderPid: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await ownerPool.query<{ pid: number }>(
      `SELECT waiter.pid
       FROM pg_locks held
       JOIN pg_locks waiter
         ON waiter.locktype = held.locktype
        AND waiter.database IS NOT DISTINCT FROM held.database
        AND waiter.classid IS NOT DISTINCT FROM held.classid
        AND waiter.objid IS NOT DISTINCT FROM held.objid
        AND waiter.objsubid IS NOT DISTINCT FROM held.objsubid
       JOIN pg_stat_activity activity ON activity.pid = waiter.pid
       WHERE held.pid = $1 AND held.locktype = 'advisory' AND held.granted
         AND NOT waiter.granted AND activity.wait_event_type = 'Lock'
         AND activity.wait_event = 'advisory'
       LIMIT 1`,
      [holderPid],
    );
    if (waiting.rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('setup start never waited on the held session-user advisory lock');
}

void describe('vendor owner enrollment', () => {
  let app: INestApplication;
  let baseUrl: string;
  let delivery: LocalOwnerEnrollmentDelivery;

  before(async () => {
    const { createApp } = await import('../src/bootstrap/create-app.js');
    app = await createApp({ logger: false });
    await app.listen(0, '127.0.0.1');
    const address = (app.getHttpServer() as Server).address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
    delivery = app.get(LocalOwnerEnrollmentDelivery);
  });

  after(async () => {
    await app?.close();
    await ownerPool.end();
  });

  void it('lets the invited owner establish password and TOTP before actual administrator sign-in', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administrator = await platformAdministrator(seed);
    const vendorId = await insertVendor(seed);
    const email = `owner-${randomUUID()}@example.com`;
    const password = 'Owner-selected safe password 42!';

    try {
      const invited = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/initial`,
        {
          email,
          displayName: 'Invited Vendor Owner',
          reason: 'Invite the initial vendor owner',
        },
        administrator.token,
      );
      const invitation = (await invited.json()) as {
        vendorId: string;
        userId: string;
        membershipId: string;
        expiresAt: string;
      };
      assert.equal(invited.status, 201, JSON.stringify(invitation));
      seed.userIds.push(invitation.userId);
      assert.equal(invitation.vendorId, vendorId);
      assert.ok(new Date(invitation.expiresAt).getTime() > Date.now());
      assert.doesNotMatch(
        JSON.stringify(invitation),
        /token|password|secret/i,
      );

      const beforeSetup = await ownerPool.query<{
        status: string;
        verified_at: Date | null;
        credentials: string;
        factors: string;
      }>(
        `SELECT vm.status, ui.verified_at,
                count(DISTINCT pc.user_id)::text AS credentials,
                count(DISTINCT mf.id)::text AS factors
         FROM vendor_memberships vm
         JOIN user_identities ui ON ui.user_id = vm.user_id AND ui.type = 'email'
         LEFT JOIN password_credentials pc ON pc.user_id = vm.user_id
         LEFT JOIN mfa_factors mf ON mf.user_id = vm.user_id AND mf.revoked_at IS NULL
         WHERE vm.id = $1 GROUP BY vm.status, ui.verified_at`,
        [invitation.membershipId],
      );
      assert.deepEqual(beforeSetup.rows, [{
        status: 'invited',
        verified_at: null,
        credentials: '0',
        factors: '0',
      }]);

      const setupToken = delivery.takeLastTokenForTest(email);
      assert.ok(setupToken);
      const started = await request(baseUrl, '/v1/auth/owner-enrollment/start', {
        setupToken,
        password,
      });
      const setup = (await started.json()) as {
        completionToken: string;
        totpSecret: string;
      };
      assert.equal(started.status, 200, JSON.stringify(setup));
      assert.match(setup.totpSecret, /^[A-Z2-7]+$/);
      const setupReplays = await Promise.all([
        request(baseUrl, '/v1/auth/owner-enrollment/start', {
          setupToken,
          password: 'Replay must not replace the first password 42!',
        }),
        request(baseUrl, '/v1/auth/owner-enrollment/start', {
          setupToken,
          password: 'Concurrent replay must also be rejected 42!',
        }),
      ]);
      assert.deepEqual(setupReplays.map(({ status }) => status), [401, 401]);

      const completed = await request(
        baseUrl,
        '/v1/auth/owner-enrollment/complete',
        {
          completionToken: setup.completionToken,
          code: totpCode(setup.totpSecret),
        },
      );
      const completion = (await completed.json()) as {
        vendorId: string;
        userId: string;
        membershipId: string;
      };
      assert.equal(completed.status, 200, JSON.stringify(completion));
      assert.deepEqual(completion, {
        vendorId,
        userId: invitation.userId,
        membershipId: invitation.membershipId,
      });

      const passwordStep = await request(baseUrl, '/v1/auth/admin/password', {
        email,
        password,
        deviceId: 'new-owner-device',
      });
      const pending = (await passwordStep.json()) as { pendingMfaToken: string };
      assert.equal(passwordStep.status, 200, JSON.stringify(pending));
      const mfaStep = await request(baseUrl, '/v1/auth/admin/mfa', {
        pendingMfaToken: pending.pendingMfaToken,
        code: totpCode(setup.totpSecret),
        clientType: 'mobile',
        deviceId: 'new-owner-device',
      });
      const session = (await mfaStep.json()) as { accessToken: string };
      assert.equal(mfaStep.status, 200, JSON.stringify(session));
      const ownerMemberships = await fetch(
        `${baseUrl}/v1/vendors/${vendorId}/memberships`,
        { headers: { authorization: `Bearer ${session.accessToken}` } },
      );
      assert.equal(
        ownerMemberships.status,
        200,
        await ownerMemberships.text(),
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/v1/vendors/${vendorId}/memberships`, {
            headers: { authorization: `Bearer ${administrator.token}` },
          })
        ).status,
        403,
      );

      const replay = await request(baseUrl, '/v1/auth/owner-enrollment/complete', {
        completionToken: setup.completionToken,
        code: totpCode(setup.totpSecret),
      });
      assert.equal(replay.status, 401);
    } finally {
      await cleanup(seed);
    }
  });

  void it('rejects expired setup tokens without activating the membership', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administrator = await platformAdministrator(seed);
    const vendorId = await insertVendor(seed);
    const email = `expired-${randomUUID()}@example.com`;

    try {
      const response = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/initial`,
        { email, displayName: 'Expired Owner', reason: 'Expiry regression' },
        administrator.token,
      );
      const body = (await response.json()) as { userId: string; membershipId: string };
      assert.equal(response.status, 201, JSON.stringify(body));
      seed.userIds.push(body.userId);
      const token = delivery.takeLastTokenForTest(email);
      assert.ok(token);
      await ownerPool.query(
        `UPDATE owner_enrollments SET expires_at = now() - interval '1 second'
         WHERE membership_id = $1`,
        [body.membershipId],
      );
      const start = await request(baseUrl, '/v1/auth/owner-enrollment/start', {
        setupToken: token,
        password: 'Expired setup password 42!',
      });
      assert.equal(start.status, 401);
      const membership = await ownerPool.query<{ status: string }>(
        'SELECT status FROM vendor_memberships WHERE id = $1',
        [body.membershipId],
      );
      assert.deepEqual(membership.rows, [{ status: 'invited' }]);

      const reissued = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/initial`,
        {
          email,
          displayName: 'Reissued Owner',
          reason: 'Replace the expired owner invitation',
        },
        administrator.token,
      );
      const reissuedBody = (await reissued.json()) as { userId: string };
      assert.equal(reissued.status, 201, JSON.stringify(reissuedBody));
      assert.equal(reissuedBody.userId, body.userId);
      const retired = await ownerPool.query<{
        membership_status: string;
        retired: boolean;
      }>(
        `SELECT vm.status AS membership_status, oe.retired_at IS NOT NULL AS retired
         FROM owner_enrollments oe
         JOIN vendor_memberships vm ON vm.id = oe.membership_id
         WHERE oe.membership_id = $1`,
        [body.membershipId],
      );
      assert.deepEqual(retired.rows, [{ membership_status: 'ended', retired: true }]);
    } finally {
      await cleanup(seed);
    }
  });

  void it('rejects reuse of an existing unverified email identity', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administrator = await platformAdministrator(seed);
    const vendorId = await insertVendor(seed);
    const userId = await insertUser(seed, 'Unverified Existing User');
    const email = `unverified-${randomUUID()}@example.com`;
    await ownerPool.query(
      `INSERT INTO user_identities
         (id, user_id, type, normalized_value, is_primary, updated_at)
       VALUES ($1, $2, 'email', $3, true, now())`,
      [randomUUID(), userId, email],
    );

    try {
      const response = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/initial`,
        { email, displayName: 'Unverified Owner', reason: 'Reuse regression' },
        administrator.token,
      );
      const body = (await response.json()) as { code: string };
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.code, 'OWNER_USER_UNAVAILABLE');
      const records = await ownerPool.query<{ memberships: string; setups: string }>(
        `SELECT
           (SELECT count(*)::text FROM vendor_memberships
            WHERE vendor_id = $1 AND user_id = $2) AS memberships,
           (SELECT count(*)::text FROM owner_enrollments
            WHERE vendor_id = $1 AND user_id = $2) AS setups`,
        [vendorId, userId],
      );
      assert.deepEqual(records.rows, [{ memberships: '0', setups: '0' }]);
    } finally {
      await cleanup(seed);
    }
  });

  void it('excludes pending-approval vendors from owner onboarding', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administrator = await platformAdministrator(seed);
    const vendorId = await insertVendor(seed, 'pending_approval');

    try {
      const response = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/initial`,
        {
          email: `pending-${randomUUID()}@example.com`,
          displayName: 'Pending Vendor Owner',
          reason: 'Pending state regression',
        },
        administrator.token,
      );
      const body = (await response.json()) as { code: string };
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.code, 'VENDOR_OWNER_ONBOARDING_UNAVAILABLE');
      const records = await ownerPool.query<{ memberships: string; setups: string }>(
        `SELECT
           (SELECT count(*)::text FROM vendor_memberships
            WHERE vendor_id = $1) AS memberships,
           (SELECT count(*)::text FROM owner_enrollments
            WHERE vendor_id = $1) AS setups`,
        [vendorId],
      );
      assert.deepEqual(records.rows, [{ memberships: '0', setups: '0' }]);
    } finally {
      await cleanup(seed);
    }
  });

  void it('consumes a setup token exactly once under concurrent completion', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administrator = await platformAdministrator(seed);
    const vendorId = await insertVendor(seed, 'suspended');
    const email = `concurrent-${randomUUID()}@example.com`;

    try {
      const response = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/initial`,
        { email, displayName: 'Recovery Owner', reason: 'Recover suspended vendor' },
        administrator.token,
      );
      const body = (await response.json()) as { userId: string; membershipId: string };
      assert.equal(response.status, 201, JSON.stringify(body));
      seed.userIds.push(body.userId);
      const token = delivery.takeLastTokenForTest(email);
      assert.ok(token);
      const started = await request(baseUrl, '/v1/auth/owner-enrollment/start', {
        setupToken: token,
        password: 'Concurrent setup password 42!',
      });
      const setup = (await started.json()) as {
        completionToken: string;
        totpSecret: string;
      };
      assert.equal(started.status, 200, JSON.stringify(setup));
      const responses = await Promise.all([
        request(baseUrl, '/v1/auth/owner-enrollment/complete', {
          completionToken: setup.completionToken,
          code: totpCode(setup.totpSecret),
        }),
        request(baseUrl, '/v1/auth/owner-enrollment/complete', {
          completionToken: setup.completionToken,
          code: totpCode(setup.totpSecret),
        }),
      ]);
      assert.deepEqual(
        responses.map(({ status }) => status).sort(),
        [200, 401],
      );
      const state = await ownerPool.query<{
        status: string;
        consumed: string;
        factors: string;
        audits: string;
      }>(
        `SELECT vm.status,
                count(DISTINCT oe.id) FILTER (WHERE oe.consumed_at IS NOT NULL)::text AS consumed,
                count(DISTINCT mf.id)::text AS factors,
                count(DISTINCT ae.id)::text AS audits
         FROM vendor_memberships vm
         JOIN owner_enrollments oe ON oe.membership_id = vm.id
         LEFT JOIN mfa_factors mf ON mf.user_id = vm.user_id AND mf.revoked_at IS NULL
         LEFT JOIN audit_events ae ON ae.entity_id = vm.id
           AND ae.action = 'vendor.owner_enrollment_completed'
         WHERE vm.id = $1 GROUP BY vm.status`,
        [body.membershipId],
      );
      assert.deepEqual(state.rows, [{
        status: 'active',
        consumed: '1',
        factors: '1',
        audits: '1',
      }]);
    } finally {
      await cleanup(seed);
    }
  });

  void it('rotates a failed delivery token through the audited MFA-protected retry operation', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administrator = await platformAdministrator(seed);
    const vendorId = await insertVendor(seed);
    const email = `retry-${randomUUID()}@example.com`;
    try {
      const response = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/initial`,
        { email, displayName: 'Retry Owner', reason: 'Create retry fixture' },
        administrator.token,
      );
      const invitation = (await response.json()) as {
        enrollmentId: string;
        membershipId: string;
        userId: string;
      };
      assert.equal(response.status, 201, JSON.stringify(invitation));
      seed.userIds.push(invitation.userId);
      const oldToken = delivery.takeLastTokenForTest(email);
      assert.ok(oldToken);
      await ownerPool.query(
        "UPDATE owner_enrollments SET delivery_state = 'failed' WHERE id = $1",
        [invitation.enrollmentId],
      );

      const retry = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/enrollments/${invitation.enrollmentId}/retry`,
        { reason: 'Rotate failed delivery token' },
        administrator.token,
      );
      const retried = (await retry.json()) as {
        enrollmentId: string;
        membershipId: string;
        expiresAt: string;
        deliveryStatus: string;
      };
      assert.equal(retry.status, 200, JSON.stringify(retried));
      assert.deepEqual(retried, {
        enrollmentId: invitation.enrollmentId,
        membershipId: invitation.membershipId,
        expiresAt: retried.expiresAt,
        deliveryStatus: 'delivered',
      });
      const newToken = delivery.takeLastTokenForTest(email);
      assert.ok(newToken);
      assert.notEqual(newToken, oldToken);
      assert.equal(
        (await request(baseUrl, '/v1/auth/owner-enrollment/start', {
          setupToken: oldToken,
          password: 'Old rotated token password 42!',
        })).status,
        401,
      );
      const started = await request(baseUrl, '/v1/auth/owner-enrollment/start', {
        setupToken: newToken,
        password: 'New rotated token password 42!',
      });
      const setup = (await started.json()) as {
        completionToken: string;
        totpSecret: string;
      };
      assert.equal(started.status, 200, JSON.stringify(setup));
      const completed = await request(
        baseUrl,
        '/v1/auth/owner-enrollment/complete',
        {
          completionToken: setup.completionToken,
          code: totpCode(setup.totpSecret),
        },
      );
      assert.equal(completed.status, 200, await completed.text());
      const audit = await ownerPool.query<{ count: string }>(
        `SELECT count(*) FROM audit_events
         WHERE entity_id = $1
           AND action = 'vendor.owner_enrollment_delivery_rotated'`,
        [invitation.membershipId],
      );
      assert.equal(audit.rows[0]?.count, '1');
    } finally {
      await cleanup(seed);
    }
  });

  void it('denies retry and setup after vendor or intended-user eligibility is lost', async () => {
    const cases = [
      {
        label: 'closed vendor',
        mutate: (...[vendorId]: [string, string]) => ownerPool.query(
          "UPDATE vendors SET status = 'closed' WHERE id = $1",
          [vendorId],
        ),
      },
      {
        label: 'deleted vendor',
        mutate: (...[vendorId]: [string, string]) => ownerPool.query(
          'UPDATE vendors SET deleted_at = now() WHERE id = $1',
          [vendorId],
        ),
      },
      {
        label: 'deactivated user',
        mutate: (...[, userId]: [string, string]) => ownerPool.query(
          "UPDATE users SET status = 'deactivated', deactivated_at = now() WHERE id = $1",
          [userId],
        ),
      },
      {
        label: 'deleted user',
        mutate: (...[, userId]: [string, string]) => ownerPool.query(
          'UPDATE users SET deleted_at = now() WHERE id = $1',
          [userId],
        ),
      },
    ] as const;

    for (const testCase of cases) {
      const seed: Seed = { vendorIds: [], userIds: [] };
      const administrator = await platformAdministrator(seed);
      const vendorId = await insertVendor(seed);
      const email = `ineligible-${randomUUID()}@example.com`;
      try {
        const response = await request(
          baseUrl,
          `/v1/platform/vendors/${vendorId}/owners/initial`,
          {
            email,
            displayName: 'Eligibility Owner',
            reason: `Create ${testCase.label} fixture`,
          },
          administrator.token,
        );
        const invitation = (await response.json()) as {
          enrollmentId: string;
          membershipId: string;
          userId: string;
        };
        assert.equal(response.status, 201, JSON.stringify(invitation));
        seed.userIds.push(invitation.userId);
        const setupToken = delivery.takeLastTokenForTest(email);
        assert.ok(setupToken);
        await testCase.mutate(vendorId, invitation.userId);

        const retry = await request(
          baseUrl,
          `/v1/platform/vendors/${vendorId}/owners/enrollments/${invitation.enrollmentId}/retry`,
          { reason: `Retry must reject ${testCase.label}` },
          administrator.token,
        );
        const retryBody = (await retry.json()) as { code: string };
        assert.equal(retry.status, 409, JSON.stringify(retryBody));
        assert.equal(retryBody.code, 'OWNER_ENROLLMENT_RETRY_UNAVAILABLE');
        assert.equal(delivery.takeLastTokenForTest(email), undefined);

        const start = await request(baseUrl, '/v1/auth/owner-enrollment/start', {
          setupToken,
          password: 'Eligibility must be rechecked 42!',
        });
        assert.equal(start.status, 401, `${testCase.label}: ${await start.text()}`);
        const state = await ownerPool.query<{
          setup_token_hash: string;
          started_at: Date | null;
          completion_token_hash: string | null;
          password_hash: string | null;
          encrypted_mfa_secret: string | null;
        }>(
          `SELECT setup_token_hash, started_at, completion_token_hash,
                  password_hash, encrypted_mfa_secret
           FROM owner_enrollments WHERE id = $1`,
          [invitation.enrollmentId],
        );
        assert.deepEqual(state.rows, [{
          setup_token_hash: tokenHash(setupToken),
          started_at: null,
          completion_token_hash: null,
          password_hash: null,
          encrypted_mfa_secret: null,
        }]);
      } finally {
        await cleanup(seed);
      }
    }
  });

  void it('serializes setup start behind user deactivation before persisting setup material', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administrator = await platformAdministrator(seed);
    const vendorId = await insertVendor(seed);
    const email = `start-race-${randomUUID()}@example.com`;
    const lifecycle = await ownerPool.connect();
    let transactionOpen = false;
    try {
      const invited = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/initial`,
        {
          email,
          displayName: 'Start Race Owner',
          reason: 'Setup start lifecycle race regression',
        },
        administrator.token,
      );
      const invitation = (await invited.json()) as {
        userId: string;
        membershipId: string;
      };
      assert.equal(invited.status, 201, JSON.stringify(invitation));
      seed.userIds.push(invitation.userId);
      const setupToken = delivery.takeLastTokenForTest(email);
      assert.ok(setupToken);

      await lifecycle.query('BEGIN');
      transactionOpen = true;
      await lifecycle.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`session-user:${invitation.userId}`],
      );
      const holder = await lifecycle.query<{ pid: number }>(
        'SELECT pg_backend_pid()::int AS pid',
      );
      assert.ok(holder.rows[0]);
      const pendingStart = request(baseUrl, '/v1/auth/owner-enrollment/start', {
        setupToken,
        password: 'Start race password 42!',
      });
      await waitForAdvisoryLockWait(holder.rows[0].pid);

      await lifecycle.query(
        `UPDATE users
         SET status = 'deactivated', deactivated_at = now(), updated_at = now()
         WHERE id = $1`,
        [invitation.userId],
      );
      await lifecycle.query('COMMIT');
      transactionOpen = false;

      const started = await pendingStart;
      assert.equal(started.status, 401, await started.text());
      const state = await ownerPool.query<{
        completion_token_hash: string | null;
        password_hash: string | null;
        password_salt: string | null;
        password_parameters: object | null;
        encrypted_mfa_secret: string | null;
        started_at: Date | null;
        started_audits: string;
      }>(
        `SELECT oe.completion_token_hash, oe.password_hash, oe.password_salt,
                oe.password_parameters,
                oe.encrypted_mfa_secret, oe.started_at,
                count(ae.id) FILTER (
                  WHERE ae.action = 'vendor.owner_enrollment_started'
                )::text AS started_audits
         FROM owner_enrollments oe
         LEFT JOIN audit_events ae ON ae.entity_id = oe.membership_id
         WHERE oe.membership_id = $1
         GROUP BY oe.id`,
        [invitation.membershipId],
      );
      assert.deepEqual(state.rows, [{
        completion_token_hash: null,
        password_hash: null,
        password_salt: null,
        password_parameters: null,
        encrypted_mfa_secret: null,
        started_at: null,
        started_audits: '0',
      }]);
    } finally {
      if (transactionOpen) await lifecycle.query('ROLLBACK');
      lifecycle.release();
      await cleanup(seed);
    }
  });

  void it('locks enrollment after five invalid TOTP attempts with redacted tenant audits', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administrator = await platformAdministrator(seed);
    const vendorId = await insertVendor(seed);
    const email = `locked-${randomUUID()}@example.com`;
    try {
      const response = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/initial`,
        { email, displayName: 'Locked Owner', reason: 'Attempt bound regression' },
        administrator.token,
      );
      const invitation = (await response.json()) as { userId: string; membershipId: string };
      assert.equal(response.status, 201, JSON.stringify(invitation));
      seed.userIds.push(invitation.userId);
      const setupToken = delivery.takeLastTokenForTest(email);
      assert.ok(setupToken);
      const started = await request(baseUrl, '/v1/auth/owner-enrollment/start', {
        setupToken,
        password: 'Bounded attempt password 42!',
      });
      const setup = (await started.json()) as {
        completionToken: string;
        totpSecret: string;
      };
      assert.equal(started.status, 200, JSON.stringify(setup));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failure = await request(
          baseUrl,
          '/v1/auth/owner-enrollment/complete',
          {
            completionToken: setup.completionToken,
            code: totpCode(setup.totpSecret, Date.now() + 5 * 60_000),
          },
        );
        assert.equal(failure.status, 401);
      }
      const locked = await request(baseUrl, '/v1/auth/owner-enrollment/complete', {
        completionToken: setup.completionToken,
        code: totpCode(setup.totpSecret),
      });
      assert.equal(locked.status, 401);
      const state = await ownerPool.query<{
        attempt_count: number;
        locked: boolean;
        started: string;
        failures: string;
        locks: string;
      }>(
        `SELECT oe.attempt_count, oe.locked_at IS NOT NULL AS locked,
                count(ae.id) FILTER (WHERE ae.action = 'vendor.owner_enrollment_started')::text AS started,
                count(ae.id) FILTER (WHERE ae.action = 'vendor.owner_enrollment_totp_failed')::text AS failures,
                count(ae.id) FILTER (WHERE ae.action = 'vendor.owner_enrollment_locked')::text AS locks
         FROM owner_enrollments oe
         LEFT JOIN audit_events ae ON ae.entity_id = oe.membership_id
         WHERE oe.membership_id = $1
         GROUP BY oe.attempt_count, oe.locked_at`,
        [invitation.membershipId],
      );
      assert.deepEqual(state.rows, [{
        attempt_count: 5,
        locked: true,
        started: '1',
        failures: '4',
        locks: '1',
      }]);
    } finally {
      await cleanup(seed);
    }
  });

  void it('serializes enrollment completion against user deactivation without orphaning the vendor', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administrator = await platformAdministrator(seed);
    const vendorId = await insertVendor(seed);
    const email = `race-${randomUUID()}@example.com`;
    try {
      const response = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/initial`,
        { email, displayName: 'Race Owner', reason: 'Cross-path race regression' },
        administrator.token,
      );
      const invitation = (await response.json()) as { userId: string; membershipId: string };
      assert.equal(response.status, 201, JSON.stringify(invitation));
      seed.userIds.push(invitation.userId);
      const setupToken = delivery.takeLastTokenForTest(email);
      assert.ok(setupToken);
      const started = await request(baseUrl, '/v1/auth/owner-enrollment/start', {
        setupToken,
        password: 'Cross path race password 42!',
      });
      const setup = (await started.json()) as {
        completionToken: string;
        totpSecret: string;
      };
      assert.equal(started.status, 200, JSON.stringify(setup));

      const [completion, deactivation] = await Promise.all([
        request(baseUrl, '/v1/auth/owner-enrollment/complete', {
          completionToken: setup.completionToken,
          code: totpCode(setup.totpSecret),
        }),
        request(
          baseUrl,
          `/v1/platform/users/${invitation.userId}/deactivate`,
          { reason: 'Race owner deactivation' },
          administrator.token,
        ),
      ]);
      assert.ok(
        (completion.status === 200 && deactivation.status === 409) ||
        (completion.status === 401 && deactivation.status === 200),
        `unexpected race statuses: ${completion.status}/${deactivation.status}`,
      );
      const state = await ownerPool.query<{
        user_status: string;
        membership_status: string;
        effective_owners: string;
      }>(
        `SELECT u.status AS user_status, vm.status AS membership_status,
                (SELECT count(*)::text FROM vendor_memberships owners
                 JOIN users owner_users ON owner_users.id = owners.user_id
                 WHERE owners.vendor_id = $1 AND owners.role = 'vendor_owner'
                   AND owners.status = 'active' AND owners.ended_at IS NULL
                   AND owners.deleted_at IS NULL AND owner_users.status = 'active'
                   AND owner_users.deleted_at IS NULL) AS effective_owners
         FROM vendor_memberships vm JOIN users u ON u.id = vm.user_id
         WHERE vm.id = $2`,
        [vendorId, invitation.membershipId],
      );
      assert.ok(
        (state.rows[0]?.user_status === 'active' &&
          state.rows[0]?.membership_status === 'active' &&
          state.rows[0]?.effective_owners === '1') ||
        (state.rows[0]?.user_status === 'deactivated' &&
          state.rows[0]?.membership_status === 'invited' &&
          state.rows[0]?.effective_owners === '0'),
      );
    } finally {
      await cleanup(seed);
    }
  });

  void it('returns a safe initial-owner onboarding status only to MFA-authenticated platform readers', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administrator = await platformAdministrator(seed);
    const productOwner = await platformProductOwner(seed);
    const vendorId = await insertVendor(seed);
    const vendorToken = await vendorAdministrator(seed, vendorId);
    const email = `status-${randomUUID()}@example.com`;
    try {
      const notStarted = await fetch(
        `${baseUrl}/v1/platform/vendors/${vendorId}/owners/initial`,
        { headers: { authorization: `Bearer ${administrator.token}` } },
      );
      assert.deepEqual(await notStarted.json(), { vendorId, state: 'not_started' });

      const invited = await request(
        baseUrl,
        `/v1/platform/vendors/${vendorId}/owners/initial`,
        { email, displayName: 'Status Owner', reason: 'Status projection regression' },
        administrator.token,
      );
      const invitation = (await invited.json()) as {
        userId: string;
        membershipId: string;
        enrollmentId: string;
      };
      assert.equal(invited.status, 201, JSON.stringify(invitation));
      seed.userIds.push(invitation.userId);

      const administratorStatus = await fetch(
        `${baseUrl}/v1/platform/vendors/${vendorId}/owners/initial`,
        { headers: { authorization: `Bearer ${administrator.token}` } },
      );
      const administratorBody = await administratorStatus.json() as Record<string, unknown>;
      assert.equal(administratorStatus.status, 200, JSON.stringify(administratorBody));
      assert.deepEqual(administratorBody, {
        vendorId,
        state: 'invited',
        enrollmentId: invitation.enrollmentId,
        membershipId: invitation.membershipId,
        ownerDisplayName: 'Status Owner',
        ownerEmail: email,
        expiresAt: administratorBody.expiresAt,
      });
      assert.ok(typeof administratorBody.expiresAt === 'string');
      assert.doesNotMatch(
        JSON.stringify(administratorBody),
        /hash|token|password|mfa|provider/i,
      );

      const productOwnerStatus = await fetch(
        `${baseUrl}/v1/platform/vendors/${vendorId}/owners/initial`,
        { headers: { authorization: `Bearer ${productOwner.token}` } },
      );
      const productOwnerBody = await productOwnerStatus.json() as Record<string, unknown>;
      assert.equal(productOwnerStatus.status, 200, JSON.stringify(productOwnerBody));
      assert.equal(productOwnerBody.ownerDisplayName, 'Status Owner');
      assert.equal('ownerEmail' in productOwnerBody, false);
      assert.doesNotMatch(JSON.stringify(productOwnerBody), /hash|token|password|mfa|provider/i);

      const denied = await fetch(
        `${baseUrl}/v1/platform/vendors/${vendorId}/owners/initial`,
        { headers: { authorization: `Bearer ${vendorToken}` } },
      );
      assert.equal(denied.status, 403);
      const missing = await fetch(
        `${baseUrl}/v1/platform/vendors/${randomUUID()}/owners/initial`,
        { headers: { authorization: `Bearer ${administrator.token}` } },
      );
      assert.equal(missing.status, 404);
    } finally {
      await cleanup(seed);
    }
  });
});
