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
    if (unique.size === 0) return new Set<string>();
    const effective = await this.leaves.effectiveOccurrenceKeys(tx, {
      vendorId,
      candidates: [...unique.values()].map((candidate) => ({ ...candidate, serviceDate })),
    });
    return new Set([...unique].filter(([, candidate]) =>
      effective.has(`${serviceDate}:${key(candidate)}`)).map(([occurrence]) => occurrence));
  }
}

const key = (candidate: Readonly<{ subscriptionId: string; deliverySlotId: string }>) =>
  `${candidate.subscriptionId}:${candidate.deliverySlotId}`;
