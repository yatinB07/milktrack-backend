import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import {
  type Actor,
  requestContextStore,
} from '../../common/context/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
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
  constructor(private readonly audits: AuditWriter) {
    super();
  }

  requirePlatform(actor: Actor, permission: PlatformPermission): void {
    if (!actor.platformRoles.some((role) => hasPlatformPermission(role, permission))) {
      forbid();
    }
  }

  async requireVendor(
    tx: Prisma.TransactionClient,
    actor: Actor,
    vendorId: string,
    permission: VendorPermission,
    operation: string,
  ): Promise<void> {
    requireVendorOperation(operation, permission);

    const [vendor, membership] = await Promise.all([
      tx.vendor.findFirst({
        where: { id: vendorId, status: 'active', deletedAt: null },
        select: { id: true },
      }),
      tx.vendorMembership.findFirst({
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
    if (!vendor || !membership || !hasVendorPermission(membership.role, permission)) {
      forbid();
    }
  }

  async requireSupport(
    tx: Prisma.TransactionClient,
    actor: Actor,
    vendorId: string,
    scope: string,
    at: Date,
  ): Promise<void> {
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

    const context = requestContextStore.get();
    await this.audits.append(tx, {
      id: randomUUID(),
      vendorId,
      actorUserId: actor.userId,
      action: 'support.accessed',
      entityType: 'support_access_grant',
      entityId: grant.id,
      newValue: { scope },
      correlationId: context?.correlationId ?? randomUUID(),
    });
  }
}
