import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { after, before, describe, it, test } from 'node:test';

import pg from 'pg';

import { PrismaAuditWriter } from '../src/audit/infrastructure/prisma-audit.writer.js';
import { PrismaTenantAuthorizationExecutor } from '../src/authorization/application/tenant-authorization.executor.js';
import { PrismaAuthorizationPolicy } from '../src/authorization/infrastructure/prisma-authorization.policy.js';
import { PrismaSecurityDenialRecorder } from '../src/authorization/infrastructure/security-denial.recorder.js';
import {
  type Actor,
  requestContextStore,
} from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaMembershipService } from '../src/memberships/application/membership.service.js';
import { PrismaMembershipStore } from '../src/memberships/infrastructure/prisma-membership.store.js';
import { DefaultUserLifecycleService } from '../src/identity/application/user-lifecycle.service.js';
import { PrismaUserLifecycleStore } from '../src/identity/infrastructure/prisma-user-lifecycle.store.js';
import { PrismaIdentityAuthorizationAdapter } from '../src/authorization/infrastructure/prisma-identity-authorization.adapter.js';

const runtimePool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});

const fixture = {
  vendorA: randomUUID(),
  vendorB: randomUUID(),
  ownerA: randomUUID(),
  ownerB: randomUUID(),
  platformAdministrator: randomUUID(),
  userLifecycleTarget: randomUUID(),
  membershipA: randomUUID(),
  membershipB: randomUUID(),
  membershipBDeleted: randomUUID(),
  membershipBEnded: randomUUID(),
  grantA: randomUUID(),
  grantB: randomUUID(),
  auditA: randomUUID(),
  auditB: randomUUID(),
  auditGlobal: randomUUID(),
};

function actor(userId: string, platformRoles: Actor['platformRoles'] = []): Actor {
  return {
    userId,
    sessionId: randomUUID(),
    displayName: 'Task 13 security actor',
    authenticationMethod: 'administrator_mfa',
    platformRoles,
    memberships: [],
  };
}

function isApplicationError(code: string, status: number) {
  return (error: unknown) =>
    error instanceof ApplicationError && error.code === code && error.status === status;
}

async function tenantTransaction<T>(
  vendorId: string,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await runtimePool.connect();
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.vendor_id', $1, true)", [vendorId]);
    return await operation(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function seed(): Promise<void> {
  await ownerPool.query(
    `INSERT INTO users (id, display_name, updated_at)
     VALUES ($1, 'Task 13 Owner A', now()),
            ($2, 'Task 13 Owner B', now()),
            ($3, 'Task 13 Platform Administrator', now()),
            ($4, 'Task 13 User Lifecycle Target', now())`,
    [fixture.ownerA, fixture.ownerB, fixture.platformAdministrator, fixture.userLifecycleTarget],
  );
  await ownerPool.query(
    `INSERT INTO vendors
       (id, code, legal_name, display_name, status, timezone, currency,
        skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'Task 13 Vendor A', 'Task 13 Vendor A', 'active',
             'Asia/Kolkata', 'INR', 0, 1, now()),
            ($3, $4, 'Task 13 Vendor B', 'Task 13 Vendor B', 'active',
             'Asia/Kolkata', 'INR', 0, 1, now())`,
    [
      fixture.vendorA,
      `task13-${fixture.vendorA}`,
      fixture.vendorB,
      `task13-${fixture.vendorB}`,
    ],
  );
  await ownerPool.query(
    `INSERT INTO vendor_memberships
       (id, vendor_id, user_id, role, status, joined_at, ended_at,
        deleted_at, deleted_by, deletion_reason, updated_at)
     VALUES ($1, $2, $3, 'vendor_owner', 'active', now(), NULL,
             NULL, NULL, NULL, now()),
            ($4, $5, $6, 'vendor_owner', 'active', now(), NULL,
             NULL, NULL, NULL, now()),
            ($7, $5, $6, 'customer', 'active', now(), NULL,
             now(), $6, 'Task 13 deleted fixture', now()),
            ($8, $5, $6, 'delivery_agent', 'ended', now(), now(),
             NULL, NULL, NULL, now())`,
    [
      fixture.membershipA,
      fixture.vendorA,
      fixture.ownerA,
      fixture.membershipB,
      fixture.vendorB,
      fixture.ownerB,
      fixture.membershipBDeleted,
      fixture.membershipBEnded,
    ],
  );
  await ownerPool.query(
    `INSERT INTO platform_role_assignments (id, user_id, role, granted_by)
     VALUES ($1, $2, 'platform_administrator', $2)`,
    [randomUUID(), fixture.platformAdministrator],
  );
  await ownerPool.query(
    `INSERT INTO support_access_grants
       (id, vendor_id, grantee_user_id, requested_by, approved_by, purpose,
        scope_json, access_mode, starts_at, expires_at)
     VALUES ($1, $2, $3, $3, $3, 'Task 13 tenant A grant',
             '["audit:read"]', 'read', now() - interval '1 minute',
             now() + interval '1 hour'),
            ($4, $5, $6, $6, $6, 'Task 13 tenant B grant',
             '["audit:read"]', 'read', now() - interval '1 minute',
             now() + interval '1 hour')`,
    [
      fixture.grantA,
      fixture.vendorA,
      fixture.ownerA,
      fixture.grantB,
      fixture.vendorB,
      fixture.ownerB,
    ],
  );
  await ownerPool.query(
    `INSERT INTO audit_events
       (id, vendor_id, actor_user_id, action, entity_type, entity_id, correlation_id)
     VALUES ($1, $2, $3, 'task13.tenant_a', 'vendor', $2, $4),
            ($5, $6, $7, 'task13.tenant_b', 'vendor', $6, $8),
            ($9, NULL, $10, 'task13.global', 'security', $10, $11)`,
    [
      fixture.auditA,
      fixture.vendorA,
      fixture.ownerA,
      randomUUID(),
      fixture.auditB,
      fixture.vendorB,
      fixture.ownerB,
      randomUUID(),
      fixture.auditGlobal,
      fixture.platformAdministrator,
      randomUUID(),
    ],
  );
}

async function cleanup(): Promise<void> {
  const vendorIds = [fixture.vendorA, fixture.vendorB];
  const userIds = [fixture.ownerA, fixture.ownerB, fixture.platformAdministrator, fixture.userLifecycleTarget];
  await ownerPool.query(
    `DELETE FROM audit_events
     WHERE id = ANY($1::uuid[]) OR vendor_id = ANY($2::uuid[])
       OR actor_user_id = ANY($3::uuid[])`,
    [[fixture.auditA, fixture.auditB, fixture.auditGlobal], vendorIds, userIds],
  );
  await ownerPool.query(
    'DELETE FROM support_access_grants WHERE vendor_id = ANY($1::uuid[])',
    [vendorIds],
  );
  await ownerPool.query(
    'DELETE FROM vendor_memberships WHERE vendor_id = ANY($1::uuid[])',
    [vendorIds],
  );
  await ownerPool.query(
    'DELETE FROM platform_role_assignments WHERE user_id = ANY($1::uuid[])',
    [userIds],
  );
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
  await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [vendorIds]);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required security sentinel environment variable: ${name}`);
  return value;
}

const sentinel = {
  userId: requiredEnvironment('SECURITY_SENTINEL_USER_ID'),
  vendorId: requiredEnvironment('SECURITY_SENTINEL_VENDOR_ID'),
  membershipId: requiredEnvironment('SECURITY_SENTINEL_MEMBERSHIP_ID'),
  auditId: requiredEnvironment('SECURITY_SENTINEL_AUDIT_ID'),
  sessionId: requiredEnvironment('SECURITY_SENTINEL_SESSION_ID'),
};

void test(
  'retained data survives immutable migration 001 through every current migration',
  async () => {
    const migrationDirectories = (
      await readdir(new URL('../prisma/migrations/', import.meta.url), {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const applied = await ownerPool.query<{ migration_name: string }>(
      `SELECT migration_name FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
       ORDER BY migration_name`,
    );
    assert.deepEqual(
      applied.rows.map(({ migration_name }) => migration_name),
      migrationDirectories,
    );

    const retained = await ownerPool.query<{
      user_count: string;
      vendor_created_at: string;
      membership_count: string;
      audit_count: string;
      session_count: string;
      authentication_method: string;
      access_expired: boolean;
      refresh_expired: boolean;
    }>(
      `SELECT
         (SELECT count(*) FROM users WHERE id = $1) AS user_count,
         (SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS')
            FROM vendors WHERE id = $2) AS vendor_created_at,
         (SELECT count(*) FROM vendor_memberships WHERE id = $3) AS membership_count,
         (SELECT count(*) FROM audit_events WHERE id = $4) AS audit_count,
         (SELECT count(*) FROM sessions WHERE id = $5) AS session_count,
         (SELECT authentication_method::text FROM sessions WHERE id = $5)
            AS authentication_method,
         (SELECT access_expires_at <= now() FROM sessions WHERE id = $5)
            AS access_expired,
         (SELECT expires_at <= now() FROM sessions WHERE id = $5) AS refresh_expired`,
      [
        sentinel.userId,
        sentinel.vendorId,
        sentinel.membershipId,
        sentinel.auditId,
        sentinel.sessionId,
      ],
    );
    assert.deepEqual(retained.rows, [
      {
        user_count: '1',
        vendor_created_at: '2026-07-18T12:00:00.124',
        membership_count: '1',
        audit_count: '1',
        session_count: '1',
        authentication_method: 'phone_otp',
        access_expired: true,
        refresh_expired: true,
      },
    ]);
  },
);

void describe('Task 13 cross-tenant security release gate', () => {
  before(seed);
  after(async () => {
    await cleanup();
    await Promise.all([runtimePool.end(), ownerPool.end()]);
  });

  void it('returns no tenant rows without context and exposes only the selected tenant', async () => {
    for (const table of [
      'vendor_memberships',
      'support_access_grants',
      'audit_events',
    ] as const) {
      const missing = await runtimePool.query<{ count: string }>(
        `SELECT count(*) FROM ${table}`,
      );
      assert.equal(missing.rows[0]?.count, '0');
    }

    await tenantTransaction(fixture.vendorA, async (client) => {
      const memberships = await client.query<{
        id: string;
        vendor_id: string;
        deleted_at: Date | null;
      }>(
        `SELECT id, vendor_id, deleted_at FROM vendor_memberships
         ORDER BY id`,
      );
      assert.deepEqual(memberships.rows, [
        { id: fixture.membershipA, vendor_id: fixture.vendorA, deleted_at: null },
      ]);
      const grants = await client.query<{ id: string; vendor_id: string }>(
        'SELECT id, vendor_id FROM support_access_grants ORDER BY id',
      );
      assert.deepEqual(grants.rows, [{ id: fixture.grantA, vendor_id: fixture.vendorA }]);
      const audits = await client.query<{ id: string; vendor_id: string }>(
        'SELECT id, vendor_id FROM audit_events ORDER BY id',
      );
      assert.deepEqual(audits.rows, [{ id: fixture.auditA, vendor_id: fixture.vendorA }]);
    });
  });

  void it('denies raw cross-tenant insert, update, delete, and foreign references', async () => {
    await tenantTransaction(fixture.vendorA, async (client) => {
      await assert.rejects(
        client.query(
          `INSERT INTO vendor_memberships
             (id, vendor_id, user_id, role, status, joined_at, updated_at)
           VALUES ($1, $2, $3, 'customer', 'active', now(), now())`,
          [randomUUID(), fixture.vendorB, fixture.ownerA],
        ),
        /row-level security policy/,
      );
    });
    await tenantTransaction(fixture.vendorA, async (client) => {
      await assert.rejects(
        client.query(
          `INSERT INTO support_access_grants
             (id, vendor_id, grantee_user_id, requested_by, approved_by,
              purpose, scope_json, starts_at, expires_at)
           VALUES ($1, $2, $3, $3, $3, 'Cross-tenant attempt', '[]',
                   now(), now() + interval '1 hour')`,
          [randomUUID(), fixture.vendorB, fixture.ownerA],
        ),
        /row-level security policy/,
      );
    });
    await tenantTransaction(fixture.vendorA, async (client) => {
      await assert.rejects(
        client.query(
          `INSERT INTO audit_events
             (id, vendor_id, actor_user_id, action, entity_type, entity_id,
              correlation_id)
           VALUES ($1, $2, $3, 'task13.cross_tenant', 'vendor', $2, $4)`,
          [randomUUID(), fixture.vendorB, fixture.ownerA, randomUUID()],
        ),
        /row-level security policy/,
      );
    });

    await tenantTransaction(fixture.vendorA, async (client) => {
      for (const [table, id] of [
        ['vendor_memberships', fixture.membershipB],
        ['support_access_grants', fixture.grantB],
      ] as const) {
        const updated = await client.query(`UPDATE ${table} SET vendor_id = $1 WHERE id = $2`, [
          fixture.vendorA,
          id,
        ]);
        const deleted = await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        assert.equal(updated.rowCount, 0);
        assert.equal(deleted.rowCount, 0);
      }
      await assert.rejects(
        client.query('DELETE FROM audit_events WHERE id = $1', [fixture.auditB]),
        /permission denied/,
      );
    });

    await tenantTransaction(fixture.vendorA, async (client) => {
      await assert.rejects(
        client.query(
          'UPDATE vendor_memberships SET vendor_id = $1 WHERE id = $2',
          [fixture.vendorB, fixture.membershipA],
        ),
        /row-level security policy/,
      );
    });
    await tenantTransaction(fixture.vendorA, async (client) => {
      await assert.rejects(
        client.query(
          'UPDATE support_access_grants SET vendor_id = $1 WHERE id = $2',
          [fixture.vendorB, fixture.grantA],
        ),
        /row-level security policy/,
      );
    });
  });

  void it('does not leak foreign active, ended, or deleted memberships through lifecycle operations', async () => {
    const prisma = new PrismaService();
    const transactions = new PrismaTenantTransactionRunner(prisma);
    const audits = new PrismaAuditWriter();
    const authorization = new PrismaTenantAuthorizationExecutor(
      transactions,
      new PrismaAuthorizationPolicy(audits),
      new PrismaSecurityDenialRecorder(prisma),
    );
    const memberships = new PrismaMembershipService(
      authorization,
      new PrismaMembershipStore(),
      audits,
      {} as never,
    );
    const currentActor = actor(fixture.ownerA);
    const operations: ReadonlyArray<() => Promise<unknown>> = [
      () =>
        memberships.updateRole(
          currentActor,
          fixture.vendorA,
          fixture.membershipB,
          'vendor_administrator',
        ),
      () =>
        memberships.end(
          currentActor,
          fixture.vendorA,
          fixture.membershipBEnded,
          'Task 13 foreign ended membership',
        ),
      () =>
        memberships.softDelete(
          currentActor,
          fixture.vendorA,
          fixture.membershipB,
          'Task 13 foreign membership delete',
        ),
      () =>
        memberships.restore(
          currentActor,
          fixture.vendorA,
          fixture.membershipBDeleted,
          'Task 13 foreign membership restore',
        ),
    ];

    try {
      for (const operation of operations) {
        await assert.rejects(
          requestContextStore.run(
            { correlationId: randomUUID(), actor: currentActor },
            operation,
          ),
          isApplicationError('MEMBERSHIP_NOT_FOUND', 404),
        );
      }
      const foreignRows = await ownerPool.query<{
        id: string;
        status: string;
        deleted_at: Date | null;
      }>(
        `SELECT id, status, deleted_at FROM vendor_memberships
         WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[fixture.membershipB, fixture.membershipBDeleted, fixture.membershipBEnded]],
      );
      assert.equal(foreignRows.rowCount, 3);
      assert.equal(
        foreignRows.rows.find(({ id }) => id === fixture.membershipB)?.status,
        'active',
      );
      assert.ok(
        foreignRows.rows.find(({ id }) => id === fixture.membershipBDeleted)?.deleted_at,
      );
      assert.equal(
        foreignRows.rows.find(({ id }) => id === fixture.membershipBEnded)?.status,
        'ended',
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  void it('enforces user-manager assurance and lifecycle separation for global user discovery', async () => {
    const prisma = new PrismaService();
    const service = new DefaultUserLifecycleService(
      new PrismaUserLifecycleStore(prisma, new PrismaIdentityAuthorizationAdapter()),
    );
    const administrator = actor(fixture.platformAdministrator, ['platform_administrator']);
    const phoneOnlyAdministrator = {
      ...administrator,
      authenticationMethod: 'phone_otp' as const,
    };
    const nonAdministrator = actor(fixture.ownerA);

    try {
      for (const denied of [phoneOnlyAdministrator, nonAdministrator]) {
        await assert.rejects(
          service.list(denied, { lifecycle: 'current' }),
          isApplicationError('FORBIDDEN', 403),
        );
      }

      const current = await service.list(administrator, { lifecycle: 'current', limit: 100 });
      assert.ok(current.items.some(({ id, lifecycle }) =>
        id === fixture.userLifecycleTarget && lifecycle === 'current'));

      await requestContextStore.run(
        { correlationId: randomUUID(), actor: administrator },
        () => service.softDelete(
          administrator,
          fixture.userLifecycleTarget,
          'Task 13 lifecycle discovery deletion',
        ),
      );
      const deleted = await service.list(administrator, { lifecycle: 'deleted', limit: 100 });
      assert.ok(deleted.items.some(({ id, lifecycle }) =>
        id === fixture.userLifecycleTarget && lifecycle === 'deleted'));
      assert.equal(
        (await service.get(administrator, fixture.userLifecycleTarget, 'deleted')).lifecycle,
        'deleted',
      );
      await assert.rejects(
        service.get(administrator, fixture.userLifecycleTarget, 'current'),
        isApplicationError('USER_NOT_FOUND', 404),
      );

      const restored = await requestContextStore.run(
        { correlationId: randomUUID(), actor: administrator },
        () => service.restore(
          administrator,
          fixture.userLifecycleTarget,
          'Task 13 lifecycle discovery restore',
        ),
      );
      assert.equal(restored.lifecycle, 'current');
      const deactivated = await requestContextStore.run(
        { correlationId: randomUUID(), actor: administrator },
        () => service.deactivate(
          administrator,
          fixture.userLifecycleTarget,
          'Task 13 lifecycle discovery deactivation',
        ),
      );
      assert.equal(deactivated.lifecycle, 'current');
    } finally {
      await prisma.$disconnect();
    }
  });

  void it('returns stable 403 for malformed or mismatched tenant authority', async () => {
    const prisma = new PrismaService();
    const transactions = new PrismaTenantTransactionRunner(prisma);
    const audits = new PrismaAuditWriter();
    const authorization = new PrismaTenantAuthorizationExecutor(
      transactions,
      new PrismaAuthorizationPolicy(audits),
      new PrismaSecurityDenialRecorder(prisma),
    );
    const ownerA = actor(fixture.ownerA);
    const platformOnly = actor(fixture.platformAdministrator, ['platform_administrator']);

    try {
      for (const invalid of ['', 'not-a-uuid']) {
        assert.throws(
          () => transactions.run(invalid, () => Promise.resolve()),
          isApplicationError('INVALID_TENANT', 403),
        );
      }
      for (const [currentActor, vendorId] of [
        [ownerA, fixture.vendorB],
        [platformOnly, fixture.vendorA],
      ] as const) {
        await assert.rejects(
          requestContextStore.run(
            { correlationId: randomUUID(), actor: currentActor },
            () =>
              authorization.execute(
                {
                  actor: currentActor,
                  vendorId,
                  permission: 'membership:read',
                  operation: 'membership.list',
                },
                () => Promise.resolve(),
              ),
          ),
          isApplicationError('FORBIDDEN', 403),
        );
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  void it('prevents runtime role escalation and RLS or schema tampering', async () => {
    const prohibitedStatements = [
      'ALTER TABLE vendor_memberships DISABLE ROW LEVEL SECURITY',
      'ALTER POLICY vendor_memberships_tenant ON vendor_memberships USING (true)',
      'DROP POLICY vendor_memberships_tenant ON vendor_memberships',
      `CREATE SCHEMA task13_${randomUUID().replaceAll('-', '')}`,
      'SET ROLE milktrack_owner',
      'SET SESSION AUTHORIZATION milktrack_owner',
    ];
    for (const statement of prohibitedStatements) {
      await assert.rejects(runtimePool.query(statement), /permission denied|must be owner/);
    }

    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL row_security = off');
      await assert.rejects(
        client.query('SELECT id FROM vendor_memberships'),
        /query would be affected by row-level security policy/,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    const role = await runtimePool.query<{
      current_user: string;
      session_user: string;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT current_user, session_user, rolsuper, rolcreaterole,
              rolcreatedb, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
    );
    assert.deepEqual(role.rows, [
      {
        current_user: 'milktrack_app',
        session_user: 'milktrack_app',
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolbypassrls: false,
      },
    ]);
  });

  void it('keeps audits append-only and permits global audits only without tenant context', async () => {
    await assert.rejects(
      runtimePool.query("UPDATE audit_events SET action = 'task13.rewrite' WHERE id = $1", [
        fixture.auditGlobal,
      ]),
      /permission denied/,
    );
    await assert.rejects(
      runtimePool.query('DELETE FROM audit_events WHERE id = $1', [fixture.auditGlobal]),
      /permission denied/,
    );

    const globalAuditId = randomUUID();
    await runtimePool.query(
      `INSERT INTO audit_events
         (id, vendor_id, actor_user_id, action, entity_type, entity_id,
          correlation_id)
       VALUES ($1, NULL, $2, 'task13.global_allowed', 'security', $2, $3)`,
      [globalAuditId, fixture.platformAdministrator, randomUUID()],
    );
    try {
      const ownerView = await ownerPool.query<{ vendor_id: string | null }>(
        'SELECT vendor_id FROM audit_events WHERE id = $1',
        [globalAuditId],
      );
      assert.deepEqual(ownerView.rows, [{ vendor_id: null }]);
      await tenantTransaction(fixture.vendorA, async (client) => {
        const hidden = await client.query('SELECT id FROM audit_events WHERE id = $1', [
          globalAuditId,
        ]);
        assert.equal(hidden.rowCount, 0);
        await assert.rejects(
          client.query(
            `INSERT INTO audit_events
               (id, vendor_id, actor_user_id, action, entity_type, entity_id,
                correlation_id)
             VALUES ($1, NULL, $2, 'task13.global_denied', 'security', $2, $3)`,
            [randomUUID(), fixture.ownerA, randomUUID()],
          ),
          /row-level security policy/,
        );
      });
      await assert.rejects(
        runtimePool.query(
          `INSERT INTO audit_events
             (id, vendor_id, actor_user_id, action, entity_type, entity_id,
              correlation_id)
           VALUES ($1, $2, $3, 'task13.tenant_without_context', 'vendor', $2, $4)`,
          [randomUUID(), fixture.vendorA, fixture.ownerA, randomUUID()],
        ),
        /row-level security policy/,
      );
    } finally {
      await ownerPool.query('DELETE FROM audit_events WHERE id = $1', [globalAuditId]);
    }
  });
});
