import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import {
  type Actor,
  requestContextStore,
  type VendorRole,
} from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import { MemberIdentityService } from '../../identity/application/member-identity.service.js';
import { normalizePhone } from '../../identity/domain/identity-normalization.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
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
  items: readonly MembershipDirectoryResult[];
  nextCursor?: string;
}>;

export type MembershipDirectoryResult = MembershipResult &
  Readonly<{ displayName: string; phone?: string; email?: string }>;

export type CustomerMembershipSummary = Readonly<{
  membershipId: string;
  userId: string;
  displayName?: string;
  phone?: string;
}>;
export type RouteAgentSummary = Readonly<{ membershipId: string }>;

export abstract class MembershipService {
  abstract requireRouteAgent(tx: TransactionContext, vendorId: string, membershipId: string): Promise<RouteAgentSummary>;
  abstract resolveSelfRouteAgent(tx: TransactionContext, vendorId: string, userId: string): Promise<RouteAgentSummary>;
  abstract requireActiveCustomerMembership(
    tx: TransactionContext,
    vendorId: string,
    membershipId: string,
  ): Promise<CustomerMembershipSummary>;
  abstract customerMembershipHistory(
    tx: TransactionContext,
    vendorId: string,
    membershipIds: readonly string[],
  ): Promise<readonly CustomerMembershipSummary[]>;
  abstract list(
    actor: Actor,
    vendorId: string,
    query: Readonly<{
      cursor?: string;
      limit?: number;
      role?: VendorRole;
      status?: 'invited' | 'active' | 'ended';
      search?: string;
    }>,
  ): Promise<MembershipPage>;
  abstract create(
    actor: Actor,
    vendorId: string,
    command: Readonly<{ userId: string; role: VendorRole }>,
  ): Promise<MembershipResult>;
  abstract onboard(
    actor: Actor,
    vendorId: string,
    command: Readonly<{ displayName: string; phone: string; role: 'customer' | 'delivery_agent' }>,
  ): Promise<MembershipDirectoryResult>;
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

function requireOnboardingRole(role: VendorRole): void {
  if (role === 'customer' || role === 'delivery_agent') {
    throw new ApplicationError(
      'MEMBERSHIP_ONBOARDING_REQUIRED',
      'Customer and delivery agent memberships must use the onboarding endpoint',
      409,
    );
  }
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
    @Inject(MemberIdentityService)
    private readonly identities: MemberIdentityService,
  ) {
    super();
  }

  requireRouteAgent(tx: TransactionContext, vendorId: string, membershipId: string) {
    return this.memberships.requireRouteAgent(tx, vendorId, membershipId);
  }

  resolveSelfRouteAgent(tx: TransactionContext, vendorId: string, userId: string) {
    return this.memberships.resolveSelfRouteAgent(tx, vendorId, userId);
  }

  requireActiveCustomerMembership(
    tx: TransactionContext,
    vendorId: string,
    membershipId: string,
  ): Promise<CustomerMembershipSummary> {
    return this.memberships.requireActiveCustomerMembership(tx, vendorId, membershipId);
  }

  customerMembershipHistory(
    tx: TransactionContext,
    vendorId: string,
    membershipIds: readonly string[],
  ): Promise<readonly CustomerMembershipSummary[]> {
    return this.memberships.customerMembershipHistory(tx, vendorId, membershipIds);
  }

  list(
    actor: Actor,
    vendorId: string,
    query: Readonly<{
      cursor?: string;
      limit?: number;
      role?: VendorRole;
      status?: 'invited' | 'active' | 'ended';
      search?: string;
    }>,
  ): Promise<MembershipPage> {
    return this.authorization.execute(
      { actor, vendorId, permission: 'membership:read', operation: 'membership.list' },
      async (tx) => {
        const wanted = query.limit ?? 25;
        const search = query.search?.trim().toLocaleLowerCase('en-IN');
        const page = await this.memberships.listActive(tx, {
          cursor: query.cursor,
          limit: search ? 100 : wanted,
          role: query.role,
          status: query.status,
        });
        const profiles = await this.identities.profiles(tx, page.items.map((item) => item.userId));
        if (!search) {
          return {
            items: page.items.flatMap((membership) => {
              const profile = profiles.get(membership.userId);
              return profile ? [{ ...result(membership), ...profile }] : [];
            }),
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          };
        }
        const matches: MembershipDirectoryResult[] = [];
        let lastExamined: MembershipRecord | undefined;
        for (const membership of page.items) {
          lastExamined = membership;
          const profile = profiles.get(membership.userId);
          const searchable = profile && [profile.displayName, profile.phone, profile.email]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLocaleLowerCase('en-IN').includes(search));
          if (profile && searchable) matches.push({ ...result(membership), ...profile });
          if (matches.length === wanted) break;
        }
        const hasMoreCandidates = Boolean(
          lastExamined && (lastExamined !== page.items.at(-1) || page.nextCursor),
        );
        return {
          items: matches,
          ...(hasMoreCandidates && lastExamined
            ? { nextCursor: this.memberships.cursorFor(lastExamined) }
            : {}),
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
        requireOnboardingRole(command.role);
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

  onboard(
    actor: Actor,
    vendorId: string,
    command: Readonly<{ displayName: string; phone: string; role: 'customer' | 'delivery_agent' }>,
  ): Promise<MembershipDirectoryResult> {
    const displayName = command.displayName.trim();
    if (displayName.length < 2 || displayName.length > 120) {
      throw new ApplicationError('INVALID_DISPLAY_NAME', 'Display name is invalid', 400);
    }
    const phone = normalizePhone(command.phone);
    return this.authorization.execute(
      { actor, vendorId, permission: 'membership:manage', operation: 'membership.onboard' },
      async (tx) => {
        const identity = await this.identities.resolvePhoneUser(tx, {
          displayName,
          phone,
          userId: randomUUID(),
          identityId: randomUUID(),
        });
        await this.memberships.lockVendor(tx);
        let membership = await this.memberships.findCurrentByUserRole(
          tx,
          identity.userId,
          command.role,
        );
        if (!membership) {
          membership = await this.memberships.createWithStatus(tx, {
            id: randomUUID(),
            vendorId,
            userId: identity.userId,
            role: command.role,
            status: identity.phoneVerified ? 'active' : 'invited',
            at: new Date(),
          });
          await this.audit(tx, actor, vendorId, membership.id, 'membership.onboarded', {
            newValue: { role: membership.role, status: membership.status },
          });
        } else if (membership.status === 'invited' && identity.phoneVerified) {
          membership = await this.memberships.activateInvitation(tx, membership.id, new Date());
          await this.audit(tx, actor, vendorId, membership.id, 'membership.invitation_accepted', {
            oldValue: { status: 'invited' },
            newValue: { status: 'active' },
          });
        }
        return {
          ...result(membership),
          displayName: identity.displayName,
          ...(identity.phone ? { phone: identity.phone } : {}),
          ...(identity.email ? { email: identity.email } : {}),
        };
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
        requireOnboardingRole(role);
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
        const current = await this.current(tx, membershipId);
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

  private async lockTarget(tx: TransactionContext, id: string): Promise<void> {
    if (!(await this.memberships.lockTarget(tx, id))) throw membershipNotFound();
  }

  private async active(
    tx: TransactionContext,
    id: string,
  ): Promise<MembershipRecord> {
    const membership = await this.memberships.findActive(tx, id);
    if (!membership) throw membershipNotFound();
    return membership;
  }

  private async current(
    tx: TransactionContext,
    id: string,
  ): Promise<MembershipRecord> {
    const membership = await this.memberships.findCurrent(tx, id);
    if (!membership) throw membershipNotFound();
    return membership;
  }

  private async requireOwner(
    tx: TransactionContext,
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
    tx: TransactionContext,
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
    tx: TransactionContext,
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
