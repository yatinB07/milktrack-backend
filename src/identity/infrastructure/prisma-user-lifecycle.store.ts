import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  type UserLifecycleUnitOfWork,
  UserLifecycleStore,
} from '../application/user-lifecycle.service.js';

const userFields = {
  id: true,
  displayName: true,
  status: true,
  locale: true,
  deactivatedAt: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class PrismaUserLifecycleStore extends UserLifecycleStore {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {
    super();
  }

  run<T>(
    operation: (unit: UserLifecycleUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction((tx) => operation(this.unit(tx)));
  }

  private unit(tx: Prisma.TransactionClient): UserLifecycleUnitOfWork {
    return {
      lockSessionUser: async (userId) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${'session-user:' + userId}, 0))::text`;
      },
      lockManagedVendors: async () => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM vendors
          WHERE status IN ('onboarding', 'trial', 'active', 'suspended')
            AND deleted_at IS NULL
          ORDER BY id FOR UPDATE`;
        return rows.map(({ id }) => id);
      },
      ownerCounts: async (vendorIds, userId) => {
        const counts: Array<{
          vendorId: string;
          targetIsOwner: boolean;
          count: number;
        }> = [];
        for (const vendorId of vendorIds) {
          await tx.$executeRaw`SELECT set_config('app.vendor_id', ${vendorId}, true)`;
          const owners = await tx.vendorMembership.findMany({
            where: {
              role: 'vendor_owner',
              status: 'active',
              endedAt: null,
              deletedAt: null,
              user: { status: 'active', deletedAt: null },
            },
            select: { userId: true },
          });
          counts.push({
            vendorId,
            targetIsOwner: owners.some((owner) => owner.userId === userId),
            count: owners.length,
          });
        }
        // Global lifecycle audits require an empty tenant context after the scoped checks.
        await tx.$executeRaw`SELECT set_config('app.vendor_id', '', true)`;
        return counts;
      },
      lockActivePlatformAdministrators: async () => {
        const rows = await tx.$queryRaw<{ user_id: string }[]>`
          SELECT pra.user_id
          FROM platform_role_assignments pra
          JOIN users u ON u.id = pra.user_id
          WHERE pra.role = 'platform_administrator' AND pra.revoked_at IS NULL
            AND u.status = 'active' AND u.deleted_at IS NULL
          ORDER BY pra.user_id
          FOR UPDATE OF pra, u`;
        return rows.map(({ user_id }) => user_id);
      },
      lockUser: async (userId) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        if (!rows[0]) return null;
        return tx.user.findUnique({ where: { id: userId }, select: userFields });
      },
      softDelete: async (userId, actorId, reason, at) => {
        await tx.user.update({
          where: { id: userId },
          data: { deletedAt: at, deletedBy: actorId, deletionReason: reason },
        });
      },
      deactivate: (userId, at) =>
        tx.user.update({
          where: { id: userId },
          data: { status: 'deactivated', deactivatedAt: at },
          select: userFields,
        }),
      restore: (userId) =>
        tx.user.update({
          where: { id: userId },
          data: { deletedAt: null, deletedBy: null, deletionReason: null },
          select: userFields,
        }),
      revokeSessions: async (userId, at) => {
        await tx.session.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: at },
        });
      },
      appendAudit: async (input) => {
        // Global audit rows are insert-only under RLS; avoid RETURNING, which
        // would require a SELECT policy that intentionally does not exist.
        await tx.$executeRaw`
          INSERT INTO audit_events
            (id, actor_user_id, action, entity_type, entity_id, reason,
             correlation_id, ip_hash, device_id)
          VALUES
            (${input.id}::uuid, ${input.actorUserId}::uuid, ${input.action},
             'user', ${input.userId}::uuid, ${input.reason},
             ${input.correlationId}::uuid, ${input.ipHash ?? null},
             ${input.deviceId ?? null})`;
      },
    };
  }
}
