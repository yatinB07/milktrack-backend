import { Injectable } from '@nestjs/common';

import { ApplicationError } from '../../common/errors/application.error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  type AppendAuditEvent,
  AuditWriter,
} from '../application/audit-writer.js';

const PROHIBITED_KEY = /password|otp|token|secret/i;

@Injectable()
export class PrismaAuditWriter extends AuditWriter {
  async append(
    tx: Prisma.TransactionClient,
    event: AppendAuditEvent,
  ): Promise<void> {
    const oldValue = this.toJsonValue(event.oldValue);
    const newValue = this.toJsonValue(event.newValue);
    this.assertRedacted(oldValue);
    this.assertRedacted(newValue);

    await tx.auditEvent.create({
      data: {
        id: event.id,
        vendorId: event.vendorId,
        actorUserId: event.actorUserId,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        oldValue,
        newValue,
        reason: event.reason,
        correlationId: event.correlationId,
        ipHash: event.ipHash,
        deviceId: event.deviceId,
      },
    });
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
    const json = JSON.stringify(value);
    return json === undefined
      ? undefined
      : (JSON.parse(json) as Prisma.InputJsonValue);
  }

  private assertRedacted(value: unknown): void {
    if (value === null || typeof value !== 'object') return;

    for (const [key, nestedValue] of Object.entries(value)) {
      if (PROHIBITED_KEY.test(key)) {
        throw new ApplicationError(
          'AUDIT_SECRET_REJECTED',
          'Audit data contains a prohibited field',
          500,
        );
      }
      this.assertRedacted(nestedValue);
    }
  }
}
