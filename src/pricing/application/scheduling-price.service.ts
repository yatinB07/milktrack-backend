import type { TransactionContext } from '../../common/application/transaction-context.js';
import { Inject, Injectable } from '@nestjs/common';
import { PricingStore } from './pricing.store.js';

export interface SchedulePriceCandidate {
  subscriptionId: string;
  householdId: string;
  productId: string;
  unitId: string;
  deliverySlotId: string;
}

export interface SchedulePriceAvailability extends SchedulePriceCandidate {
  status: 'resolved' | 'missing';
}

export abstract class SchedulingPriceService {
  abstract resolveMany(
    transaction: TransactionContext,
    vendorId: string,
    serviceDate: string,
    candidates: SchedulePriceCandidate[],
  ): Promise<readonly SchedulePriceAvailability[]>;
}

@Injectable()
export class DefaultSchedulingPriceService extends SchedulingPriceService {
  constructor(@Inject(PricingStore) private readonly prices: PricingStore) { super(); }

  resolveMany(transaction: TransactionContext, vendorId: string, serviceDate: string, candidates: SchedulePriceCandidate[]) {
    return this.prices.resolveManySchedule(transaction, vendorId, serviceDate, candidates);
  }
}
