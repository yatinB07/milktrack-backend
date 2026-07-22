import { Inject, Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { LeaveStore } from './leave.store.js';

export abstract class SchedulingLeaveService {
  abstract effectiveOccurrences(
    tx: TransactionContext,
    vendorId: string,
    serviceDate: string,
    candidates: readonly Readonly<{ subscriptionId: string; deliverySlotId: string }>[],
  ): Promise<ReadonlySet<string>>;
}

@Injectable()
export class DefaultSchedulingLeaveService extends SchedulingLeaveService {
  constructor(@Inject(LeaveStore) private readonly leaves: LeaveStore) {
    super();
  }

  async effectiveOccurrences(
    tx: TransactionContext,
    vendorId: string,
    serviceDate: string,
    candidates: readonly Readonly<{ subscriptionId: string; deliverySlotId: string }>[],
  ) {
    const unique = new Map(candidates.map((candidate) => [key(candidate), candidate]));
    const effective = await Promise.all([...unique].map(async ([occurrence, candidate]) =>
      [occurrence, await this.leaves.isEffectivelyOnLeave(tx, { vendorId, serviceDate, ...candidate })] as const));
    return new Set(effective.filter(([, applies]) => applies).map(([occurrence]) => occurrence));
  }
}

const key = (candidate: Readonly<{ subscriptionId: string; deliverySlotId: string }>) =>
  `${candidate.subscriptionId}:${candidate.deliverySlotId}`;
