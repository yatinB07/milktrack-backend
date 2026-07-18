import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { PrismaAuditWriter } from '../src/audit/infrastructure/prisma-audit.writer.js';
import type { AuthorizationPolicy } from '../src/authorization/application/authorization.policy.js';
import { PrismaTenantAuthorizationExecutor } from '../src/authorization/application/tenant-authorization.executor.js';
import { PrismaAuthorizationPolicy } from '../src/authorization/infrastructure/prisma-authorization.policy.js';
import { PrismaSecurityDenialRecorder } from '../src/authorization/infrastructure/security-denial.recorder.js';
import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { PrismaTenantTransactionRunner } from '../src/database/tenant-transaction.runner.js';
import type { Prisma } from '../src/generated/prisma/client.js';

const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});

const forbidden = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === 'FORBIDDEN' &&
  error.message === 'You are not allowed to perform this action' &&
  error.status === 403;

const actor = (
  userId: string,
  platformRoles: Actor['platformRoles'] = [],
): Actor => ({
  userId,
  sessionId: randomUUID(),
  displayName: 'Authorization Test User',
  authenticationMethod: 'administrator_mfa',
  platformRoles,
  memberships: [],
});

async function insertUser(userId: string): Promise<void> {
  await ownerPool.query(
    `INSERT INTO users (id, display_name, updated_at)
     VALUES ($1, 'Authorization User', now())`,
    [userId],
  );
}

async function insertVendor(
  vendorId: string,
  status = 'active',
  deleted = false,
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO vendors
      (id, code, legal_name, display_name, status, timezone, currency,
       skip_cutoff_minutes, billing_day, deleted_at, updated_at)
     VALUES ($1, $2, 'Authorization Vendor', 'Authorization Vendor', $3,
             'Asia/Kolkata', 'INR', 0, 1, $4, now())`,
    [vendorId, `auth-${vendorId}`, status, deleted ? new Date() : null],
  );
}

async function insertMembership(input: Readonly<{
  vendorId: string;
  userId: string;
  role?: string;
  status?: string;
  deleted?: boolean;
}>): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `INSERT INTO vendor_memberships
      (id, vendor_id, user_id, role, status, joined_at, ended_at, deleted_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7, now())`,
    [
      id,
      input.vendorId,
      input.userId,
      input.role ?? 'vendor_owner',
      input.status ?? 'active',
      input.status === 'ended' ? new Date() : null,
      input.deleted ? new Date() : null,
    ],
  );
  return id;
}

async function insertGrant(input: Readonly<{
  vendorId: string;
  userId: string;
  scope?: readonly string[];
  accessMode?: string;
  startsAt?: Date;
  expiresAt?: Date;
  revokedAt?: Date;
}>): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `INSERT INTO support_access_grants
      (id, vendor_id, grantee_user_id, requested_by, approved_by, purpose,
       scope_json, access_mode, starts_at, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $4, 'Investigate authorized incident',
             $5::jsonb, $6, $7, $8, $9)`,
    [
      id,
      input.vendorId,
      input.userId,
      randomUUID(),
      JSON.stringify(input.scope ?? ['audit:read']),
      input.accessMode ?? 'read',
      input.startsAt ?? new Date(Date.now() - 60_000),
      input.expiresAt ?? new Date(Date.now() + 60_000),
      input.revokedAt ?? null,
    ],
  );
  return id;
}

async function cleanup(input: Readonly<{
  vendorIds: readonly string[];
  userIds: readonly string[];
}>): Promise<void> {
  await ownerPool.query(
    'DELETE FROM audit_events WHERE entity_id = ANY($1::uuid[]) OR vendor_id = ANY($1::uuid[])',
    [input.vendorIds],
  );
  await ownerPool.query(
    'DELETE FROM support_access_grants WHERE vendor_id = ANY($1::uuid[])',
    [input.vendorIds],
  );
  await ownerPool.query(
    'DELETE FROM vendor_memberships WHERE vendor_id = ANY($1::uuid[])',
    [input.vendorIds],
  );
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
    input.userIds,
  ]);
  await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [
    input.vendorIds,
  ]);
}

test.after(() => ownerPool.end());

void test('active memberships are vendor-specific and ended or deleted memberships deny', async () => {
  const vendorIds = [randomUUID(), randomUUID()];
  const userId = randomUUID();
  const prisma = new PrismaService();
  const runner = new PrismaTenantTransactionRunner(prisma);
  const audits = new PrismaAuditWriter();
  const policy = new PrismaAuthorizationPolicy(audits);
  const executor = new PrismaTenantAuthorizationExecutor(
    runner,
    policy,
    new PrismaSecurityDenialRecorder(prisma),
  );
  await insertUser(userId);
  await Promise.all(vendorIds.map((vendorId) => insertVendor(vendorId)));
  const activeId = await insertMembership({ vendorId: vendorIds[0], userId });
  await insertMembership({
    vendorId: vendorIds[1],
    userId,
    status: 'ended',
  });

  try {
    await runner.run(vendorIds[0], (tx) =>
      policy.requireVendor(
        tx,
        actor(userId),
        vendorIds[0],
        'membership:manage',
        'membership.update-role',
      ),
    );
    const multiRoleActor = actor(userId, ['support_operations']);
    await requestContextStore.run(
      { correlationId: randomUUID(), actor: multiRoleActor },
      () =>
        executor.execute(
          {
            actor: multiRoleActor,
            vendorId: vendorIds[0],
            permission: 'membership:read',
            operation: 'membership.list',
          },
          () => Promise.resolve(undefined),
        ),
    );
    await assert.rejects(
      runner.run(vendorIds[1], (tx) =>
        policy.requireVendor(
          tx,
          actor(userId),
          vendorIds[1],
          'membership:read',
          'membership.list',
        ),
      ),
      forbidden,
    );

    await ownerPool.query(
      'UPDATE vendor_memberships SET deleted_at = now() WHERE id = $1',
      [activeId],
    );
    await assert.rejects(
      runner.run(vendorIds[0], (tx) =>
        policy.requireVendor(
          tx,
          actor(userId),
          vendorIds[0],
          'membership:read',
          'membership.list',
        ),
      ),
      forbidden,
    );
  } finally {
    await prisma.$disconnect();
    await cleanup({ vendorIds, userIds: [userId] });
  }
});

void test('support access requires a current matching vendor read grant and audits successful access', async () => {
  const vendorIds = [randomUUID(), randomUUID()];
  const userId = randomUUID();
  const prisma = new PrismaService();
  const runner = new PrismaTenantTransactionRunner(prisma);
  const audits = new PrismaAuditWriter();
  const policy = new PrismaAuthorizationPolicy(audits);
  const executor = new PrismaTenantAuthorizationExecutor(
    runner,
    policy,
    new PrismaSecurityDenialRecorder(prisma),
  );
  await insertUser(userId);
  await Promise.all(vendorIds.map((vendorId) => insertVendor(vendorId)));

  const invalidGrants = [
    { startsAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) },
    { startsAt: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 120_000) },
    { revokedAt: new Date() },
  ];

  try {
    for (const grant of invalidGrants) {
      const id = await insertGrant({ vendorId: vendorIds[0], userId, ...grant });
      await assert.rejects(
        runner.run(vendorIds[0], (tx) =>
          policy.requireSupport(tx, actor(userId, ['support_operations']), vendorIds[0], 'audit:read', new Date()),
        ),
        forbidden,
      );
      await ownerPool.query('DELETE FROM support_access_grants WHERE id = $1', [id]);
    }

    await insertGrant({ vendorId: vendorIds[1], userId });
    await assert.rejects(
      runner.run(vendorIds[0], (tx) =>
        policy.requireSupport(tx, actor(userId, ['support_operations']), vendorIds[0], 'audit:read', new Date()),
      ),
      forbidden,
    );

    const grantId = await insertGrant({ vendorId: vendorIds[0], userId });
    const correlationId = randomUUID();
    await requestContextStore.run(
      { correlationId, actor: actor(userId, ['support_operations']) },
      () =>
        runner.run(vendorIds[0], (tx) =>
          policy.requireSupport(tx, actor(userId, ['support_operations']), vendorIds[0], 'audit:read', new Date()),
        ),
    );
    await assert.rejects(
      runner.run(vendorIds[0], (tx) =>
        policy.requireSupport(tx, actor(userId, ['support_operations']), vendorIds[0], 'membership:manage', new Date()),
      ),
      forbidden,
    );
    const supportActor = actor(userId, ['support_operations']);
    let operationCalls = 0;
    await assert.rejects(
      requestContextStore.run(
        { correlationId: randomUUID(), actor: supportActor },
        () =>
          executor.execute(
            {
              actor: supportActor,
              vendorId: vendorIds[0],
              permission: 'audit:read',
              operation: 'membership.create',
            },
            () => {
              operationCalls += 1;
              return Promise.resolve(undefined);
            },
          ),
      ),
      forbidden,
    );
    assert.equal(operationCalls, 0);

    const audits = await ownerPool.query<{
      action: string;
      entity_id: string;
      new_value: unknown;
      correlation_id: string;
    }>(
      `SELECT action, entity_id, new_value, correlation_id
       FROM audit_events WHERE vendor_id = $1`,
      [vendorIds[0]],
    );
    assert.deepEqual(audits.rows, [
      {
        action: 'support.accessed',
        entity_id: grantId,
        new_value: { scope: 'audit:read' },
        correlation_id: correlationId,
      },
    ]);
  } finally {
    await prisma.$disconnect();
    await cleanup({ vendorIds, userIds: [userId] });
  }
});

void test('every tenant denial rolls back and leaves exactly one minimal global denial audit', async () => {
  const vendorIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const missingVendorId = randomUUID();
  const userIds = [randomUUID(), randomUUID()];
  const prisma = new PrismaService();
  const runner = new PrismaTenantTransactionRunner(prisma);
  const audits = new PrismaAuditWriter();
  const policy = new PrismaAuthorizationPolicy(audits);
  const executor = new PrismaTenantAuthorizationExecutor(
    runner,
    policy,
    new PrismaSecurityDenialRecorder(prisma),
  );
  await Promise.all(userIds.map(insertUser));
  await insertVendor(vendorIds[0]);
  await insertVendor(vendorIds[1], 'suspended');
  await insertVendor(vendorIds[2], 'active', true);
  await insertVendor(vendorIds[3]);
  await insertMembership({ vendorId: vendorIds[3], userId: userIds[0] });
  const expiredGrantId = await insertGrant({
    vendorId: vendorIds[0],
    userId: userIds[1],
    expiresAt: new Date(Date.now() - 60_000),
  });

  const cases = [
    {
      vendorId: missingVendorId,
      currentActor: actor(userIds[0]),
      permission: 'membership:read' as const,
      operation: 'membership.list',
    },
    {
      vendorId: vendorIds[1],
      currentActor: actor(userIds[0]),
      permission: 'membership:read' as const,
      operation: 'membership.list',
    },
    {
      vendorId: vendorIds[2],
      currentActor: actor(userIds[0]),
      permission: 'membership:read' as const,
      operation: 'membership.list',
    },
    {
      vendorId: vendorIds[0],
      currentActor: actor(userIds[0]),
      permission: 'membership:read' as const,
      operation: 'membership.list',
    },
    {
      vendorId: vendorIds[0],
      currentActor: actor(userIds[1], ['support_operations']),
      permission: 'audit:read' as const,
      operation: 'audit.list',
    },
  ];

  try {
    for (const denied of cases) {
      const correlationId = randomUUID();
      let operationCalls = 0;
      await assert.rejects(
        requestContextStore.run(
          { correlationId, actor: denied.currentActor },
          () =>
            executor.execute(
              {
                actor: denied.currentActor,
                vendorId: denied.vendorId,
                permission: denied.permission,
                operation: denied.operation,
              },
              () => {
                operationCalls += 1;
                return Promise.resolve(undefined);
              },
            ),
        ),
        forbidden,
      );
      assert.equal(operationCalls, 0);

      const denialAudits = await ownerPool.query<{
        vendor_id: string | null;
        actor_user_id: string;
        action: string;
        entity_type: string;
        entity_id: string;
        old_value: unknown;
        new_value: unknown;
        reason: string;
        correlation_id: string;
        ip_hash: string | null;
        device_id: string | null;
      }>(
        `SELECT vendor_id, actor_user_id, action, entity_type, entity_id,
                old_value, new_value, reason, correlation_id, ip_hash, device_id
         FROM audit_events WHERE correlation_id = $1`,
        [correlationId],
      );
      assert.deepEqual(denialAudits.rows, [
        {
          vendor_id: null,
          actor_user_id: denied.currentActor.userId,
          action: 'security.tenant_access_denied',
          entity_type: 'vendor',
          entity_id: denied.vendorId,
          old_value: null,
          new_value: { operation: denied.operation },
          reason: 'FORBIDDEN',
          correlation_id: correlationId,
          ip_hash: null,
          device_id: null,
        },
      ]);
    }
  } finally {
    await ownerPool.query('DELETE FROM support_access_grants WHERE id = $1', [expiredGrantId]);
    await prisma.$disconnect();
    await cleanup({ vendorIds: [...vendorIds, missingVendorId], userIds });
  }
});

void test('denial audit failure returns stable 503 and cannot commit a protected mutation', async () => {
  const vendorId = randomUUID();
  const userId = randomUUID();
  const prisma = new PrismaService();
  const runner = new PrismaTenantTransactionRunner(prisma);
  await insertUser(userId);
  await insertVendor(vendorId);

  const mutatingDenyPolicy: AuthorizationPolicy = {
    requirePlatform: () => undefined,
    requireSupport: () => Promise.reject(new Error('unused')),
    requireVendor: async (tx: Prisma.TransactionClient) => {
      await tx.vendor.update({
        where: { id: vendorId },
        data: { version: { increment: 1 } },
      });
      throw new ApplicationError(
        'FORBIDDEN',
        'You are not allowed to perform this action',
        403,
      );
    },
  };
  const executor = new PrismaTenantAuthorizationExecutor(
    runner,
    mutatingDenyPolicy,
    new PrismaSecurityDenialRecorder(prisma),
  );

  try {
    await assert.rejects(
      requestContextStore.run(
        { correlationId: 'invalid-correlation-id', actor: actor(userId) },
        () =>
          executor.execute(
            {
              actor: actor(userId),
              vendorId,
              permission: 'membership:read',
              operation: 'membership.list',
            },
            () => Promise.resolve(undefined),
          ),
      ),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'SECURITY_AUDIT_UNAVAILABLE' &&
        error.message === 'Security audit is temporarily unavailable' &&
        error.status === 503,
    );
    const vendor = await ownerPool.query<{ version: number }>(
      'SELECT version FROM vendors WHERE id = $1',
      [vendorId],
    );
    assert.deepEqual(vendor.rows, [{ version: 1 }]);
    const denialCount = await ownerPool.query<{ count: string }>(
      `SELECT count(*) FROM audit_events
       WHERE action = 'security.tenant_access_denied' AND entity_id = $1`,
      [vendorId],
    );
    assert.equal(denialCount.rows[0]?.count, '0');
  } finally {
    await prisma.$disconnect();
    await cleanup({ vendorIds: [vendorId], userIds: [userId] });
  }
});
