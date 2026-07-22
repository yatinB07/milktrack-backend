import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { ScheduleTarget } from '../domain/schedule-reconciliation.js';

export type ScheduleGenerationCounts = Readonly<{
  created: number; existing: number; updated: number; cancelled: number;
}>;

export type ScheduledDeliveryRecord = Readonly<{
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

export type AgentScheduledDelivery = ScheduledDeliveryRecord & Readonly<{
  routeId: string;
  routeCode: string;
  routeName: string;
  householdAccountNumber: string;
  householdName: string;
  addressLine1: string;
  addressLine2?: string;
  locality?: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  productCode: string;
  productName: string;
  unitCode: string;
  unitName: string;
  deliverySlotName: string;
  deliverySlotStartLocalTime: string;
  deliverySlotEndLocalTime: string;
  currentStatus: 'scheduled' | 'delivered' | 'skipped_by_customer' | 'skipped_by_agent' | 'missed';
  version: number;
  blockedByCustomerLeave: boolean;
  captureLocationEvidence: boolean;
  pendingStopItems: readonly AgentPendingStopItem[];
}>;

export type AgentPendingStopItem = Readonly<{
  scheduledDeliveryId: string;
  expectedVersion: number;
  plannedQuantity: string;
  productName: string;
  unitName: string;
}>;

export type AgentScheduledDeliveryPage = Readonly<{
  serviceDate: string;
  items: readonly AgentScheduledDelivery[];
  nextCursor?: string;
}>;

export abstract class ScheduledDeliveryStore {
  abstract reconcile(
    transaction: TransactionContext,
    vendorId: string,
    serviceDate: string,
    targets: ScheduleTarget[],
    effectiveLeave: ReadonlySet<string>,
  ): Promise<ScheduleGenerationCounts>;

  abstract listSelf(
    transaction: TransactionContext,
    vendorId: string,
    agentMembershipId: string,
    serviceDate: string,
    query: Readonly<{ cursor?: string; limit?: number }>,
  ): Promise<Readonly<{ items: readonly ScheduledDeliveryRecord[]; nextCursor?: string }>>;
}
