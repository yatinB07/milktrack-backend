import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { RecordLifecycle } from '../../common/application/record-lifecycle.js';
import type { SubscriptionOperationalStatus } from '../domain/subscription-rules.js';

export type SubscriptionRevisionRecord = Readonly<{
  id: string;
  vendorId: string;
  subscriptionId: string;
  productId: string;
  unitId: string;
  deliverySlotId: string;
  quantity: string;
  weekdays: readonly number[];
  status: SubscriptionOperationalStatus;
  effectiveFrom: string;
  effectiveTo?: string;
  createdBy: string;
  supersededAt?: Date;
  supersededByRevisionId?: string;
  supersessionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type SubscriptionAggregateRecord = Readonly<{
  id: string;
  vendorId: string;
  householdId: string;
  version: number;
  deletedAt: Date | null;
  deletedBy?: string;
  deletionReason?: string;
  createdAt: Date;
  updatedAt: Date;
  revisions: readonly SubscriptionRevisionRecord[];
}>;

export type SubscriptionPageQuery = Readonly<{
  cursor?: string;
  limit?: number;
  householdId?: string;
  productId?: string;
  deliverySlotId?: string;
  status?: 'future' | SubscriptionOperationalStatus | 'completed';
  routeId?: string;
  routeServiceDate?: string;
  lifecycle: RecordLifecycle;
}>;
export type SubscriptionStorePageQuery = Omit<SubscriptionPageQuery, 'routeId' | 'routeServiceDate'> & Readonly<{
  route?: Readonly<{ serviceDate: string; deliverySlotId: string; householdIds: readonly string[] }>;
}>;

export type SubscriptionPage = Readonly<{ items: readonly SubscriptionAggregateRecord[]; nextCursor?: string }>;
export type SubscriptionHistoryPage = Readonly<{ items: readonly SubscriptionRevisionRecord[]; nextCursor?: string }>;
export type CustomerSubscriptionRevision = Omit<SubscriptionRevisionRecord, 'createdBy' | 'supersessionReason'>;
export type CustomerSubscriptionHistoryPage = Readonly<{ items: readonly CustomerSubscriptionRevision[]; nextCursor?: string }>;
export type CreateSubscriptionAggregate = Readonly<{
  id: string; vendorId: string; householdId: string; productId: string; unitId: string; deliverySlotId: string;
  quantity: string; weekdays: readonly number[]; effectiveFrom: string; effectiveTo?: string; createdBy: string;
}>;
export type LockedSubscription = SubscriptionAggregateRecord & Readonly<{ selected: SubscriptionRevisionRecord }>;
export type ReplaceSubscriptionPlan = Readonly<{
  subscription: LockedSubscription;
  replacementRevisionId: string;
  productId: string;
  unitId: string;
  deliverySlotId: string;
  quantity: string;
  weekdays: readonly number[];
  status: SubscriptionOperationalStatus;
  effectiveFrom: string;
  effectiveTo?: string;
  reason: string;
  createdBy: string;
}>;

/** Subscription-owned persistence boundary for its root/revision/weekday aggregate. */
export abstract class SubscriptionStore {
  abstract projectSchedule(tx: TransactionContext, vendorId: string, serviceDate: string): Promise<readonly Readonly<{
    subscriptionId: string; revisionId: string; householdId: string; productId: string;
    unitId: string; deliverySlotId: string; plannedQuantity: string;
  }>[]>;
  abstract list(tx: TransactionContext, query: SubscriptionStorePageQuery, today: string, householdId?: string): Promise<SubscriptionPage>;
  abstract get(tx: TransactionContext, subscriptionId: string, lifecycle: RecordLifecycle, householdId?: string): Promise<SubscriptionAggregateRecord>;
  abstract history(tx: TransactionContext, subscriptionId: string, query: Pick<SubscriptionPageQuery, 'cursor' | 'limit'>, householdId?: string): Promise<SubscriptionHistoryPage>;
  abstract create(tx: TransactionContext, input: CreateSubscriptionAggregate): Promise<SubscriptionAggregateRecord>;
  abstract lockRoot(tx: TransactionContext, subscriptionId: string, expectedVersion: number, includeDeleted?: boolean): Promise<SubscriptionAggregateRecord>;
  abstract lockForMutation(tx: TransactionContext, subscriptionId: string, expectedVersion: number, effectiveDate: string, includeDeleted?: boolean): Promise<LockedSubscription>;
  abstract replacePlan(tx: TransactionContext, input: ReplaceSubscriptionPlan): Promise<SubscriptionAggregateRecord & Readonly<{
    replacementRevisionId: string; supersededRevisionIds: readonly string[]; supersededRevisionCount: number;
  }>>;
  abstract softDelete(tx: TransactionContext, subscriptionId: string, expectedVersion: number, actorId: string, reason: string): Promise<SubscriptionAggregateRecord>;
  abstract restore(tx: TransactionContext, subscriptionId: string, expectedVersion: number): Promise<SubscriptionAggregateRecord>;
}
