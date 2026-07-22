import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import type { Actor } from '../../common/context/request-context.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { NotificationWriter } from '../../notifications/application/notification-writer.js';
import { DeliveryPriceService } from '../../pricing/application/delivery-price.service.js';
import {
  canonicalizePositiveQuantity,
  requireCorrectionReason,
  requireCorrectionTransition,
} from '../domain/delivery-rules.js';
import { DeliveryStore, type DeliveryDetail, type DeliveryRecord } from './delivery.store.js';

export type CorrectDeliveryCommand = Readonly<{
  expectedVersion: number;
  replacementOutcome: 'delivered' | 'skipped_by_agent' | 'missed';
  actualQuantity?: string;
  reason: string;
}>;

export abstract class DeliveryCorrectionService {
  abstract correct(actor: Actor, vendorId: string, scheduledDeliveryId: string, command: CorrectDeliveryCommand): Promise<DeliveryDetail>;
}

@Injectable()
export class DefaultDeliveryCorrectionService extends DeliveryCorrectionService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(DeliveryStore) private readonly deliveries: DeliveryStore,
    @Inject(DeliveryPriceService) private readonly prices: DeliveryPriceService,
    @Inject(AuditWriter) private readonly audits: AuditWriter,
    @Inject(NotificationWriter) private readonly notifications: NotificationWriter,
  ) { super(); }

  correct(actor: Actor, vendorId: string, scheduledDeliveryId: string, command: CorrectDeliveryCommand): Promise<DeliveryDetail> {
    return this.authorization.execute({ actor, vendorId, permission: 'schedule:manage', operation: 'schedule.manual-generate' }, async (tx) => {
      const before = await this.deliveries.lockCorrection(tx, vendorId, scheduledDeliveryId, command.expectedVersion);
      requireCorrectionTransition(before.currentStatus, command.replacementOutcome, command.actualQuantity);
      requireCorrectionReason(command.reason);
      const actualQuantity = command.replacementOutcome === 'delivered'
        ? canonicalizePositiveQuantity(command.actualQuantity)
        : undefined;
      if (command.replacementOutcome === 'delivered' && !before.snapshot) {
        const price = await this.prices.resolve(tx, vendorId, before);
        if (!price) throw new ApplicationError('DELIVERY_PRICE_NOT_FOUND', 'Delivery price was not found', 409);
        await this.deliveries.createPriceSnapshot(tx, { vendorId, scheduledDeliveryId, ...price });
      }
      await this.deliveries.appendCorrection(tx, {
        id: randomUUID(), vendorId, scheduledDeliveryId, expectedVersion: command.expectedVersion,
        replacementOutcome: command.replacementOutcome, actualQuantity,
        actorUserId: actor.userId, occurredAt: new Date(), receivedAt: new Date(), reason: command.reason,
      });
      const after = await this.deliveries.getVendorDetail(tx, vendorId, scheduledDeliveryId);
      await this.audits.append(tx, {
        id: randomUUID(), vendorId, actorUserId: actor.userId, action: 'delivery.corrected', entityType: 'delivery', entityId: scheduledDeliveryId,
        oldValue: auditValue(before), newValue: auditValue(after), reason: command.reason,
        correlationId: requestContextStore.require().correlationId,
      });
      await Promise.all((before.customerUserIds ?? []).map((recipientUserId) => this.notifications.append(tx, {
        id: randomUUID(), vendorId, recipientUserId, type: 'delivery_corrected', payload: { scheduledDeliveryId },
      })));
      return after;
    });
  }
}

function auditValue(delivery: DeliveryRecord) {
  return {
    status: delivery.currentStatus,
    ...(delivery.actualQuantity ? { actualQuantity: delivery.actualQuantity } : {}),
    version: delivery.version,
  };
}
