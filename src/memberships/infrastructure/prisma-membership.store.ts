import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import type { VendorRole } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';

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

  async listActive(
    context: TransactionContext,
    query: Readonly<{ cursor?: string; limit?: number }>,
  ): Promise<MembershipRecordPage> {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await tx.vendorMembership.findMany({
      where: {
        status: 'active',
        endedAt: null,
        deletedAt: null,
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

  findIncludingDeleted(
    context: TransactionContext,
    id: string,
  ): Promise<MembershipRecord | null> {
    const tx = unwrapPrismaTransaction(context);
    return tx.vendorMembership.findFirst({ where: { id }, select: resultFields });
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
