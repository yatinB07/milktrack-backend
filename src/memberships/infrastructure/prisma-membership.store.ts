import { Injectable } from '@nestjs/common';

import { CursorCodec } from '../../common/cursor/cursor.js';
import type { VendorRole } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import type { Prisma } from '../../generated/prisma/client.js';

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
    tx: Prisma.TransactionClient,
    query: Readonly<{ cursor?: string; limit?: number }>,
  ): Promise<MembershipRecordPage> {
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
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<MembershipRecord | null> {
    return tx.vendorMembership.findFirst({
      where: { id, status: 'active', endedAt: null, deletedAt: null },
      select: resultFields,
    });
  }

  findIncludingDeleted(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<MembershipRecord | null> {
    return tx.vendorMembership.findFirst({ where: { id }, select: resultFields });
  }

  async create(
    tx: Prisma.TransactionClient,
    input: Readonly<{
      id: string;
      vendorId: string;
      userId: string;
      role: VendorRole;
      at: Date;
    }>,
  ): Promise<MembershipRecord> {
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
    tx: Prisma.TransactionClient,
    id: string,
    role: VendorRole,
  ): Promise<MembershipRecord> {
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
    tx: Prisma.TransactionClient,
    id: string,
    at: Date,
  ): Promise<MembershipRecord> {
    return tx.vendorMembership.update({
      where: { id },
      data: { status: 'ended', endedAt: at },
      select: resultFields,
    });
  }

  softDelete(
    tx: Prisma.TransactionClient,
    id: string,
    actorId: string,
    reason: string,
    at: Date,
  ): Promise<MembershipRecord> {
    return tx.vendorMembership.update({
      where: { id },
      data: { deletedAt: at, deletedBy: actorId, deletionReason: reason },
      select: resultFields,
    });
  }

  async restore(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<MembershipRecord> {
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

  async lockTarget(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vendor_memberships WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length === 1;
  }

  async lockActiveOwners(tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vendor_memberships
      WHERE role = 'vendor_owner' AND status = 'active'
        AND ended_at IS NULL AND deleted_at IS NULL
      ORDER BY id FOR UPDATE`;
    return rows.length;
  }

  async actorHasActiveOwner(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<boolean> {
    return (
      (await tx.vendorMembership.count({
        where: {
          userId,
          role: 'vendor_owner',
          status: 'active',
          endedAt: null,
          deletedAt: null,
        },
      })) > 0
    );
  }
}
