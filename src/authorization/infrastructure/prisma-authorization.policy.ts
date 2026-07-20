import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import {
  type Actor,
  requestContextStore,
} from '../../common/context/request-context.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import {
  AuthorizationPolicy,
  forbid,
  hasPlatformPermission,
  hasVendorPermission,
  requireVendorOperation,
  type PlatformPermission,
  type VendorPermission,
} from '../application/authorization.policy.js';

@Injectable()
export class PrismaAuthorizationPolicy extends AuthorizationPolicy {
  constructor(@Inject(AuditWriter) private readonly audits: AuditWriter) {
    super();
  }

  requirePlatform(actor: Actor, permission: PlatformPermission): void {
    if (!actor.platformRoles.some((role) => hasPlatformPermission(role, permission))) {
      forbid();
    }
  }

  async requireVendor(
    context: TransactionContext,
    actor: Actor,
    vendorId: string,
    permission: VendorPermission,
    operation: string,
  ): Promise<void> {
    const tx = unwrapPrismaTransaction(context);
    requireVendorOperation(operation, permission);

    // Onboarding permits membership administration and a vendor's own profile;
    // other vendor operations remain unavailable until activation.
    const permittedVendorStatuses =
      operation === 'household.self-list' || operation === 'pricing.self-resolve' || operation.startsWith('subscription.self-')
        ? (['trial', 'active'] as const)
        : operation === 'vendor.profile.read' || operation.startsWith('membership.') || operation.startsWith('household.') || operation.startsWith('catalog.') || operation.startsWith('pricing.') || operation.startsWith('subscription.') || operation.startsWith('route.')
          ? (['onboarding', 'trial', 'active'] as const)
          : (['active'] as const);

    const [vendor, memberships] = await Promise.all([
      tx.vendor.findFirst({
        where: {
          id: vendorId,
          status: { in: [...permittedVendorStatuses] },
          deletedAt: null,
        },
        select: { id: true },
      }),
      tx.vendorMembership.findMany({
        where: {
          vendorId,
          userId: actor.userId,
          status: 'active',
          endedAt: null,
          deletedAt: null,
        },
        select: { role: true },
      }),
    ]);
    const authorized = memberships.some(
      ({ role }) =>
        hasVendorPermission(role, permission) &&
        (actor.authenticationMethod === 'administrator_mfa' ||
          (role !== 'vendor_owner' && role !== 'vendor_administrator')),
    );
    if (!vendor || !authorized) {
      forbid();
    }
  }

  async requireSupport(
    context: TransactionContext,
    actor: Actor,
    vendorId: string,
    scope: string,
    at: Date,
  ): Promise<void> {
    const tx = unwrapPrismaTransaction(context);
    if (!actor.platformRoles.includes('support_operations') || !scope.endsWith(':read')) {
      forbid();
    }

    const vendor = await tx.vendor.findFirst({
      where: { id: vendorId, status: 'active', deletedAt: null },
      select: { id: true },
    });
    const grants = await tx.supportAccessGrant.findMany({
      where: {
        vendorId,
        granteeUserId: actor.userId,
        accessMode: 'read',
        startsAt: { lte: at },
        expiresAt: { gt: at },
        revokedAt: null,
      },
      select: { id: true, scope: true },
    });
    const grant = grants.find(
      (candidate) =>
        Array.isArray(candidate.scope) && candidate.scope.includes(scope),
    );
    if (!vendor || !grant) forbid();

    const requestContext = requestContextStore.get();
    await this.audits.append(context, {
      id: randomUUID(),
      vendorId,
      actorUserId: actor.userId,
      action: 'support.accessed',
      entityType: 'support_access_grant',
      entityId: grant.id,
      newValue: { scope },
      correlationId: requestContext?.correlationId ?? randomUUID(),
    });
  }
}
