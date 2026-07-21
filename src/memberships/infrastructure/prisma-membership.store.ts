import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import type { VendorRole } from '../../common/context/request-context.js';
import type { RecordLifecycle } from '../../common/application/record-lifecycle.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import type {
  CustomerMembershipSummary,
  MembershipDiscoveryQuery,
  RouteAgentSummary,
} from '../application/membership.service.js';

export type MembershipRecord = Readonly<{
  id: string;
  vendorId: string;
  userId: string;
  role: VendorRole;
  status: 'invited' | 'active' | 'ended';
  joinedAt: Date | null;
  endedAt: Date | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  deletionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MembershipRecordPage = Readonly<{
  items: readonly MembershipRecord[];
  nextCursor?: string;
}>;

const resultFields = {
  id: true,
  vendorId: true,
  userId: true,
  role: true,
  status: true,
  joinedAt: true,
  endedAt: true,
  deletedAt: true,
  deletedBy: true,
  deletionReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

function prismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
function conflict(): ApplicationError {
  return new ApplicationError(
    'MEMBERSHIP_CONFLICT',
    'An active membership with this role already exists',
    409,
  );
}

@Injectable()
export class PrismaMembershipStore {
  private readonly cursors = new CursorCodec();

  async requireRouteAgent(context: TransactionContext, vendorId: string, membershipId: string): Promise<RouteAgentSummary> {
    const tx = unwrapPrismaTransaction(context);
    const locked = await tx.$queryRaw<Array<{ id: string; role: string; status: string; endedAt: Date | null }>>`
      SELECT id, role::text, status::text, ended_at AS "endedAt"
      FROM vendor_memberships
      WHERE id=${membershipId}::uuid AND vendor_id=${vendorId}::uuid AND deleted_at IS NULL
      FOR UPDATE`;
    const membership = locked[0];
    if (!membership) throw new ApplicationError('ROUTE_AGENT_NOT_FOUND', 'Route agent was not found', 404);
    if (membership.role !== 'delivery_agent' || membership.status !== 'active' || membership.endedAt)
      throw new ApplicationError('ROUTE_AGENT_NOT_AVAILABLE', 'Route agent is not available', 409);
    return { membershipId: membership.id };
  }

  async resolveSelfRouteAgent(context: TransactionContext, vendorId: string, userId: string): Promise<RouteAgentSummary> {
    const membership = await unwrapPrismaTransaction(context).vendorMembership.findFirst({
      where: { vendorId, userId, role: 'delivery_agent', status: 'active', endedAt: null, deletedAt: null },
      select: { id: true },
    });
    if (!membership) throw new ApplicationError('FORBIDDEN', 'You are not allowed to perform this action', 403);
    return { membershipId: membership.id };
  }

  async requireActiveCustomerMembership(
    context: TransactionContext,
    vendorId: string,
    membershipId: string,
  ): Promise<CustomerMembershipSummary> {
    const tx = unwrapPrismaTransaction(context);
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vendor_memberships
      WHERE id = ${membershipId}::uuid AND vendor_id = ${vendorId}::uuid
      FOR UPDATE`;
    if (locked.length === 0) {
      throw new ApplicationError('CUSTOMER_MEMBERSHIP_NOT_FOUND', 'Customer membership was not found', 404);
    }
    const membership = await tx.vendorMembership.findFirst({
      where: {
        id: membershipId, vendorId, role: 'customer', status: 'active', endedAt: null, deletedAt: null,
        user: { status: 'active', deletedAt: null, identities: { some: { type: 'phone', isPrimary: true, verifiedAt: { not: null } } } },
      },
      select: { id: true, userId: true, user: { select: { displayName: true, identities: { where: { type: 'phone', isPrimary: true, verifiedAt: { not: null } }, select: { normalizedValue: true }, take: 1 } } } },
    });
    if (!membership) {
      throw new ApplicationError('CUSTOMER_MEMBERSHIP_NOT_FOUND', 'Customer membership was not found', 404);
    }
    const phone = membership.user.identities[0]?.normalizedValue;
    return { membershipId: membership.id, userId: membership.userId, displayName: membership.user.displayName, ...(phone ? { phone } : {}) };
  }

  async customerMembershipHistory(
    context: TransactionContext,
    vendorId: string,
    membershipIds: readonly string[],
  ): Promise<readonly CustomerMembershipSummary[]> {
    if (membershipIds.length === 0) return [];
    const tx = unwrapPrismaTransaction(context);
    const memberships = await tx.vendorMembership.findMany({
      where: { vendorId, id: { in: [...membershipIds] } },
      select: { id: true, userId: true, user: { select: { displayName: true, identities: { where: { type: 'phone', isPrimary: true, verifiedAt: { not: null } }, select: { normalizedValue: true }, take: 1 } } } },
    });
    return memberships.map((membership) => {
      const phone = membership.user.identities[0]?.normalizedValue;
      return { membershipId: membership.id, userId: membership.userId, ...(membership.user.displayName ? { displayName: membership.user.displayName } : {}), ...(phone ? { phone } : {}) };
    });
  }

  async listDiscovery(
    context: TransactionContext,
    query: Omit<MembershipDiscoveryQuery, 'search'>,
  ): Promise<MembershipRecordPage> {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await tx.vendorMembership.findMany({
      where: {
        ...(query.status
          ? {
              status: query.status,
              ...(query.status === 'ended' ? {} : { endedAt: null }),
            }
          : query.lifecycle === 'current'
            ? { status: 'active' as const, endedAt: null }
            : {}),
        deletedAt: query.lifecycle === 'current' ? null : { not: null },
        ...(query.role ? { role: query.role } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: resultFields,
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

  getDiscovery(
    context: TransactionContext,
    id: string,
    lifecycle: RecordLifecycle,
  ): Promise<MembershipRecord | null> {
    return unwrapPrismaTransaction(context).vendorMembership.findFirst({
      where: {
        id,
        deletedAt: lifecycle === 'current' ? null : { not: null },
      },
      select: resultFields,
    });
  }

  cursorFor(record: MembershipRecord): string {
    return this.cursors.encode({ createdAt: record.createdAt, id: record.id });
  }

  findActive(
    context: TransactionContext,
    id: string,
  ): Promise<MembershipRecord | null> {
    const tx = unwrapPrismaTransaction(context);
    return tx.vendorMembership.findFirst({
      where: { id, status: 'active', endedAt: null, deletedAt: null },
      select: resultFields,
    });
  }

  findCurrent(
    context: TransactionContext,
    id: string,
  ): Promise<MembershipRecord | null> {
    return unwrapPrismaTransaction(context).vendorMembership.findFirst({
      where: { id, status: { in: ['active', 'invited'] }, endedAt: null, deletedAt: null },
      select: resultFields,
    });
  }

  findIncludingDeleted(
    context: TransactionContext,
    id: string,
  ): Promise<MembershipRecord | null> {
    const tx = unwrapPrismaTransaction(context);
    return tx.vendorMembership.findFirst({ where: { id }, select: resultFields });
  }

  findCurrentByUserRole(
    context: TransactionContext,
    userId: string,
    role: 'customer' | 'delivery_agent',
  ): Promise<MembershipRecord | null> {
    return unwrapPrismaTransaction(context).vendorMembership.findFirst({
      where: { userId, role, endedAt: null, deletedAt: null },
      select: resultFields,
    });
  }

  async createWithStatus(
    context: TransactionContext,
    input: Readonly<{
      id: string;
      vendorId: string;
      userId: string;
      role: 'customer' | 'delivery_agent';
      status: 'invited' | 'active';
      at: Date;
    }>,
  ): Promise<MembershipRecord> {
    try {
      return await unwrapPrismaTransaction(context).vendorMembership.create({
        data: {
          id: input.id,
          vendorId: input.vendorId,
          userId: input.userId,
          role: input.role,
          status: input.status,
          joinedAt: input.status === 'active' ? input.at : null,
        },
        select: resultFields,
      });
    } catch (error) {
      if (prismaCode(error, 'P2002')) throw conflict();
      throw error;
    }
  }

  activateInvitation(
    context: TransactionContext,
    id: string,
    at: Date,
  ): Promise<MembershipRecord> {
    return unwrapPrismaTransaction(context).vendorMembership.update({
      where: { id },
      data: { status: 'active', joinedAt: at },
      select: resultFields,
    });
  }

  async create(
    context: TransactionContext,
    input: Readonly<{
      id: string;
      vendorId: string;
      userId: string;
      role: VendorRole;
      at: Date;
    }>,
  ): Promise<MembershipRecord> {
    const tx = unwrapPrismaTransaction(context);
    try {
      return await tx.vendorMembership.create({
        data: {
          id: input.id,
          vendorId: input.vendorId,
          userId: input.userId,
          role: input.role,
          status: 'active',
          joinedAt: input.at,
        },
        select: resultFields,
      });
    } catch (error) {
      if (prismaCode(error, 'P2002')) throw conflict();
      if (prismaCode(error, 'P2003')) {
        throw new ApplicationError('USER_NOT_FOUND', 'User was not found', 404);
      }
      throw error;
    }
  }

  async updateRole(
    context: TransactionContext,
    id: string,
    role: VendorRole,
  ): Promise<MembershipRecord> {
    const tx = unwrapPrismaTransaction(context);
    try {
      return await tx.vendorMembership.update({
        where: { id },
        data: { role },
        select: resultFields,
      });
    } catch (error) {
      if (prismaCode(error, 'P2002')) throw conflict();
      throw error;
    }
  }

  end(
    context: TransactionContext,
    id: string,
    at: Date,
  ): Promise<MembershipRecord> {
    const tx = unwrapPrismaTransaction(context);
    return tx.vendorMembership.update({
      where: { id },
      data: { status: 'ended', endedAt: at },
      select: resultFields,
    });
  }

  softDelete(
    context: TransactionContext,
    id: string,
    actorId: string,
    reason: string,
    at: Date,
  ): Promise<MembershipRecord> {
    const tx = unwrapPrismaTransaction(context);
    return tx.vendorMembership.update({
      where: { id },
      data: { deletedAt: at, deletedBy: actorId, deletionReason: reason },
      select: resultFields,
    });
  }

  async restore(
    context: TransactionContext,
    id: string,
  ): Promise<MembershipRecord> {
    const tx = unwrapPrismaTransaction(context);
    try {
      return await tx.vendorMembership.update({
        where: { id },
        data: { deletedAt: null, deletedBy: null, deletionReason: null },
        select: resultFields,
      });
    } catch (error) {
      if (prismaCode(error, 'P2002')) throw conflict();
      throw error;
    }
  }

  async lockTarget(context: TransactionContext, id: string): Promise<boolean> {
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vendor_memberships WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 1;
  }

  async lockVendor(context: TransactionContext): Promise<void> {
    const tx = unwrapPrismaTransaction(context);
    await tx.$queryRaw`
      SELECT id FROM vendors
      WHERE id = current_setting('app.vendor_id')::uuid FOR UPDATE`;
  }

  async lockActiveOwners(context: TransactionContext): Promise<number> {
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT vm.id FROM vendor_memberships vm
      JOIN users u ON u.id = vm.user_id
      WHERE vm.role = 'vendor_owner' AND vm.status = 'active'
        AND vm.ended_at IS NULL AND vm.deleted_at IS NULL
        AND u.status = 'active' AND u.deleted_at IS NULL
      ORDER BY vm.id FOR UPDATE OF vm, u`;
    return rows.length;
  }

  async actorHasActiveOwner(
    context: TransactionContext,
    userId: string,
  ): Promise<boolean> {
    const tx = unwrapPrismaTransaction(context);
    return (
      (await tx.vendorMembership.count({
        where: {
          userId,
          role: 'vendor_owner',
          status: 'active',
          endedAt: null,
          deletedAt: null,
          user: { status: 'active', deletedAt: null },
        },
      })) > 0
    );
  }
}
