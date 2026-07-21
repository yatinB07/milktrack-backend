import { Inject, Injectable } from '@nestjs/common';

import { UserLifecycleAuthorizationPort } from '../../authorization/application/identity-authorization.port.js';
import { PrismaService } from '../../database/infrastructure/prisma.service.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import type { RecordLifecycle } from '../../common/application/record-lifecycle.js';
import { wrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  type UserLifecycleUnitOfWork,
  type PlatformUserDiscoveryQuery,
  type UserLifecycleRecord,
  type UserLifecycleRecordPage,
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
  private readonly cursors = new CursorCodec();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(UserLifecycleAuthorizationPort)
    private readonly authority: UserLifecycleAuthorizationPort,
  ) {
    super();
  }

  async listUsers(query: PlatformUserDiscoveryQuery): Promise<UserLifecycleRecordPage> {
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await this.prisma.user.findMany({
      where: {
        deletedAt: query.lifecycle === 'current' ? null : { not: null },
        ...(cursor ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: userFields,
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last
        ? { nextCursor: this.cursors.encode({ createdAt: last.createdAt, id: last.id }) }
        : {}),
    };
  }

  findUser(userId: string, lifecycle: RecordLifecycle): Promise<UserLifecycleRecord | null> {
    return this.prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: lifecycle === 'current' ? null : { not: null },
      },
      select: userFields,
    });
  }

  run<T>(
    operation: (unit: UserLifecycleUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction((tx) => operation(this.unit(tx)));
  }

  private unit(tx: Prisma.TransactionClient): UserLifecycleUnitOfWork {
    const context = wrapPrismaTransaction(tx);
    return {
      lockSessionUser: async (userId) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${'session-user:' + userId}, 0))::text`;
      },
      lockManagedVendors: () => this.authority.lockManagedVendors(context),
      ownerCounts: (vendorIds, userId) =>
        this.authority.ownerCounts(context, vendorIds, userId),
      lockActivePlatformAdministrators: () =>
        this.authority.lockActivePlatformAdministrators(context),
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
