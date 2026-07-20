import type { TransactionContext } from '../../common/application/transaction-context.js';
import { Inject, Injectable } from '@nestjs/common';
import { SubscriptionStore } from './subscription.store.js';

export interface SubscriptionScheduleProjection {
  subscriptionId: string;
  revisionId: string;
  householdId: string;
  productId: string;
  unitId: string;
  deliverySlotId: string;
  plannedQuantity: string;
}

export abstract class SubscriptionScheduleService {
  abstract project(
    transaction: TransactionContext,
    vendorId: string,
    serviceDate: string,
  ): Promise<readonly SubscriptionScheduleProjection[]>;
}

@Injectable()
export class DefaultSubscriptionScheduleService extends SubscriptionScheduleService {
  constructor(@Inject(SubscriptionStore) private readonly subscriptions: SubscriptionStore) { super(); }

  project(transaction: TransactionContext, vendorId: string, serviceDate: string) {
    return this.subscriptions.projectSchedule(transaction, vendorId, serviceDate);
  }
}
