import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { INestApplication } from '@nestjs/common';
import pg from 'pg';

const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});
const authKey = Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64');

type Seed = {
  vendorIds: string[];
  userIds: string[];
};

type AuditItem = Readonly<Record<string, unknown>> & Readonly<{ id: string }>;
type AuditPage = Readonly<{ items: AuditItem[]; nextCursor?: string }>;

const requiredItemKeys = [
  'action',
  'actorUserId',
  'correlationId',
  'createdAt',
  'entityId',
  'entityType',
  'id',
  'vendorId',
];

function tokenHash(token: string): string {
  return createHmac('sha256', authKey).update(token).digest('hex');
}

async function insertUser(seed: Seed, displayName: string): Promise<string> {
  const id = randomUUID();
  seed.userIds.push(id);
  await ownerPool.query(
    `INSERT INTO users (id, display_name, updated_at)
     VALUES ($1, $2, now())`,
    [id, displayName],
  );
  return id;
}

async function insertVendor(seed: Seed, displayName = 'Audit Vendor'): Promise<string> {
  const id = randomUUID();
  seed.vendorIds.push(id);
  await ownerPool.query(
    `INSERT INTO vendors
       (id, code, legal_name, display_name, status, timezone, currency,
        skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, $3, $3, 'active', 'Asia/Kolkata', 'INR', 0, 1, now())`,
    [id, `audit-${id}`, displayName],
  );
  return id;
}

async function insertMembership(
  vendorId: string,
  userId: string,
  role: 'vendor_owner' | 'vendor_administrator' | 'delivery_agent' | 'customer',
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO vendor_memberships
       (id, vendor_id, user_id, role, status, joined_at, updated_at)
     VALUES ($1, $2, $3, $4::"MembershipRole", 'active', now(), now())`,
    [randomUUID(), vendorId, userId, role],
  );
}

async function insertPlatformRole(
  userId: string,
  role: 'product_owner' | 'platform_administrator' | 'support_operations',
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO platform_role_assignments
       (id, user_id, role, granted_by)
     VALUES ($1, $2, $3::"PlatformRole", $2)`,
    [randomUUID(), userId, role],
  );
}

async function issueSession(
  userId: string,
  authenticationMethod: 'phone_otp' | 'administrator_mfa',
): Promise<string> {
  const token = `audit-api-${randomUUID()}`;
  await ownerPool.query(
    `INSERT INTO sessions
       (id, user_id, access_token_hash, refresh_token_hash,
        authentication_method, device_id, access_expires_at, expires_at,
        last_seen_at)
     VALUES ($1, $2, $3, $4, $5::"AuthenticationMethod", 'audit-api-device',
             now() + interval '1 hour', now() + interval '1 day', now())`,
    [randomUUID(), userId, tokenHash(token), tokenHash(randomUUID()), authenticationMethod],
  );
  return token;
}

async function seedVendorActor(
  seed: Seed,
  vendorId: string,
  role: 'vendor_owner' | 'vendor_administrator' | 'delivery_agent' | 'customer',
  authenticationMethod: 'phone_otp' | 'administrator_mfa',
): Promise<Readonly<{ userId: string; token: string }>> {
  const userId = await insertUser(seed, role);
  await insertMembership(vendorId, userId, role);
  return { userId, token: await issueSession(userId, authenticationMethod) };
}

async function seedPlatformActor(
  seed: Seed,
  role: 'product_owner' | 'platform_administrator' | 'support_operations',
): Promise<Readonly<{ userId: string; token: string }>> {
  const userId = await insertUser(seed, role);
  await insertPlatformRole(userId, role);
  return { userId, token: await issueSession(userId, 'administrator_mfa') };
}

async function insertAudit(input: Readonly<{
  vendorId: string;
  actorUserId: string;
  id?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string;
  createdAt?: string;
  ipHash?: string;
  deviceId?: string;
}>): Promise<string> {
  const id = input.id ?? randomUUID();
  await ownerPool.query(
    `INSERT INTO audit_events
       (id, vendor_id, actor_user_id, action, entity_type, entity_id,
        old_value, new_value, reason, correlation_id, ip_hash, device_id,
        created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
             $11, $12, COALESCE($13::timestamptz, now()))`,
    [
      id,
      input.vendorId,
      input.actorUserId,
      input.action,
      input.entityType ?? 'test_entity',
      input.entityId ?? randomUUID(),
      input.oldValue === undefined ? null : JSON.stringify(input.oldValue),
      input.newValue === undefined ? null : JSON.stringify(input.newValue),
      input.reason ?? null,
      randomUUID(),
      input.ipHash ?? null,
      input.deviceId ?? null,
      input.createdAt ?? null,
    ],
  );
  return id;
}

async function insertGrant(input: Readonly<{
  vendorId: string;
  userId: string;
  startsAt: Date;
  expiresAt: Date;
}>): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `INSERT INTO support_access_grants
       (id, vendor_id, grantee_user_id, requested_by, approved_by, purpose,
        scope_json, access_mode, starts_at, expires_at)
     VALUES ($1, $2, $3, $3, $3, 'Audit investigation',
             '["audit:read"]'::jsonb, 'read', $4, $5)`,
    [id, input.vendorId, input.userId, input.startsAt, input.expiresAt],
  );
  return id;
}

async function cleanup(seed: Seed): Promise<void> {
  await ownerPool.query(
    `DELETE FROM audit_events
     WHERE vendor_id = ANY($1::uuid[]) OR actor_user_id = ANY($2::uuid[])`,
    [seed.vendorIds, seed.userIds],
  );
  await ownerPool.query(
    'DELETE FROM support_access_grants WHERE vendor_id = ANY($1::uuid[])',
    [seed.vendorIds],
  );
  await ownerPool.query(
    'DELETE FROM vendor_memberships WHERE vendor_id = ANY($1::uuid[])',
    [seed.vendorIds],
  );
  await ownerPool.query(
    'DELETE FROM platform_role_assignments WHERE user_id = ANY($1::uuid[])',
    [seed.userIds],
  );
  await ownerPool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [
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
  vendorId: string,
  token?: string,
  query = '',
  correlationId?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/vendors/${vendorId}/audit-events${query}`, {
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(correlationId === undefined
        ? {}
        : { 'x-correlation-id': correlationId }),
    },
  });
}

async function jsonPage(response: Response): Promise<AuditPage> {
  assert.equal(response.status, 200);
  return response.json() as Promise<AuditPage>;
}

async function expectError(
  response: Response,
  status: number,
  code?: string,
): Promise<void> {
  assert.equal(response.status, status);
  if (code !== undefined) {
    assert.equal(((await response.json()) as Record<string, unknown>).code, code);
  }
}

void describe('tenant audit HTTP API', () => {
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

  void it('traverses default and explicit pages without gaps at millisecond precision', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const vendorId = await insertVendor(seed);
    const owner = await seedVendorActor(
      seed,
      vendorId,
      'vendor_owner',
      'administrator_mfa',
    );
    const ids = Array.from({ length: 27 }, () => randomUUID()).sort().reverse();
    try {
      await Promise.all(
        ids.map((id) =>
          insertAudit({
            id,
            vendorId,
            actorUserId: owner.userId,
            action: 'page.created',
            createdAt: '2099-07-18T12:00:00.000Z',
          }),
        ),
      );

      const first = await jsonPage(await request(baseUrl, vendorId, owner.token));
      assert.equal(first.items.length, 25);
      assert.ok(first.nextCursor);
      assert.ok(
        first.items.every(
          (item) => Object.keys(item).sort().join() === requiredItemKeys.join(),
        ),
      );
      const second = await jsonPage(
        await request(
          baseUrl,
          vendorId,
          owner.token,
          `?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
        ),
      );
      assert.deepEqual(
        [...first.items.map(({ id }) => id), ...second.items.map(({ id }) => id)],
        ids,
      );
      assert.equal(second.nextCursor, undefined);

      assert.equal(
        (await request(baseUrl, vendorId, owner.token, '?limit=100')).status,
        200,
      );
      await expectError(
        await request(baseUrl, vendorId, owner.token, '?limit=101'),
        400,
      );
      await expectError(
        await request(baseUrl, vendorId, owner.token, '?cursor=invalid'),
        400,
        'INVALID_CURSOR',
      );
      await expectError(
        await request(baseUrl, vendorId, owner.token, '?unknown=true'),
        400,
      );
    } finally {
      await cleanup(seed);
    }
  });

  void it('preserves microsecond-boundary rows through the millisecond cursor invariant', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const vendorId = await insertVendor(seed);
    const owner = await seedVendorActor(
      seed,
      vendorId,
      'vendor_owner',
      'administrator_mfa',
    );
    const ids = Array.from({ length: 3 }, () => randomUUID()).sort().reverse();
    const timestamps = [
      '2100-07-18T12:00:00.123900Z',
      '2100-07-18T12:00:00.123800Z',
      '2100-07-18T12:00:00.123700Z',
    ];
    try {
      for (const [index, id] of ids.entries()) {
        await insertAudit({
          id,
          vendorId,
          actorUserId: owner.userId,
          action: 'precision.created',
          createdAt: timestamps[index],
        });
      }
      let cursor: string | undefined;
      const collected: string[] = [];
      for (let index = 0; index < ids.length; index += 1) {
        const page = await jsonPage(
          await request(
            baseUrl,
            vendorId,
            owner.token,
            `?action=precision.created&limit=1${
              cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`
            }`,
          ),
        );
        assert.equal(
          page.items.length,
          1,
          `page ${index}: ${JSON.stringify({ page, ids, collected, cursor })}`,
        );
        collected.push(page.items[0].id);
        cursor = page.nextCursor;
      }
      assert.deepEqual(collected, ids);
    } finally {
      await cleanup(seed);
    }
  });

  void it('combines filters and recursively redacts public JSON values', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const vendorId = await insertVendor(seed);
    const owner = await seedVendorActor(
      seed,
      vendorId,
      'vendor_owner',
      'administrator_mfa',
    );
    const entityId = randomUUID();
    try {
      const targetId = await insertAudit({
        vendorId,
        actorUserId: owner.userId,
        action: 'delivery.corrected',
        entityType: 'delivery',
        entityId,
        oldValue: {
          safe: 'visible',
          password: 'remove',
          nested: [{ keep: 1, device_id: 'remove' }],
        },
        newValue: {
          tokenHash: 'remove',
          profile: {
            allowed: true,
            ipHash: 'remove',
            authenticationMethod: 'remove',
          },
        },
        reason: 'Approved correction',
        ipHash: 'never-public',
        deviceId: 'never-public',
      });
      await insertAudit({
        vendorId,
        actorUserId: owner.userId,
        action: 'delivery.corrected',
        entityType: 'invoice',
        entityId,
      });
      await insertAudit({
        vendorId,
        actorUserId: owner.userId,
        action: 'delivery.created',
        entityType: 'delivery',
        entityId,
      });

      const page = await jsonPage(
        await request(
          baseUrl,
          vendorId,
          owner.token,
          `?action=delivery.corrected&entityType=delivery&entityId=${entityId}`,
        ),
      );
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0].id, targetId);
      assert.deepEqual(Object.keys(page.items[0]).sort(), [
        ...requiredItemKeys,
        'newValue',
        'oldValue',
        'reason',
      ].sort());
      assert.deepEqual(page.items[0].oldValue, {
        safe: 'visible',
        nested: [{ keep: 1 }],
      });
      assert.deepEqual(page.items[0].newValue, {
        profile: { allowed: true },
      });
      assert.doesNotMatch(
        JSON.stringify(page),
        /password|otp|token|secret|ipHash|ip_hash|deviceId|device_id|authenticationMethod/i,
      );

      const minimal = await jsonPage(
        await request(baseUrl, vendorId, owner.token, '?action=delivery.created'),
      );
      assert.deepEqual(Object.keys(minimal.items[0]).sort(), requiredItemKeys);
    } finally {
      await cleanup(seed);
    }
  });

  void it('enforces tenant roles, administrator MFA, and no platform-role bypass', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const vendorIds = [await insertVendor(seed), await insertVendor(seed)];
    const owner = await seedVendorActor(
      seed,
      vendorIds[0],
      'vendor_owner',
      'administrator_mfa',
    );
    const administrator = await seedVendorActor(
      seed,
      vendorIds[0],
      'vendor_administrator',
      'administrator_mfa',
    );
    const phoneOwner = await seedVendorActor(
      seed,
      vendorIds[0],
      'vendor_owner',
      'phone_otp',
    );
    const customer = await seedVendorActor(
      seed,
      vendorIds[0],
      'customer',
      'phone_otp',
    );
    const agent = await seedVendorActor(
      seed,
      vendorIds[0],
      'delivery_agent',
      'phone_otp',
    );
    const productOwner = await seedPlatformActor(seed, 'product_owner');
    const platformAdministrator = await seedPlatformActor(
      seed,
      'platform_administrator',
    );
    try {
      await insertAudit({
        vendorId: vendorIds[0],
        actorUserId: owner.userId,
        action: 'authorization.visible',
      });
      assert.equal(
        (await request(baseUrl, vendorIds[0], owner.token)).status,
        200,
      );
      assert.equal(
        (await request(baseUrl, vendorIds[0], administrator.token)).status,
        200,
      );
      await expectError(
        await request(baseUrl, vendorIds[1], owner.token),
        403,
        'FORBIDDEN',
      );
      await expectError(
        await request(baseUrl, vendorIds[0], phoneOwner.token),
        401,
        'UNAUTHENTICATED',
      );
      for (const token of [
        customer.token,
        agent.token,
        productOwner.token,
        platformAdministrator.token,
      ]) {
        await expectError(
          await request(baseUrl, vendorIds[0], token),
          403,
          'FORBIDDEN',
        );
      }
    } finally {
      await cleanup(seed);
    }
  });

  void it('requires an active matching support grant and audits successful access', async () => {
    const seed: Seed = { vendorIds: [], userIds: [] };
    const vendorIds = [await insertVendor(seed), await insertVendor(seed)];
    const owner = await seedVendorActor(
      seed,
      vendorIds[0],
      'vendor_owner',
      'administrator_mfa',
    );
    const support = await seedPlatformActor(seed, 'support_operations');
    const now = Date.now();
    try {
      await insertAudit({
        vendorId: vendorIds[0],
        actorUserId: owner.userId,
        action: 'support.visible',
      });
      await insertGrant({
        vendorId: vendorIds[0],
        userId: support.userId,
        startsAt: new Date(now - 120_000),
        expiresAt: new Date(now - 60_000),
      });
      await insertGrant({
        vendorId: vendorIds[1],
        userId: support.userId,
        startsAt: new Date(now - 60_000),
        expiresAt: new Date(now + 60_000),
      });
      const deniedCorrelationId = randomUUID();
      await expectError(
        await request(
          baseUrl,
          vendorIds[0],
          support.token,
          '',
          deniedCorrelationId,
        ),
        403,
        'FORBIDDEN',
      );
      const denial = await ownerPool.query<{ action: string; vendor_id: string | null }>(
        `SELECT action, vendor_id FROM audit_events WHERE correlation_id = $1`,
        [deniedCorrelationId],
      );
      assert.deepEqual(denial.rows, [
        { action: 'security.tenant_access_denied', vendor_id: null },
      ]);

      const grantId = await insertGrant({
        vendorId: vendorIds[0],
        userId: support.userId,
        startsAt: new Date(now - 60_000),
        expiresAt: new Date(now + 60_000),
      });
      const correlationId = randomUUID();
      const page = await jsonPage(
        await request(
          baseUrl,
          vendorIds[0],
          support.token,
          '',
          correlationId,
        ),
      );
      assert.ok(
        page.items.some(
          (item) =>
            item.action === 'support.accessed' && item.entityId === grantId,
        ),
      );
      const accessAudit = await ownerPool.query<{
        action: string;
        entity_id: string;
        new_value: unknown;
      }>(
        `SELECT action, entity_id, new_value FROM audit_events
         WHERE correlation_id = $1`,
        [correlationId],
      );
      assert.deepEqual(accessAudit.rows, [
        {
          action: 'support.accessed',
          entity_id: grantId,
          new_value: { scope: 'audit:read' },
        },
      ]);
    } finally {
      await cleanup(seed);
    }
  });

  void it('publishes a guarded explicit OpenAPI contract and stable errors', async () => {
    const vendorId = randomUUID();
    await expectError(await request(baseUrl, vendorId), 401, 'UNAUTHENTICATED');
    await expectError(
      await request(baseUrl, 'not-a-uuid', 'invalid-token'),
      401,
      'UNAUTHENTICATED',
    );

    const response = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(response.status, 200);
    const document = (await response.json()) as {
      components?: { schemas?: Record<string, unknown> };
      paths?: Record<
        string,
        Record<
          string,
          { security?: unknown; responses?: Record<string, unknown> }
        >
      >;
    };
    const operation =
      document.paths?.['/v1/vendors/{vendorId}/audit-events']?.get;
    assert.deepEqual(operation?.security, [{ opaqueBearer: [] }]);
    assert.deepEqual(Object.keys(operation?.responses ?? {}).sort(), [
      '200',
      '400',
      '401',
      '403',
      '503',
    ]);
    assert.ok(document.components?.schemas?.ListAuditEventsQueryDto);
    assert.ok(document.components?.schemas?.AuditEventResponseDto);
    assert.ok(document.components?.schemas?.AuditEventListResponseDto);
    const responseSchema = document.components?.schemas
      ?.AuditEventResponseDto as { properties?: Record<string, unknown> } | undefined;
    assert.deepEqual(Object.keys(responseSchema?.properties ?? {}).sort(), [
      ...requiredItemKeys,
      'newValue',
      'oldValue',
      'reason',
    ].sort());
  });
});
