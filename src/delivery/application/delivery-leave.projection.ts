import { Inject, Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import {
  DeliveryStore,
  type DeliveryEventSource,
  type DeliveryOccurrenceKey,
} from './delivery.store.js';

type LeaveEventSource = Extract<DeliveryEventSource, 'customer' | 'vendor_admin'>;

export abstract class DeliveryLeaveProjection {
  abstract applyCustomerLeave(
    tx: TransactionContext,
    key: DeliveryOccurrenceKey,
    actorUserId: string,
    source?: LeaveEventSource,
  ): Promise<void>;

  abstract reverseCustomerLeave(
    tx: TransactionContext,
    key: DeliveryOccurrenceKey,
    actorUserId: string,
    source?: LeaveEventSource,
  ): Promise<void>;
}

@Injectable()
export class DefaultDeliveryLeaveProjection extends DeliveryLeaveProjection {
  constructor(@Inject(DeliveryStore) private readonly deliveries: DeliveryStore) {
    super();
  }

  applyCustomerLeave(tx: TransactionContext, key: DeliveryOccurrenceKey, actorUserId: string, source?: LeaveEventSource) {
    return this.deliveries.applyCustomerLeave(tx, key, actorUserId, source);
  }

  reverseCustomerLeave(tx: TransactionContext, key: DeliveryOccurrenceKey, actorUserId: string, source?: LeaveEventSource) {
    return this.deliveries.reverseCustomerLeave(tx, key, actorUserId, source);
  }
}
