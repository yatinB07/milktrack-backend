import { Inject, Injectable } from '@nestjs/common';

import { ApplicationError } from '../../common/errors/application.error.js';
import type { CursorValue } from '../../common/cursor/cursor.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import { PrismaService } from '../../database/infrastructure/prisma.service.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { CreateVendorCommand } from '../application/vendor.service.js';
import type { DeliveryPolicy, UpdateDeliveryPolicyCommand } from '../domain/delivery-policy.js';
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

  async getSubscriptionTimezone(context: TransactionContext, vendorId: string) {
    const vendor = await unwrapPrismaTransaction(context).vendor.findFirst({
      where: { id: vendorId, deletedAt: null }, select: { timezone: true },
    });
    if (!vendor) throw new ApplicationError('VENDOR_NOT_FOUND', 'Vendor was not found', 404);
    return vendor;
  }

  async getPricingSettings(context: TransactionContext, vendorId: string) {
    const vendor = await unwrapPrismaTransaction(context).vendor.findFirst({
      where: { id: vendorId, deletedAt: null }, select: { timezone: true, currency: true },
    });
    if (!vendor) throw new ApplicationError('VENDOR_NOT_FOUND', 'Vendor was not found', 404);
    return vendor;
  }

  async getDeliveryPolicy(context: TransactionContext, vendorId: string): Promise<DeliveryPolicy> {
    const vendor = await unwrapPrismaTransaction(context).vendor.findFirst({ where: { id: vendorId, deletedAt: null }, select: { id: true, skipCutoffMinutes: true, lateLeavePolicy: true, captureAgentLocationEvidence: true, version: true } });
    if (!vendor) throw new ApplicationError('VENDOR_NOT_FOUND', 'Vendor was not found', 404);
    return { vendorId: vendor.id, skipCutoffMinutes: vendor.skipCutoffMinutes, lateLeavePolicy: vendor.lateLeavePolicy as DeliveryPolicy['lateLeavePolicy'], captureAgentLocationEvidence: vendor.captureAgentLocationEvidence, version: vendor.version };
  }

  async updateDeliveryPolicy(context: TransactionContext, vendorId: string, command: UpdateDeliveryPolicyCommand): Promise<Readonly<{ previous: DeliveryPolicy; updated: DeliveryPolicy }>> {
    const tx = unwrapPrismaTransaction(context);
    const [previous] = await tx.$queryRaw<DeliveryPolicy[]>(Prisma.sql`
      SELECT id AS "vendorId", skip_cutoff_minutes AS "skipCutoffMinutes",
        late_leave_policy AS "lateLeavePolicy",
        capture_agent_location_evidence AS "captureAgentLocationEvidence", version
      FROM vendors
      WHERE id=${vendorId}::uuid AND version=${command.expectedVersion} AND deleted_at IS NULL
      FOR UPDATE`);
    if (!previous) throw new ApplicationError('DELIVERY_POLICY_STATE_CONFLICT', 'Delivery policy was changed by another request', 409);
    const updated = await tx.vendor.updateMany({ where: { id: vendorId, version: command.expectedVersion, deletedAt: null }, data: { skipCutoffMinutes: command.skipCutoffMinutes, lateLeavePolicy: command.lateLeavePolicy, captureAgentLocationEvidence: command.captureAgentLocationEvidence, version: { increment: 1 } } });
    if (updated.count !== 1) throw new ApplicationError('DELIVERY_POLICY_STATE_CONFLICT', 'Delivery policy was changed by another request', 409);
    return { previous, updated: await this.getDeliveryPolicy(context, vendorId) };
  }

  async create(
    context: TransactionContext,
    vendorId: string,
    command: CreateVendorCommand,
  ): Promise<VendorRecord> {
    const tx = unwrapPrismaTransaction(context);
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
    search?: string;
  }>): Promise<Readonly<{ items: readonly VendorRecord[]; next?: CursorValue }>> {
    const search = input.search?.replace(/[\\%_]/g, '\\$&');
    const rows = await this.prisma.vendor.findMany({
      where: {
        deletedAt: null,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(search === undefined
          ? {}
          : {
              OR: [
                { code: { contains: search, mode: 'insensitive' } },
                { legalName: { contains: search, mode: 'insensitive' } },
                { displayName: { contains: search, mode: 'insensitive' } },
              ],
            }),
        ...(input.cursor === undefined
          ? {}
          : {
              AND: [
                {
                  OR: [
                    { createdAt: { lt: input.cursor.createdAt } },
                    { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
                  ],
                },
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
    context: TransactionContext,
    vendorId: string,
  ): Promise<VendorRecord> {
    const tx = unwrapPrismaTransaction(context);
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
    context: TransactionContext,
    vendorId: string,
    expectedVersion: number,
    status: VendorStatus,
  ): Promise<VendorRecord> {
    const tx = unwrapPrismaTransaction(context);
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
