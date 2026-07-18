import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { hasPlatformPermission } from '../../authorization/application/authorization.policy.js';
import {
  type Actor,
  requestContextStore,
} from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

export type UserResult = Readonly<{
  id: string;
  displayName: string;
  status: 'active' | 'suspended' | 'deactivated';
  locale: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export abstract class UserLifecycleService {
  abstract softDelete(actor: Actor, userId: string, reason: string): Promise<void>;
  abstract restore(actor: Actor, userId: string, reason: string): Promise<UserResult>;
}

const userFields = {
  id: true,
  displayName: true,
  status: true,
  locale: true,
  createdAt: true,
  updatedAt: true,
} as const;

function normalizedReason(reason: string): string {
  const value = reason.trim();
  if (value.length < 3 || value.length > 500) {
    throw new ApplicationError(
      'INVALID_REASON',
      'Reason must be between 3 and 500 characters',
      400,
    );
  }
  return value;
}

function requireUserManager(actor: Actor): void {
  if (
    actor.authenticationMethod !== 'administrator_mfa' ||
    !actor.platformRoles.some((role) => hasPlatformPermission(role, 'user:manage'))
  ) {
    throw new ApplicationError(
      'FORBIDDEN',
      'You are not allowed to perform this action',
      403,
    );
  }
}

@Injectable()
export class PrismaUserLifecycleService extends UserLifecycleService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async softDelete(actor: Actor, userId: string, reason: string): Promise<void> {
    requireUserManager(actor);
    if (actor.userId === userId) {
      throw new ApplicationError(
        'SELF_DELETE_FORBIDDEN',
        'You cannot delete your own user account',
        409,
      );
    }
    const reasonValue = normalizedReason(reason);
    await this.prisma.$transaction(async (tx) => {
      await this.sessionUserLock(tx, userId);
      const administrators = await tx.$queryRaw<{ user_id: string }[]>`
        SELECT pra.user_id
        FROM platform_role_assignments pra
        JOIN users u ON u.id = pra.user_id
        WHERE pra.role = 'platform_administrator' AND pra.revoked_at IS NULL
          AND u.status = 'active' AND u.deleted_at IS NULL
        ORDER BY pra.user_id
        FOR UPDATE OF pra, u`;
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      if (!locked[0]) {
        throw new ApplicationError('USER_NOT_FOUND', 'User was not found', 404);
      }
      const user = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true },
      });
      if (!user) {
        throw new ApplicationError('USER_NOT_FOUND', 'User was not found', 404);
      }
      if (
        administrators.some(({ user_id }) => user_id === userId) &&
        administrators.length === 1
      ) {
        throw new ApplicationError(
          'LAST_PLATFORM_ADMINISTRATOR',
          'The last active Platform Administrator cannot be deleted',
          409,
        );
      }
      const at = new Date();
      await tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: at,
          deletedBy: actor.userId,
          deletionReason: reasonValue,
        },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: at },
      });
      await this.audit(tx, actor, userId, 'user.deleted', reasonValue);
    });
  }

  async restore(actor: Actor, userId: string, reason: string): Promise<UserResult> {
    requireUserManager(actor);
    const reasonValue = normalizedReason(reason);
    return this.prisma.$transaction(async (tx) => {
      await this.sessionUserLock(tx, userId);
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      if (!locked[0]) {
        throw new ApplicationError('USER_NOT_FOUND', 'User was not found', 404);
      }
      const user = await tx.user.findFirst({
        where: { id: userId, deletedAt: { not: null } },
        select: { id: true },
      });
      if (!user) {
        throw new ApplicationError(
          'USER_STATE_CONFLICT',
          'User is not deleted',
          409,
        );
      }
      const restored = await tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: null,
          deletedBy: null,
          deletionReason: null,
        },
        select: userFields,
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(tx, actor, userId, 'user.restored', reasonValue);
      return restored;
    });
  }

  private async sessionUserLock(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${'session-user:' + userId}, 0))::text
    `;
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actor: Actor,
    userId: string,
    action: string,
    reason: string,
  ): Promise<void> {
    const context = requestContextStore.get();
    const correlationId = context?.correlationId ?? randomUUID();
    // Global RLS audit rows are insert-only, so this intentionally avoids RETURNING.
    await tx.$executeRaw`
      INSERT INTO audit_events
        (id, actor_user_id, action, entity_type, entity_id, reason,
         correlation_id, ip_hash, device_id)
      VALUES
        (${randomUUID()}::uuid, ${actor.userId}::uuid, ${action}, 'user',
         ${userId}::uuid, ${reason}, ${correlationId}::uuid,
         ${context?.ipHash ?? null}, ${context?.deviceId ?? null})`;
  }
}
