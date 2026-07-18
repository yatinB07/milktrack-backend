import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import {
  type Actor,
  requestContextStore,
} from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import {
  PrismaTenantTransactionRunner,
  type TenantTransactionRunner,
} from '../../database/tenant-transaction.runner.js';
import {
  requireVendorTransition,
  type VendorStatus,
} from '../domain/vendor-lifecycle.js';
import {
  PrismaVendorStore,
  type VendorRecord,
} from '../infrastructure/prisma-vendor.store.js';

export type TransitionVendorCommand = Readonly<{
  vendorId: string;
  to: VendorStatus;
  reason: string;
  expectedVersion: number;
}>;

export type VendorResult = VendorRecord;

@Injectable()
export class TransitionVendor {
  constructor(
    @Inject(PrismaTenantTransactionRunner)
    private readonly transactions: TenantTransactionRunner,
    private readonly vendors: PrismaVendorStore,
    private readonly audits: AuditWriter,
  ) {}

  /** Changes lifecycle state and appends its audit event in one vendor transaction. */
  async execute(
    command: TransitionVendorCommand,
    actor: Actor,
  ): Promise<VendorResult> {
    if (!actor.platformRoles.includes('platform_administrator')) {
      throw new ApplicationError(
        'FORBIDDEN',
        'You are not allowed to perform this action',
        403,
      );
    }
    const reason = command.reason.trim();
    if (reason.length < 3 || reason.length > 500) {
      throw new ApplicationError(
        'INVALID_REASON',
        'Reason must be between 3 and 500 characters',
        400,
        false,
        undefined,
        { reason: ['Reason must be between 3 and 500 characters'] },
      );
    }

    return this.transactions.run(command.vendorId, async (tx) => {
      const vendor = await this.vendors.findActive(tx, command.vendorId);
      requireVendorTransition(vendor.status, command.to);
      const updated = await this.vendors.updateStatus(
        tx,
        command.vendorId,
        command.expectedVersion,
        command.to,
      );
      const context = requestContextStore.get();
      await this.audits.append(tx, {
        id: randomUUID(),
        vendorId: command.vendorId,
        actorUserId: actor.userId,
        action: 'vendor.lifecycle_changed',
        entityType: 'vendor',
        entityId: command.vendorId,
        oldValue: { status: vendor.status },
        newValue: { status: updated.status },
        reason,
        correlationId: context?.correlationId ?? randomUUID(),
        ipHash: context?.ipHash,
        deviceId: context?.deviceId,
      });
      return updated;
    });
  }
}
