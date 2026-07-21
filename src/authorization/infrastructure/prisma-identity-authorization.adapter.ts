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
    const [result] = await tx.$queryRaw<{ has_membership: boolean }[]>`
      SELECT has_phone_auth_membership(
        ${userId}::uuid,
        ${statuses.includes('active')}::boolean,
        ${statuses.includes('invited')}::boolean
      ) AS has_membership
    `;
    return result?.has_membership ?? false;
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
    const activated = await tx.$queryRaw<{ membership_id: string; vendor_id: string }[]>`
      SELECT membership_id, vendor_id
      FROM activate_invited_phone_memberships(
        ${input.userId}::uuid,
        ${input.at}::timestamptz,
        ${input.correlationId}::uuid,
        ${input.deviceId ?? null}::text,
        ${input.ipHash ?? null}::text
      )
    `;
    return activated.length;
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
    const rows = await tx.$queryRaw<{
      membership_id: string;
      vendor_id: string;
      vendor_name: string;
      membership_role: VendorRole;
      membership_status: ActorMembership['status'];
    }[]>`
      SELECT membership_id, vendor_id, vendor_name, membership_role, membership_status
      FROM authentication_authority_memberships(
        ${userId}::uuid,
        ${vendorStatuses.includes('onboarding')}::boolean,
        ${vendorStatuses.includes('trial')}::boolean,
        ${vendorStatuses.includes('active')}::boolean
      )
    `;
    const memberships: ActorMembership[] = rows.map((row) => ({
      id: row.membership_id,
      vendorId: row.vendor_id,
      vendorName: row.vendor_name,
      role: row.membership_role,
      status: row.membership_status,
    }));
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
