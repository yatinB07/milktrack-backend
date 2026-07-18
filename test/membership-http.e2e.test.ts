import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { INestApplication } from '@nestjs/common';
import pg from 'pg';

import { MembershipService } from '../src/memberships/application/membership.service.js';
import {
  type Actor,
  requestContextStore,
} from '../src/common/context/request-context.js';

const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});
const hmacKey = Buffer.from('0123456789abcdef0123456789abcdef');

type Seed = {
  vendorIds: string[];
  userIds: string[];
};

function tokenHash(token: string): string {
  return createHmac('sha256', hmacKey).update(token).digest('hex');
}

async function insertUser(seed: Seed, displayName = 'Membership User'): Promise<string> {
  const id = randomUUID();
  seed.userIds.push(id);
  await ownerPool.query(
    `INSERT INTO users (id, display_name, updated_at) VALUES ($1, $2, now())`,
    [id, displayName],
  );
  return id;
}

async function insertVendor(seed: Seed): Promise<string> {
  const id = randomUUID();
  seed.vendorIds.push(id);
  await ownerPool.query(
    `INSERT INTO vendors
       (id, code, legal_name, display_name, status, timezone, currency,
        skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'Membership Vendor', 'Membership Vendor', 'active',
             'Asia/Kolkata', 'INR', 0, 1, now())`,
    [id, `membership-${id}`],
  );
  return id;
}

async function insertMembership(input: Readonly<{
  vendorId: string;
  userId: string;
  role: string;
  status?: string;
  deleted?: boolean;
  createdAt?: string;
}>): Promise<string> {
  const id = randomUUID();
  const status = input.status ?? 'active';
  await ownerPool.query(
    `INSERT INTO vendor_memberships
       (id, vendor_id, user_id, role, status, joined_at, ended_at,
        deleted_at, deleted_by, deletion_reason, created_at, updated_at)
     VALUES ($1, $2, $3, $4::"MembershipRole", $5::"MembershipStatus", now(),
             CASE WHEN $5::text = 'ended' THEN now() ELSE NULL END,
             CASE WHEN $6 THEN now() ELSE NULL END,
             CASE WHEN $6 THEN $3::uuid ELSE NULL END,
             CASE WHEN $6 THEN 'Seeded deletion' ELSE NULL END,
             COALESCE($7::timestamptz, now()), now())`,
    [
      id,
      input.vendorId,
      input.userId,
      input.role,
      status,
      input.deleted ?? false,
      input.createdAt ?? null,
    ],
  );
  return id;
}

async function issueSession(userId: string): Promise<string> {
  const token = randomUUID();
  await ownerPool.query(
    `INSERT INTO mfa_factors (id, user_id, type, encrypted_secret, enabled_at)
     VALUES ($1, $2, 'totp', 'membership-http-fixture', now())`,
    [randomUUID(), userId],
  );
  await ownerPool.query(
    `INSERT INTO sessions
       (id, user_id, access_token_hash, refresh_token_hash,
        authentication_method, device_id, access_expires_at, expires_at,
        last_seen_at)
     VALUES ($1, $2, $3, $4, 'administrator_mfa', 'membership-test-device',
             now() + interval '1 hour', now() + interval '1 day', now())`,
    [randomUUID(), userId, tokenHash(token), tokenHash(randomUUID())],
  );
  return token;
}

async function insertSession(
  client: pg.PoolClient,
  userId: string,
  authenticationMethod: 'phone_otp' | 'administrator_mfa' = 'administrator_mfa',
): Promise<string> {
  const token = randomUUID();
  if (authenticationMethod === 'administrator_mfa') {
    await client.query(
      `INSERT INTO mfa_factors (id, user_id, type, encrypted_secret, enabled_at)
       VALUES ($1, $2, 'totp', 'membership-concurrency-fixture', now())`,
      [randomUUID(), userId],
    );
  }
  await client.query(
    `INSERT INTO sessions
       (id, user_id, access_token_hash, refresh_token_hash,
        authentication_method, device_id, access_expires_at, expires_at,
        last_seen_at)
     VALUES ($1, $2, $3, $4, $5::"AuthenticationMethod", 'concurrency-device',
             now() + interval '1 hour', now() + interval '1 day', now())`,
    [randomUUID(), userId, tokenHash(token), tokenHash(randomUUID()), authenticationMethod],
  );
  return token;
}

function actor(userId: string, roles: Actor['platformRoles'] = []): Actor {
  return {
    userId,
    sessionId: randomUUID(),
    displayName: 'Task 10 direct actor',
    authenticationMethod: 'administrator_mfa',
    platformRoles: roles,
    memberships: [],
  };
}

async function grantPlatformAdministrator(userId: string): Promise<void> {
  await ownerPool.query(
    `INSERT INTO platform_role_assignments
       (id, user_id, role, granted_by)
     VALUES ($1, $2, 'platform_administrator', $2)`,
    [randomUUID(), userId],
  );
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
    'DELETE FROM vendor_memberships WHERE vendor_id = ANY($1::uuid[])',
    [seed.vendorIds],
  );
  await ownerPool.query(
    'DELETE FROM support_access_grants WHERE vendor_id = ANY($1::uuid[])',
    [seed.vendorIds],
  );
  await ownerPool.query(
    'DELETE FROM platform_role_assignments WHERE user_id = ANY($1::uuid[])',
    [seed.userIds],
  );
  await ownerPool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [
    seed.userIds,
  ]);
  await ownerPool.query('DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])', [
    seed.userIds,
  ]);
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    seed.userIds,
  ]);
  await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [
    seed.vendorIds,
  ]);
}

function request(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
}

void describe('membership and user lifecycle HTTP API', () => {
  let app: INestApplication;
  let baseUrl: string;

  before(async () => {
    const { createApp } = await import('../src/bootstrap/create-app.js');
    app = await createApp({ logger: false });
    await app.listen(0, '127.0.0.1');
    const address = (app.getHttpServer() as Server).address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app?.close();
    await ownerPool.end();
  });

  void it('lists active memberships with bounded cursor pagination and tenant-safe IDs', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const actorId = await insertUser(seed, 'Vendor Owner');
    const otherUserId = await insertUser(seed);
    const vendorIds = [await insertVendor(seed), await insertVendor(seed)];
    await insertMembership({ vendorId: vendorIds[0], userId: actorId, role: 'vendor_owner' });
    await insertMembership({ vendorId: vendorIds[0], userId: otherUserId, role: 'customer' });
    await insertMembership({
      vendorId: vendorIds[0],
      userId: otherUserId,
      role: 'delivery_agent',
      status: 'ended',
    });
    await insertMembership({
      vendorId: vendorIds[0],
      userId: otherUserId,
      role: 'vendor_administrator',
      deleted: true,
    });
    const otherVendorMembershipId = await insertMembership({
      vendorId: vendorIds[1],
      userId: otherUserId,
      role: 'customer',
    });
    const token = await issueSession(actorId);

    try {
      const first = await request(
        baseUrl,
        token,
        `/v1/vendors/${vendorIds[0]}/memberships?limit=1`,
      );
      const firstJson = await first.json();
      assert.equal(first.status, 200, JSON.stringify(firstJson));
      const firstBody = firstJson as {
        items: Array<{ id: string; status: string }>;
        nextCursor?: string;
      };
      assert.equal(firstBody.items.length, 1);
      assert.ok(firstBody.nextCursor);

      const second = await request(
        baseUrl,
        token,
        `/v1/vendors/${vendorIds[0]}/memberships?limit=25&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      );
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as {
        items: Array<{ id: string; status: string }>;
      };
      assert.equal(secondBody.items.length, 1);
      assert.notEqual(secondBody.items[0]?.id, firstBody.items[0]?.id);
      assert.ok([...firstBody.items, ...secondBody.items].every(({ status }) => status === 'active'));

      const crossTenant = await request(
        baseUrl,
        token,
        `/v1/vendors/${vendorIds[0]}/memberships/${otherVendorMembershipId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ role: 'delivery_agent' }),
        },
      );
      assert.equal(crossTenant.status, 404);
      assert.equal(((await crossTenant.json()) as { code: string }).code, 'MEMBERSHIP_NOT_FOUND');
    } finally {
      await cleanup(seed);
    }
  });

  void it('does not skip memberships created within the same millisecond', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const actorId = await insertUser(seed, 'Vendor Owner');
    const userIds = [await insertUser(seed), await insertUser(seed)];
    const vendorId = await insertVendor(seed);
    await insertMembership({
      vendorId,
      userId: actorId,
      role: 'vendor_owner',
      createdAt: '2099-07-18T12:00:00.000400Z',
    });
    await insertMembership({
      vendorId,
      userId: userIds[0],
      role: 'customer',
      createdAt: '2099-07-18T12:00:00.000100Z',
    });
    await insertMembership({
      vendorId,
      userId: userIds[1],
      role: 'delivery_agent',
      createdAt: '2099-07-18T12:00:00.000000Z',
    });
    const token = await issueSession(actorId);

    try {
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await request(
          baseUrl,
          token,
          `/v1/vendors/${vendorId}/memberships?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        const body = (await response.json()) as {
          items: Array<{ id: string }>;
          nextCursor?: string;
        };
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.items.length, 1);
        const [item] = body.items;
        assert(item);
        seen.add(item.id);
        cursor = body.nextCursor;
      } while (cursor);

      assert.equal(seen.size, 3);
    } finally {
      await cleanup(seed);
    }
  });

  void it('creates, changes, ends, deletes, and restores memberships with owner and audit rules', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const ownerId = await insertUser(seed, 'Vendor Owner');
    const administratorId = await insertUser(seed, 'Vendor Administrator');
    const targetId = await insertUser(seed, 'Target User');
    const vendorId = await insertVendor(seed);
    const ownerMembershipId = await insertMembership({
      vendorId,
      userId: ownerId,
      role: 'vendor_owner',
    });
    await insertMembership({
      vendorId,
      userId: administratorId,
      role: 'vendor_administrator',
    });
    const ownerToken = await issueSession(ownerId);
    const administratorToken = await issueSession(administratorId);

    try {
      const denialCorrelationId = randomUUID();
      const forbiddenOwnerGrant = await request(
        baseUrl,
        administratorToken,
        `/v1/vendors/${vendorId}/memberships`,
        {
          method: 'POST',
          headers: { 'x-correlation-id': denialCorrelationId },
          body: JSON.stringify({ userId: targetId, role: 'vendor_owner' }),
        },
      );
      assert.equal(forbiddenOwnerGrant.status, 403);
      assert.equal(
        ((await forbiddenOwnerGrant.json()) as { code: string }).code,
        'FORBIDDEN',
      );
      const denialAudit = await ownerPool.query<{ action: string; reason: string }>(
        `SELECT action, reason FROM audit_events WHERE correlation_id = $1`,
        [denialCorrelationId],
      );
      assert.deepEqual(denialAudit.rows, [
        { action: 'security.tenant_access_denied', reason: 'FORBIDDEN' },
      ]);

      const created = await request(
        baseUrl,
        ownerToken,
        `/v1/vendors/${vendorId}/memberships`,
        {
          method: 'POST',
          body: JSON.stringify({ userId: targetId, role: 'customer' }),
        },
      );
      assert.equal(created.status, 201);
      const createdBody = (await created.json()) as {
        id: string;
        status: string;
        joinedAt?: string;
      };
      assert.equal(createdBody.status, 'active');
      assert.ok(createdBody.joinedAt);

      const duplicate = await request(
        baseUrl,
        ownerToken,
        `/v1/vendors/${vendorId}/memberships`,
        {
          method: 'POST',
          body: JSON.stringify({ userId: targetId, role: 'customer' }),
        },
      );
      assert.equal(duplicate.status, 409);
      assert.equal(((await duplicate.json()) as { code: string }).code, 'MEMBERSHIP_CONFLICT');

      const updated = await request(
        baseUrl,
        ownerToken,
        `/v1/vendors/${vendorId}/memberships/${createdBody.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ role: 'delivery_agent' }),
        },
      );
      assert.equal(updated.status, 200);
      assert.equal(((await updated.json()) as { role: string }).role, 'delivery_agent');

      const ended = await request(
        baseUrl,
        ownerToken,
        `/v1/vendors/${vendorId}/memberships/${createdBody.id}/end`,
        { method: 'POST', body: JSON.stringify({ reason: 'Role no longer required' }) },
      );
      assert.equal(ended.status, 200);
      assert.equal(((await ended.json()) as { status: string }).status, 'ended');

      const restoredCandidate = await request(
        baseUrl,
        ownerToken,
        `/v1/vendors/${vendorId}/memberships`,
        {
          method: 'POST',
          body: JSON.stringify({ userId: targetId, role: 'customer' }),
        },
      );
      assert.equal(restoredCandidate.status, 201);
      const restoredCandidateId = ((await restoredCandidate.json()) as { id: string }).id;

      const invalidDelete = await request(
        baseUrl,
        ownerToken,
        `/v1/vendors/${vendorId}/memberships/${restoredCandidateId}`,
        { method: 'DELETE', body: JSON.stringify({ reason: 'x' }) },
      );
      assert.equal(invalidDelete.status, 400);

      const deleted = await request(
        baseUrl,
        ownerToken,
        `/v1/vendors/${vendorId}/memberships/${restoredCandidateId}`,
        { method: 'DELETE', body: JSON.stringify({ reason: 'Duplicate customer record' }) },
      );
      assert.equal(deleted.status, 204);
      const deletion = await ownerPool.query<{
        deleted_at: Date | null;
        deleted_by: string | null;
        deletion_reason: string | null;
      }>(
        `SELECT deleted_at, deleted_by, deletion_reason
         FROM vendor_memberships WHERE id = $1`,
        [restoredCandidateId],
      );
      assert.ok(deletion.rows[0]?.deleted_at);
      assert.equal(deletion.rows[0]?.deleted_by, ownerId);
      assert.equal(deletion.rows[0]?.deletion_reason, 'Duplicate customer record');

      const restored = await request(
        baseUrl,
        ownerToken,
        `/v1/vendors/${vendorId}/memberships/${restoredCandidateId}/restore`,
        { method: 'POST', body: JSON.stringify({ reason: 'Deletion was incorrect' }) },
      );
      assert.equal(restored.status, 200);
      const restoredFields = await ownerPool.query<{
        deleted_at: Date | null;
        deleted_by: string | null;
        deletion_reason: string | null;
      }>(
        `SELECT deleted_at, deleted_by, deletion_reason
         FROM vendor_memberships WHERE id = $1`,
        [restoredCandidateId],
      );
      assert.deepEqual(restoredFields.rows, [
        { deleted_at: null, deleted_by: null, deletion_reason: null },
      ]);

      const lastOwner = await request(
        baseUrl,
        ownerToken,
        `/v1/vendors/${vendorId}/memberships/${ownerMembershipId}/end`,
        { method: 'POST', body: JSON.stringify({ reason: 'Attempt last owner removal' }) },
      );
      assert.equal(lastOwner.status, 409);
      assert.equal(((await lastOwner.json()) as { code: string }).code, 'LAST_VENDOR_OWNER');

      const audit = await ownerPool.query<{ action: string }>(
        `SELECT action FROM audit_events
         WHERE vendor_id = $1 AND entity_id = $2
         ORDER BY created_at`,
        [vendorId, restoredCandidateId],
      );
      assert.deepEqual(
        audit.rows.map(({ action }) => action),
        ['membership.created', 'membership.deleted', 'membership.restored'],
      );
      const sessions = await ownerPool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM sessions WHERE user_id = ANY($1::uuid[])',
        [[ownerId, administratorId]],
      );
      assert.ok(sessions.rows.every(({ revoked_at }) => revoked_at === null));
    } finally {
      await cleanup(seed);
    }
  });

  void it('soft-deletes and restores a global user without reviving sessions or memberships', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administratorId = await insertUser(seed, 'Platform Administrator');
    const targetId = await insertUser(seed, 'Delete Target');
    const vendorOwnerId = await insertUser(seed, 'Vendor Owner');
    await grantPlatformAdministrator(administratorId);
    const vendorId = await insertVendor(seed);
    await insertMembership({ vendorId, userId: vendorOwnerId, role: 'vendor_owner' });
    const targetMembershipId = await insertMembership({
      vendorId,
      userId: targetId,
      role: 'customer',
    });
    const administratorToken = await issueSession(administratorId);
    const targetToken = await issueSession(targetId);
    const vendorOwnerToken = await issueSession(vendorOwnerId);

    try {
      const vendorDenied = await request(
        baseUrl,
        vendorOwnerToken,
        `/v1/platform/users/${targetId}`,
        { method: 'DELETE', body: JSON.stringify({ reason: 'Not authorized globally' }) },
      );
      assert.equal(vendorDenied.status, 403);

      const selfDelete = await request(
        baseUrl,
        administratorToken,
        `/v1/platform/users/${administratorId}`,
        { method: 'DELETE', body: JSON.stringify({ reason: 'Unsafe self delete' }) },
      );
      assert.equal(selfDelete.status, 409);
      assert.equal(((await selfDelete.json()) as { code: string }).code, 'SELF_DELETE_FORBIDDEN');

      const deleted = await request(
        baseUrl,
        administratorToken,
        `/v1/platform/users/${targetId}`,
        { method: 'DELETE', body: JSON.stringify({ reason: 'Confirmed user deletion' }) },
      );
      assert.equal(deleted.status, 204);
      const user = await ownerPool.query<{
        status: string;
        deleted_at: Date | null;
        deleted_by: string | null;
        deletion_reason: string | null;
      }>(
        `SELECT status, deleted_at, deleted_by, deletion_reason
         FROM users WHERE id = $1`,
        [targetId],
      );
      assert.equal(user.rows[0]?.status, 'active');
      assert.ok(user.rows[0]?.deleted_at);
      assert.equal(user.rows[0]?.deleted_by, administratorId);
      assert.equal(user.rows[0]?.deletion_reason, 'Confirmed user deletion');

      const rejectedSession = await request(
        baseUrl,
        targetToken,
        `/v1/vendors/${vendorId}/memberships`,
      );
      assert.equal(rejectedSession.status, 401);

      const restored = await request(
        baseUrl,
        administratorToken,
        `/v1/platform/users/${targetId}/restore`,
        { method: 'POST', body: JSON.stringify({ reason: 'Deletion was reversed' }) },
      );
      assert.equal(restored.status, 200);
      assert.equal(((await restored.json()) as { status: string }).status, 'active');

      const postRestore = await ownerPool.query<{
        deleted_at: Date | null;
        revoked_at: Date | null;
        membership_id: string;
      }>(
        `SELECT u.deleted_at, s.revoked_at, vm.id AS membership_id
         FROM users u
         JOIN sessions s ON s.user_id = u.id
         JOIN vendor_memberships vm ON vm.user_id = u.id
         WHERE u.id = $1`,
        [targetId],
      );
      assert.deepEqual(postRestore.rows, [
        { deleted_at: null, revoked_at: postRestore.rows[0]?.revoked_at, membership_id: targetMembershipId },
      ]);
      assert.ok(postRestore.rows[0]?.revoked_at);

      const stillRejected = await request(
        baseUrl,
        targetToken,
        `/v1/vendors/${vendorId}/memberships`,
      );
      assert.equal(stillRejected.status, 401);
      const audit = await ownerPool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY created_at`,
        [targetId],
      );
      assert.deepEqual(
        audit.rows.map(({ action }) => action),
        ['user.deleted', 'user.restored'],
      );
    } finally {
      await cleanup(seed);
    }
  });

  void it('preserves suspended and deactivated user state across delete and restore', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administratorId = await insertUser(seed, 'State Administrator');
    await grantPlatformAdministrator(administratorId);
    const administratorToken = await issueSession(administratorId);

    try {
      for (const status of ['suspended', 'deactivated'] as const) {
        const targetId = await insertUser(seed, `${status} lifecycle target`);
        const deactivatedAt =
          status === 'deactivated' ? new Date('2026-07-01T02:03:04.000Z') : null;
        await ownerPool.query(
          `UPDATE users SET status = $2::"UserStatus", deactivated_at = $3 WHERE id = $1`,
          [targetId, status, deactivatedAt],
        );

        const deleted = await request(
          baseUrl,
          administratorToken,
          `/v1/platform/users/${targetId}`,
          { method: 'DELETE', body: JSON.stringify({ reason: `Delete ${status} user` }) },
        );
        assert.equal(deleted.status, 204);
        const afterDelete = await ownerPool.query<{
          status: string;
          deactivated_at: Date | null;
          deleted_at: Date | null;
        }>(
          'SELECT status, deactivated_at, deleted_at FROM users WHERE id = $1',
          [targetId],
        );
        assert.equal(afterDelete.rows[0]?.status, status);
        assert.deepEqual(afterDelete.rows[0]?.deactivated_at, deactivatedAt);
        assert.ok(afterDelete.rows[0]?.deleted_at);

        const restored = await request(
          baseUrl,
          administratorToken,
          `/v1/platform/users/${targetId}/restore`,
          { method: 'POST', body: JSON.stringify({ reason: `Restore ${status} user` }) },
        );
        assert.equal(restored.status, 200);
        assert.equal(((await restored.json()) as { status: string }).status, status);
        const afterRestore = await ownerPool.query<{
          status: string;
          deactivated_at: Date | null;
          deleted_at: Date | null;
        }>(
          'SELECT status, deactivated_at, deleted_at FROM users WHERE id = $1',
          [targetId],
        );
        assert.deepEqual(afterRestore.rows, [
          { status, deactivated_at: deactivatedAt, deleted_at: null },
        ]);
      }
    } finally {
      await cleanup(seed);
    }
  });

  void it('fails closed when an owner-only denial cannot be audited', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administratorId = await insertUser(seed, 'Vendor Administrator');
    const targetId = await insertUser(seed);
    const vendorId = await insertVendor(seed);
    await insertMembership({
      vendorId,
      userId: administratorId,
      role: 'vendor_administrator',
    });
    const memberships = app.get(MembershipService);

    try {
      await assert.rejects(
        requestContextStore.run(
          { correlationId: 'invalid-correlation-id', actor: actor(administratorId) },
          () =>
            memberships.create(actor(administratorId), vendorId, {
              userId: targetId,
              role: 'vendor_owner',
            }),
        ),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'SECURITY_AUDIT_UNAVAILABLE',
      );
      const created = await ownerPool.query<{ count: string }>(
        `SELECT count(*) FROM vendor_memberships
         WHERE vendor_id = $1 AND user_id = $2 AND role = 'vendor_owner'`,
        [vendorId, targetId],
      );
      assert.equal(created.rows[0]?.count, '0');
    } finally {
      await cleanup(seed);
    }
  });

  void it('re-evaluates existing tokens and preserves multi-role assurance', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const firstOwnerId = await insertUser(seed, 'First Owner');
    const secondOwnerId = await insertUser(seed, 'Second Owner');
    const mixedRoleId = await insertUser(seed, 'Mixed Role Administrator');
    const vendorId = await insertVendor(seed);
    const firstOwnerMembershipId = await insertMembership({
      vendorId,
      userId: firstOwnerId,
      role: 'vendor_owner',
    });
    await insertMembership({
      vendorId,
      userId: secondOwnerId,
      role: 'vendor_owner',
    });
    await insertMembership({ vendorId, userId: mixedRoleId, role: 'customer' });
    await insertMembership({
      vendorId,
      userId: mixedRoleId,
      role: 'vendor_administrator',
    });
    const firstOwnerToken = await issueSession(firstOwnerId);
    const mixedAdminToken = await issueSession(mixedRoleId);
    const client = await ownerPool.connect();
    const mixedPhoneToken = await insertSession(client, mixedRoleId, 'phone_otp');
    client.release();

    try {
      const mixedAllowed = await request(
        baseUrl,
        mixedAdminToken,
        `/v1/vendors/${vendorId}/memberships`,
      );
      assert.equal(mixedAllowed.status, 200);
      const mixedPhoneDenied = await request(
        baseUrl,
        mixedPhoneToken,
        `/v1/vendors/${vendorId}/memberships`,
      );
      assert.equal(mixedPhoneDenied.status, 401);

      const ended = await request(
        baseUrl,
        firstOwnerToken,
        `/v1/vendors/${vendorId}/memberships/${firstOwnerMembershipId}/end`,
        { method: 'POST', body: JSON.stringify({ reason: 'Owner left vendor' }) },
      );
      assert.equal(ended.status, 200);
      const sameTokenDenied = await request(
        baseUrl,
        firstOwnerToken,
        `/v1/vendors/${vendorId}/memberships`,
      );
      assert.equal(sameTokenDenied.status, 401);
      const unchangedSession = await ownerPool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM sessions WHERE access_token_hash = $1',
        [tokenHash(firstOwnerToken)],
      );
      assert.equal(unchangedSession.rows[0]?.revoked_at, null);

    } finally {
      await cleanup(seed);
    }
  });

  void it('serializes concurrent removal of two distinct owners', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const firstOwnerId = await insertUser(seed, 'Concurrent First Owner');
    const secondOwnerId = await insertUser(seed, 'Concurrent Second Owner');
    const vendorId = await insertVendor(seed);
    const firstMembershipId = await insertMembership({
      vendorId,
      userId: firstOwnerId,
      role: 'vendor_owner',
    });
    const secondMembershipId = await insertMembership({
      vendorId,
      userId: secondOwnerId,
      role: 'vendor_owner',
    });
    const firstActor = actor(firstOwnerId);
    const secondActor = actor(secondOwnerId);
    const memberships = app.get(MembershipService);
    const [firstBlocker, secondBlocker] = await Promise.all([
      ownerPool.connect(),
      ownerPool.connect(),
    ]);
    let blockersOpen = false;

    try {
      await Promise.all([firstBlocker.query('BEGIN'), secondBlocker.query('BEGIN')]);
      blockersOpen = true;
      await Promise.all([
        firstBlocker.query(
          'SELECT id FROM vendor_memberships WHERE id = $1 FOR UPDATE',
          [firstMembershipId],
        ),
        secondBlocker.query(
          'SELECT id FROM vendor_memberships WHERE id = $1 FOR UPDATE',
          [secondMembershipId],
        ),
      ]);

      const removals = [
        requestContextStore.run(
          { correlationId: randomUUID(), actor: firstActor },
          () =>
            memberships.end(
              firstActor,
              vendorId,
              firstMembershipId,
              'Concurrent first owner removal',
            ),
        ),
        requestContextStore.run(
          { correlationId: randomUUID(), actor: secondActor },
          () =>
            memberships.softDelete(
              secondActor,
              vendorId,
              secondMembershipId,
              'Concurrent second owner removal',
            ),
        ),
      ];
      const settled = Promise.allSettled(removals);
      const states = await Promise.all(
        removals.map((removal) =>
          Promise.race([
            removal.then(
              () => 'completed',
              () => 'completed',
            ),
            new Promise<'blocked'>((resolve) =>
              setTimeout(() => resolve('blocked'), 100),
            ),
          ]),
        ),
      );
      assert.deepEqual(states, ['blocked', 'blocked']);

      await Promise.all([firstBlocker.query('COMMIT'), secondBlocker.query('COMMIT')]);
      blockersOpen = false;
      const outcomes = await settled;
      assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
      const rejection = outcomes.find(({ status }) => status === 'rejected');
      assert.ok(rejection && rejection.status === 'rejected');
      assert.ok(
        rejection.reason instanceof Error &&
          'code' in rejection.reason &&
          rejection.reason.code === 'LAST_VENDOR_OWNER',
      );
      const owners = await ownerPool.query<{ count: string }>(
        `SELECT count(*) FROM vendor_memberships
         WHERE vendor_id = $1 AND role = 'vendor_owner' AND status = 'active'
           AND ended_at IS NULL AND deleted_at IS NULL`,
        [vendorId],
      );
      assert.equal(owners.rows[0]?.count, '1');
    } finally {
      if (blockersOpen) {
        await Promise.allSettled([
          firstBlocker.query('ROLLBACK'),
          secondBlocker.query('ROLLBACK'),
        ]);
      }
      firstBlocker.release();
      secondBlocker.release();
      await cleanup(seed);
    }
  });

  void it('rolls back membership mutation when its required audit fails', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const ownerId = await insertUser(seed, 'Audit Owner');
    const targetId = await insertUser(seed, 'Audit Target');
    const vendorId = await insertVendor(seed);
    await insertMembership({ vendorId, userId: ownerId, role: 'vendor_owner' });
    const membershipId = await insertMembership({
      vendorId,
      userId: targetId,
      role: 'customer',
    });
    const token = await issueSession(ownerId);
    await ownerPool.query(`
      CREATE OR REPLACE FUNCTION task10_fail_membership_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'membership.role_changed' THEN
          RAISE EXCEPTION 'forced Task 10 audit failure';
        END IF;
        RETURN NEW;
      END $$`);
    await ownerPool.query(`
      CREATE TRIGGER task10_fail_membership_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION task10_fail_membership_audit()`);

    try {
      const response = await request(
        baseUrl,
        token,
        `/v1/vendors/${vendorId}/memberships/${membershipId}`,
        { method: 'PATCH', body: JSON.stringify({ role: 'delivery_agent' }) },
      );
      assert.equal(response.status, 500);
      const membership = await ownerPool.query<{ role: string }>(
        'SELECT role FROM vendor_memberships WHERE id = $1',
        [membershipId],
      );
      assert.deepEqual(membership.rows, [{ role: 'customer' }]);
    } finally {
      await ownerPool.query(
        'DROP TRIGGER IF EXISTS task10_fail_membership_audit ON audit_events',
      );
      await ownerPool.query('DROP FUNCTION IF EXISTS task10_fail_membership_audit()');
      await cleanup(seed);
    }
  });

  void it('serializes user delete and restore with session creation and protects the last platform administrator', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const administratorId = await insertUser(seed, 'Lifecycle Administrator');
    const targetId = await insertUser(seed, 'Concurrent User');
    await grantPlatformAdministrator(administratorId);
    const administratorToken = await issueSession(administratorId);

    const assertWaitsForUserLock = async (
      action: () => Promise<Response>,
      beforeRelease: (client: pg.PoolClient) => Promise<void>,
    ): Promise<Response> => {
      const client = await ownerPool.connect();
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`session-user:${targetId}`],
      );
      try {
        const pending = action();
        const state = await Promise.race([
          pending.then(() => 'completed'),
          new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
        ]);
        assert.equal(state, 'blocked');
        await beforeRelease(client);
        await client.query('COMMIT');
        return await pending;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    try {
      const deleted = await assertWaitsForUserLock(
        () =>
          request(baseUrl, administratorToken, `/v1/platform/users/${targetId}`, {
            method: 'DELETE',
            body: JSON.stringify({ reason: 'Concurrent deletion test' }),
          }),
        async (client) => {
          await insertSession(client, targetId);
        },
      );
      assert.equal(deleted.status, 204);
      const afterDelete = await ownerPool.query<{ count: string }>(
        'SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
        [targetId],
      );
      assert.equal(afterDelete.rows[0]?.count, '0');

      const restored = await assertWaitsForUserLock(
        () =>
          request(
            baseUrl,
            administratorToken,
            `/v1/platform/users/${targetId}/restore`,
            {
              method: 'POST',
              body: JSON.stringify({ reason: 'Concurrent restore test' }),
            },
          ),
        async (client) => {
          await insertSession(client, targetId);
        },
      );
      assert.equal(restored.status, 200);
      const afterRestore = await ownerPool.query<{ count: string }>(
        'SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
        [targetId],
      );
      assert.equal(afterRestore.rows[0]?.count, '0');
    } finally {
      await cleanup(seed);
    }
  });

  void it('publishes authenticated DTO contracts and rejects unknown fields', async () => {
    const openApi = (await (
      await fetch(`${baseUrl}/openapi.json`)
    ).json()) as {
      paths: Record<string, Record<string, { security?: unknown }>>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    const path = openApi.paths['/v1/vendors/{vendorId}/memberships'];
    assert.ok(path?.get?.security);
    assert.ok(path?.post?.security);
    assert.ok(openApi.components?.securitySchemes?.opaqueBearer);

    const seed: Seed = { vendorIds: [], userIds: [] };
    const ownerId = await insertUser(seed, 'Vendor Owner');
    const targetId = await insertUser(seed);
    const vendorId = await insertVendor(seed);
    await insertMembership({ vendorId, userId: ownerId, role: 'vendor_owner' });
    const token = await issueSession(ownerId);
    try {
      const unknown = await request(
        baseUrl,
        token,
        `/v1/vendors/${vendorId}/memberships`,
        {
          method: 'POST',
          body: JSON.stringify({ userId: targetId, role: 'customer', unexpected: true }),
        },
      );
      assert.equal(unknown.status, 400);
    } finally {
      await cleanup(seed);
    }
  });
});
