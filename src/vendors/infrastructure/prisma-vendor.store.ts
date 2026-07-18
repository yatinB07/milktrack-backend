import { Injectable } from '@nestjs/common';

import { ApplicationError } from '../../common/errors/application.error.js';
import type { Prisma } from '../../generated/prisma/client.js';
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
