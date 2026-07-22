import { Inject, Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { DeliveryOccurrenceKey } from '../../delivery/application/delivery.store.js';
import { LeaveStore } from './leave.store.js';

export abstract class EffectiveLeaveService {
  abstract isEffectivelyOnLeave(
    tx: TransactionContext,
    key: DeliveryOccurrenceKey,
  ): Promise<boolean>;
}

@Injectable()
export class DefaultEffectiveLeaveService extends EffectiveLeaveService {
  constructor(@Inject(LeaveStore) private readonly leaves: LeaveStore) {
    super();
  }

  isEffectivelyOnLeave(tx: TransactionContext, key: DeliveryOccurrenceKey) {
    return this.leaves.isEffectivelyOnLeave(tx, key);
  }
}
