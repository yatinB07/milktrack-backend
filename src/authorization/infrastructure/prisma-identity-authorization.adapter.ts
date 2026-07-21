import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { ActorMembership, VendorRole } from '../../common/context/request-context.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import {
  type AuthenticationVendorStatus,
  AuthenticationAuthorityPort,
  type IdentityAuthoritySnapshot,
  type UserLifecycleAuthorizationPort,
} from '../application/identity-authorization.port.js';

@Injectable()
export class PrismaIdentityAuthorizationAdapter
  extends AuthenticationAuthorityPort
  implements UserLifecycleAuthorizationPort
{
  async hasPhoneMembership(
    context: TransactionContext,
    userId: string,
    statuses: readonly ('active' | 'invited')[],
  ): Promise<boolean> {
    const tx = unwrapPrismaTransaction(context);
    const vendors = await tx.vendor.findMany({
      where: { status: 'active', deletedAt: null },
      select: { id: true },
    });
    for (const { id } of vendors) {
      await tx.$executeRaw`SELECT set_config('app.vendor_id', ${id}, true)`;
      const count = await tx.vendorMembership.count({
        where: {
          userId,
          role: { in: ['customer', 'delivery_agent'] },
          status: { in: [...statuses] },
          endedAt: null,
          deletedAt: null,
        },
      });
      if (count > 0) {
        await tx.$executeRaw`SELECT set_config('app.vendor_id', '', true)`;
        return true;
      }
    }
    await tx.$executeRaw`SELECT set_config('app.vendor_id', '', true)`;
    return false;
  }

  async activateInvitedPhoneMemberships(
    context: TransactionContext,
    input: Readonly<{
      userId: string;
      at: Date;
      correlationId: string;
      deviceId?: string;
      ipHash?: string;
    }>,
  ): Promise<number> {
    const tx = unwrapPrismaTransaction(context);
    const vendors = await tx.vendor.findMany({
      where: { status: 'active', deletedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let activated = 0;
    for (const { id: vendorId } of vendors) {
      await tx.$executeRaw`SELECT set_config('app.vendor_id', ${vendorId}, true)`;
      const invitations = await tx.vendorMembership.findMany({
        where: {
          userId: input.userId,
          role: { in: ['customer', 'delivery_agent'] },
          status: 'invited',
          endedAt: null,
          deletedAt: null,
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      for (const invitation of invitations) {
        const updated = await tx.vendorMembership.updateMany({
          where: {
            id: invitation.id,
            status: 'invited',
            endedAt: null,
            deletedAt: null,
          },
          data: { status: 'active', joinedAt: input.at },
        });
        if (updated.count !== 1) continue;
        activated += 1;
        await tx.auditEvent.create({
          data: {
            id: randomUUID(),
            vendorId,
            actorUserId: input.userId,
            action: 'membership.invitation_accepted',
            entityType: 'vendor_membership',
            entityId: invitation.id,
            newValue: { status: 'active' },
            correlationId: input.correlationId,
            deviceId: input.deviceId,
            ipHash: input.ipHash,
          },
        });
      }
    }
    await tx.$executeRaw`SELECT set_config('app.vendor_id', '', true)`;
    return activated;
  }

  async snapshot(
    context: TransactionContext,
    userId: string,
    vendorStatuses: readonly AuthenticationVendorStatus[],
  ): Promise<IdentityAuthoritySnapshot> {
    const tx = unwrapPrismaTransaction(context);
    const platformRoles = await tx.platformRoleAssignment.findMany({
      where: { userId, revokedAt: null },
      select: { role: true },
    });
    const vendors = await tx.vendor.findMany({
      where: { status: { in: [...vendorStatuses] }, deletedAt: null },
      select: { id: true, displayName: true },
    });
    const memberships: ActorMembership[] = [];
    // ponytail: Phase 1 scans vendors through existing RLS; replace only when profiling justifies a reviewed lookup function.
    for (const vendor of vendors) {
      await tx.$queryRaw`SELECT set_config('app.vendor_id', ${vendor.id}, true)`;
      const rows = await tx.$queryRaw<{
        id: string;
        vendor_id: string;
        role: VendorRole;
        status: ActorMembership['status'];
      }[]>`
        SELECT id, vendor_id, role, status FROM vendor_memberships
        WHERE vendor_id = ${vendor.id}::uuid AND user_id = ${userId}::uuid
          AND status = 'active' AND ended_at IS NULL AND deleted_at IS NULL
      `;
      memberships.push(
        ...rows.map((row) => ({
          id: row.id,
          vendorId: row.vendor_id,
          vendorName: vendor.displayName,
          role: row.role,
          status: row.status,
        })),
      );
    }
    await tx.$queryRaw`SELECT set_config('app.vendor_id', '', true)`;
    return {
      platformRoles: platformRoles.map(({ role }) => role),
      memberships,
    };
  }

  async lockManagedVendors(context: TransactionContext): Promise<readonly string[]> {
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vendors
      WHERE status IN ('onboarding', 'trial', 'active', 'suspended')
        AND deleted_at IS NULL
      ORDER BY id FOR UPDATE`;
    return rows.map(({ id }) => id);
  }

  async ownerCounts(
    context: TransactionContext,
    vendorIds: readonly string[],
    userId: string,
  ): Promise<
    readonly Readonly<{
      vendorId: string;
      targetIsOwner: boolean;
      count: number;
    }>[]
  > {
    const tx = unwrapPrismaTransaction(context);
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
    await tx.$executeRaw`SELECT set_config('app.vendor_id', '', true)`;
    return counts;
  }

  async lockActivePlatformAdministrators(
    context: TransactionContext,
  ): Promise<readonly string[]> {
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT pra.user_id
      FROM platform_role_assignments pra
      JOIN users u ON u.id = pra.user_id
      WHERE pra.role = 'platform_administrator' AND pra.revoked_at IS NULL
        AND u.status = 'active' AND u.deleted_at IS NULL
      ORDER BY pra.user_id
      FOR UPDATE OF pra, u`;
    return rows.map(({ user_id }) => user_id);
  }
}
