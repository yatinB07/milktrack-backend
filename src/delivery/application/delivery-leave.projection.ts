import { Inject, Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import {
  DeliveryStore,
  type DeliveryLeaveActor,
  type DeliveryLeaveCandidatePage,
  type DeliveryLeaveSelection,
  type DeliveryLeaveState,
  type DeliveryEventSource,
  type DeliveryOccurrenceKey,
} from './delivery.store.js';

type LeaveEventSource = Extract<DeliveryEventSource, 'customer' | 'vendor_admin'>;

export abstract class DeliveryLeaveProjection {
  abstract listAffected(
    tx: TransactionContext,
    vendorId: string,
    selections: readonly DeliveryLeaveSelection[],
    query: Readonly<{ cursor?: string; limit?: number }>,
  ): Promise<DeliveryLeaveCandidatePage>;

  abstract synchronize(
    tx: TransactionContext,
    actor: DeliveryLeaveActor,
    states: readonly DeliveryLeaveState[],
  ): Promise<Readonly<{ agentMembershipIds: readonly string[] }>>;

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

  listAffected(
    tx: TransactionContext,
    vendorId: string,
    selections: readonly DeliveryLeaveSelection[],
    query: Readonly<{ cursor?: string; limit?: number }>,
  ) {
    return this.deliveries.listAffected(tx, vendorId, selections, query);
  }

  synchronize(tx: TransactionContext, actor: DeliveryLeaveActor, states: readonly DeliveryLeaveState[]) {
    return this.deliveries.synchronizeLeave(tx, actor, states);
  }

  applyCustomerLeave(tx: TransactionContext, key: DeliveryOccurrenceKey, actorUserId: string, source?: LeaveEventSource) {
    return this.deliveries.applyCustomerLeave(tx, key, actorUserId, source);
  }

  reverseCustomerLeave(tx: TransactionContext, key: DeliveryOccurrenceKey, actorUserId: string, source?: LeaveEventSource) {
    return this.deliveries.reverseCustomerLeave(tx, key, actorUserId, source);
  }
}
