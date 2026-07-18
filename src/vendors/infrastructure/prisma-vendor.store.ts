import { Inject, Injectable } from '@nestjs/common';

import { ApplicationError } from '../../common/errors/application.error.js';
import type { CursorValue } from '../../common/cursor/cursor.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { CreateVendorCommand } from '../application/vendor.service.js';
import type { VendorStatus } from '../domain/vendor-lifecycle.js';

export type VendorRecord = Readonly<{
  id: string;
  code: string;
  legalName: string;
  displayName: string;
  status: VendorStatus;
  timezone: string;
  currency: string;
  skipCutoffMinutes: number;
  billingDay: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

const resultFields = {
  id: true,
  code: true,
  legalName: true,
  displayName: true,
  status: true,
  timezone: true,
  currency: true,
  skipCutoffMinutes: true,
  billingDay: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class PrismaVendorStore {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(
    tx: Prisma.TransactionClient,
    vendorId: string,
    command: CreateVendorCommand,
  ): Promise<VendorRecord> {
    try {
      return await tx.vendor.create({
        data: { id: vendorId, ...command },
        select: resultFields,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        throw new ApplicationError(
          'VENDOR_CODE_CONFLICT',
          'An active vendor already uses this code',
          409,
        );
      }
      throw error;
    }
  }

  async listActive(input: Readonly<{
    limit: number;
    cursor?: CursorValue;
    status?: VendorStatus;
  }>): Promise<Readonly<{ items: readonly VendorRecord[]; next?: CursorValue }>> {
    const rows = await this.prisma.vendor.findMany({
      where: {
        deletedAt: null,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.cursor.createdAt } },
                { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
              ],
            }),
      },
      select: resultFields,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    });
    const items = rows.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length <= input.limit || last === undefined
        ? {}
        : { next: { createdAt: last.createdAt, id: last.id } }),
    };
  }

  async getActive(vendorId: string): Promise<VendorRecord> {
    const vendor = await this.prisma.vendor.findFirst({
      where: { id: vendorId, deletedAt: null },
      select: resultFields,
    });
    if (!vendor) {
      throw new ApplicationError('VENDOR_NOT_FOUND', 'Vendor was not found', 404);
    }
    return vendor;
  }

  async findActive(
    tx: Prisma.TransactionClient,
    vendorId: string,
  ): Promise<VendorRecord> {
    const vendor = await tx.vendor.findFirst({
      where: { id: vendorId, deletedAt: null },
      select: resultFields,
    });
    if (!vendor) {
      throw new ApplicationError('VENDOR_NOT_FOUND', 'Vendor was not found', 404);
    }
    return vendor;
  }

  async updateStatus(
    tx: Prisma.TransactionClient,
    vendorId: string,
    expectedVersion: number,
    status: VendorStatus,
  ): Promise<VendorRecord> {
    const updated = await tx.vendor.updateMany({
      where: { id: vendorId, version: expectedVersion, deletedAt: null },
      data: { status, version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw new ApplicationError(
        'VENDOR_STATE_CONFLICT',
        'Vendor was changed by another request',
        409,
      );
    }
    return tx.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: resultFields,
    });
  }
}
