import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import {
  type Actor,
  requestContextStore,
  type VendorRole,
} from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  type MembershipRecord,
  PrismaMembershipStore,
} from '../infrastructure/prisma-membership.store.js';

export type MembershipResult = Readonly<{
  id: string;
  vendorId: string;
  userId: string;
  role: VendorRole;
  status: 'invited' | 'active' | 'ended';
  joinedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MembershipPage = Readonly<{
  items: readonly MembershipResult[];
  nextCursor?: string;
}>;

export abstract class MembershipService {
  abstract list(
    actor: Actor,
    vendorId: string,
    query: Readonly<{ cursor?: string; limit?: number }>,
  ): Promise<MembershipPage>;
  abstract create(
    actor: Actor,
    vendorId: string,
    command: Readonly<{ userId: string; role: VendorRole }>,
  ): Promise<MembershipResult>;
  abstract updateRole(
    actor: Actor,
    vendorId: string,
    membershipId: string,
    role: VendorRole,
  ): Promise<MembershipResult>;
  abstract end(
    actor: Actor,
    vendorId: string,
    membershipId: string,
    reason: string,
  ): Promise<MembershipResult>;
  abstract softDelete(
    actor: Actor,
    vendorId: string,
    membershipId: string,
    reason: string,
  ): Promise<void>;
  abstract restore(
    actor: Actor,
    vendorId: string,
    membershipId: string,
    reason: string,
  ): Promise<MembershipResult>;
}

function result(record: MembershipRecord): MembershipResult {
  return {
    id: record.id,
    vendorId: record.vendorId,
    userId: record.userId,
    role: record.role,
    status: record.status,
    ...(record.joinedAt ? { joinedAt: record.joinedAt } : {}),
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function reasonValue(reason: string): string {
  const value = reason.trim();
  if (value.length < 3 || value.length > 500) {
    throw new ApplicationError(
      'INVALID_REASON',
      'Reason must be between 3 and 500 characters',
      400,
      false,
      undefined,
      { reason: ['Reason must be between 3 and 500 characters'] },
    );
  }
  return value;
}

function membershipNotFound(): ApplicationError {
  return new ApplicationError(
    'MEMBERSHIP_NOT_FOUND',
    'Membership was not found',
    404,
  );
}

@Injectable()
export class PrismaMembershipService extends MembershipService {
  constructor(
    @Inject(TenantAuthorizationExecutor)
    private readonly authorization: TenantAuthorizationExecutor,
    @Inject(PrismaMembershipStore)
    private readonly memberships: PrismaMembershipStore,
    @Inject(AuditWriter)
    private readonly audits: AuditWriter,
  ) {
    super();
  }

  list(
    actor: Actor,
    vendorId: string,
    query: Readonly<{ cursor?: string; limit?: number }>,
  ): Promise<MembershipPage> {
    return this.authorization.execute(
      { actor, vendorId, permission: 'membership:read', operation: 'membership.list' },
      async (tx) => {
        const page = await this.memberships.listActive(tx, query);
        return {
          items: page.items.map(result),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      },
    );
  }

  create(
    actor: Actor,
    vendorId: string,
    command: Readonly<{ userId: string; role: VendorRole }>,
  ): Promise<MembershipResult> {
    return this.authorization.execute(
      { actor, vendorId, permission: 'membership:manage', operation: 'membership.create' },
      async (tx) => {
        if (command.role === 'vendor_owner') {
          await this.memberships.lockVendor(tx);
          await this.requireOwner(tx, actor);
        }
        const created = await this.memberships.create(tx, {
          id: randomUUID(),
          vendorId,
          userId: command.userId,
          role: command.role,
          at: new Date(),
        });
        await this.audit(tx, actor, vendorId, created.id, 'membership.created', {
          newValue: { role: created.role, status: created.status },
        });
        return result(created);
      },
    );
  }

  updateRole(
    actor: Actor,
    vendorId: string,
    membershipId: string,
    role: VendorRole,
  ): Promise<MembershipResult> {
    return this.authorization.execute(
      { actor, vendorId, permission: 'membership:manage', operation: 'membership.update-role' },
      async (tx) => {
        await this.memberships.lockVendor(tx);
        const ownerCount = await this.memberships.lockActiveOwners(tx);
        await this.lockTarget(tx, membershipId);
        const current = await this.active(tx, membershipId);
        if (current.role === 'vendor_owner' || role === 'vendor_owner') {
          await this.requireOwner(tx, actor, ownerCount);
          if (current.role === 'vendor_owner' && role !== 'vendor_owner' && ownerCount === 1) {
            throw new ApplicationError(
              'LAST_VENDOR_OWNER',
              'The last active Vendor Owner cannot be removed',
              409,
            );
          }
        }
        const updated = await this.memberships.updateRole(tx, membershipId, role);
        await this.audit(tx, actor, vendorId, membershipId, 'membership.role_changed', {
          oldValue: { role: current.role },
          newValue: { role: updated.role },
        });
        return result(updated);
      },
    );
  }

  end(
    actor: Actor,
    vendorId: string,
    membershipId: string,
    reason: string,
  ): Promise<MembershipResult> {
    const normalizedReason = reasonValue(reason);
    return this.authorization.execute(
      { actor, vendorId, permission: 'membership:manage', operation: 'membership.end' },
      async (tx) => {
        await this.memberships.lockVendor(tx);
        const ownerCount = await this.memberships.lockActiveOwners(tx);
        await this.lockTarget(tx, membershipId);
        const current = await this.active(tx, membershipId);
        await this.protectOwnerRemoval(tx, actor, current, ownerCount);
        const ended = await this.memberships.end(tx, membershipId, new Date());
        await this.audit(tx, actor, vendorId, membershipId, 'membership.ended', {
          oldValue: { status: current.status },
          newValue: { status: ended.status },
          reason: normalizedReason,
        });
        return result(ended);
      },
    );
  }

  async softDelete(
    actor: Actor,
    vendorId: string,
    membershipId: string,
    reason: string,
  ): Promise<void> {
    const normalizedReason = reasonValue(reason);
    await this.authorization.execute(
      { actor, vendorId, permission: 'membership:manage', operation: 'membership.delete' },
      async (tx) => {
        await this.memberships.lockVendor(tx);
        const ownerCount = await this.memberships.lockActiveOwners(tx);
        await this.lockTarget(tx, membershipId);
        const current = await this.active(tx, membershipId);
        await this.protectOwnerRemoval(tx, actor, current, ownerCount);
        await this.memberships.softDelete(
          tx,
          membershipId,
          actor.userId,
          normalizedReason,
          new Date(),
        );
        await this.audit(tx, actor, vendorId, membershipId, 'membership.deleted', {
          oldValue: { role: current.role, status: current.status },
          reason: normalizedReason,
        });
      },
    );
  }

  restore(
    actor: Actor,
    vendorId: string,
    membershipId: string,
    reason: string,
  ): Promise<MembershipResult> {
    const normalizedReason = reasonValue(reason);
    return this.authorization.execute(
      { actor, vendorId, permission: 'membership:manage', operation: 'membership.restore' },
      async (tx) => {
        await this.memberships.lockVendor(tx);
        const ownerCount = await this.memberships.lockActiveOwners(tx);
        await this.lockTarget(tx, membershipId);
        const current = await this.memberships.findIncludingDeleted(tx, membershipId);
        if (!current) throw membershipNotFound();
        if (!current.deletedAt) {
          throw new ApplicationError(
            'MEMBERSHIP_STATE_CONFLICT',
            'Membership is not deleted',
            409,
          );
        }
        if (current.role === 'vendor_owner') {
          await this.requireOwner(tx, actor, ownerCount);
        }
        const restored = await this.memberships.restore(tx, membershipId);
        await this.audit(tx, actor, vendorId, membershipId, 'membership.restored', {
          newValue: { role: restored.role, status: restored.status },
          reason: normalizedReason,
        });
        return result(restored);
      },
    );
  }

  private async lockTarget(tx: Prisma.TransactionClient, id: string): Promise<void> {
    if (!(await this.memberships.lockTarget(tx, id))) throw membershipNotFound();
  }

  private async active(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<MembershipRecord> {
    const membership = await this.memberships.findActive(tx, id);
    if (!membership) throw membershipNotFound();
    return membership;
  }

  private async requireOwner(
    tx: Prisma.TransactionClient,
    actor: Actor,
    lockedOwnerCount?: number,
  ): Promise<number> {
    const ownerCount =
      lockedOwnerCount ?? (await this.memberships.lockActiveOwners(tx));
    if (!(await this.memberships.actorHasActiveOwner(tx, actor.userId))) {
      throw new ApplicationError(
        'FORBIDDEN',
        'You are not allowed to perform this action',
        403,
      );
    }
    return ownerCount;
  }

  private async protectOwnerRemoval(
    tx: Prisma.TransactionClient,
    actor: Actor,
    target: MembershipRecord,
    ownerCount: number,
  ): Promise<void> {
    if (target.role !== 'vendor_owner') return;
    await this.requireOwner(tx, actor, ownerCount);
    if (ownerCount === 1) {
      throw new ApplicationError(
        'LAST_VENDOR_OWNER',
        'The last active Vendor Owner cannot be removed',
        409,
      );
    }
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actor: Actor,
    vendorId: string,
    entityId: string,
    action: string,
    change: Readonly<{
      oldValue?: unknown;
      newValue?: unknown;
      reason?: string;
    }>,
  ): Promise<void> {
    const context = requestContextStore.get();
    await this.audits.append(tx, {
      id: randomUUID(),
      vendorId,
      actorUserId: actor.userId,
      action,
      entityType: 'vendor_membership',
      entityId,
      ...change,
      correlationId: context?.correlationId ?? randomUUID(),
      ipHash: context?.ipHash,
      deviceId: context?.deviceId,
    });
  }
}
