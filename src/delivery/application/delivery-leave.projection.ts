import { Inject, Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import {
  DeliveryStore,
  type DeliveryOccurrenceKey,
} from './delivery.store.js';

export abstract class DeliveryLeaveProjection {
  abstract applyCustomerLeave(
    tx: TransactionContext,
    key: DeliveryOccurrenceKey,
    actorUserId: string,
  ): Promise<void>;

  abstract reverseCustomerLeave(
    tx: TransactionContext,
    key: DeliveryOccurrenceKey,
    actorUserId: string,
  ): Promise<void>;
}

@Injectable()
export class DefaultDeliveryLeaveProjection extends DeliveryLeaveProjection {
  constructor(@Inject(DeliveryStore) private readonly deliveries: DeliveryStore) {
    super();
  }

  applyCustomerLeave(tx: TransactionContext, key: DeliveryOccurrenceKey, actorUserId: string) {
    return this.deliveries.applyCustomerLeave(tx, key, actorUserId);
  }

  reverseCustomerLeave(tx: TransactionContext, key: DeliveryOccurrenceKey, actorUserId: string) {
    return this.deliveries.reverseCustomerLeave(tx, key, actorUserId);
  }
}
