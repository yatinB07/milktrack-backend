import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { ScheduleTarget } from '../domain/schedule-reconciliation.js';

export type ScheduleGenerationCounts = Readonly<{
  created: number; existing: number; updated: number; cancelled: number;
}>;

export type AgentScheduledDelivery = Readonly<{
  id: string;
  subscriptionId: string;
  householdId: string;
  productId: string;
  unitId: string;
  deliverySlotId: string;
  routeAssignmentId: string;
  routeStopId: string;
  serviceDate: string;
  plannedQuantity: string;
  sequence: number;
}>;

export type AgentScheduledDeliveryPage = Readonly<{
  items: readonly AgentScheduledDelivery[];
  nextCursor?: string;
}>;

export abstract class ScheduledDeliveryStore {
  abstract reconcile(
    transaction: TransactionContext,
    vendorId: string,
    serviceDate: string,
    targets: ScheduleTarget[],
  ): Promise<ScheduleGenerationCounts>;

  abstract listSelf(
    transaction: TransactionContext,
    vendorId: string,
    agentMembershipId: string,
    serviceDate: string,
    query: Readonly<{ cursor?: string; limit?: number }>,
  ): Promise<AgentScheduledDeliveryPage>;
}
