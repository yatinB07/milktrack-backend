import type { TransactionContext } from '../../common/application/transaction-context.js';
import type {
  AgentOutcomeStatus,
  CorrectionStatus,
  DeliveryCurrentStatus,
} from '../domain/delivery-rules.js';

export type DeliveryOccurrenceKey = Readonly<{
  vendorId: string;
  subscriptionId: string;
  serviceDate: string;
  deliverySlotId: string;
}>;

export type DeliveryItemVersion = Readonly<{
  scheduledDeliveryId: string;
  expectedVersion: number;
}>;

export type LockStopInput = Readonly<{
  vendorId: string;
  agentMembershipId: string;
  routeStopId: string;
  serviceDate: string;
  submitted: readonly DeliveryItemVersion[];
}>;

export type PendingDelivery = DeliveryOccurrenceKey & Readonly<{
  id: string;
  householdId: string;
  productId: string;
  unitId: string;
  routeAssignmentId: string;
  plannedQuantity: string;
  currentStatus: 'scheduled';
  version: number;
}>;

export type DeliveryEventSource = 'system' | 'customer' | 'delivery_agent' | 'vendor_admin';
export type DeliveryFinalStatus = AgentOutcomeStatus | 'skipped_by_customer';

export type AppendFinalOutcome = Readonly<{
  id: string;
  vendorId: string;
  scheduledDeliveryId: string;
  expectedVersion: number;
  outcome: AgentOutcomeStatus;
  source: Extract<DeliveryEventSource, 'delivery_agent'>;
  actorUserId: string;
  occurredAt: Date;
  receivedAt: Date;
  actualQuantity?: string;
  reasonCode?: string;
  note?: string;
  latitude?: string;
  longitude?: string;
}>;

export type AppendCorrection = Readonly<{
  id: string;
  vendorId: string;
  scheduledDeliveryId: string;
  expectedVersion: number;
  replacementOutcome: CorrectionStatus;
  actorUserId: string;
  occurredAt: Date;
  receivedAt: Date;
  actualQuantity?: string;
  reason: string;
}>;

export type CreatePriceSnapshot = Readonly<{
  vendorId: string;
  scheduledDeliveryId: string;
  amountMinor: string;
  currency: string;
  pricingLevel: 'global' | 'customer_specific';
  sourcePriceId: string;
  sourcePriceType: 'global_price' | 'customer_price_override';
  resolvedAt: Date;
}>;

export type DeliveryEvent = Readonly<{
  id: string;
  eventType: DeliveryFinalStatus;
  source: DeliveryEventSource;
  actorUserId?: string;
  occurredAt: Date;
  receivedAt: Date;
  actualQuantity?: string;
  reasonCode?: string;
  note?: string;
  latitude?: string;
  longitude?: string;
  replacedEventId?: string;
  createdAt: Date;
}>;

export type DeliveryPriceSnapshot = Readonly<{
  amountMinor: string;
  currency: string;
  pricingLevel: 'global' | 'customer_specific';
  sourcePriceId: string;
  sourcePriceType: 'global_price' | 'customer_price_override';
  resolvedAt: Date;
}>;

export type DeliveryRecord = DeliveryOccurrenceKey & Readonly<{
  id: string;
  householdId: string;
  productId: string;
  unitId: string;
  routeAssignmentId?: string;
  plannedQuantity: string;
  currentStatus: DeliveryCurrentStatus;
  version: number;
  finalizedAt?: Date;
}>;

export type DeliveryDetail = DeliveryRecord & Readonly<{
  events: readonly DeliveryEvent[];
  snapshot?: DeliveryPriceSnapshot;
}>;

export type VendorDeliveryQuery = Readonly<{
  vendorId: string;
  serviceDate?: string;
  householdId?: string;
  routeAssignmentId?: string;
  routeId?: string;
  agentMembershipId?: string;
  productId?: string;
  currentStatus?: DeliveryCurrentStatus;
  cursor?: string;
  limit?: number;
}>;

export type CustomerDeliveryQuery = Readonly<{
  vendorId: string;
  householdId: string;
  cursor?: string;
  limit?: number;
}>;

export type DeliveryPage = Readonly<{
  items: readonly DeliveryRecord[];
  nextCursor?: string;
}>;

/** Delivery-owned persistence boundary; every operation uses the supplied tenant transaction. */
export abstract class DeliveryStore {
  abstract lockStopPendingSet(
    tx: TransactionContext,
    input: LockStopInput,
  ): Promise<readonly PendingDelivery[]>;

  abstract appendFinalOutcome(
    tx: TransactionContext,
    input: AppendFinalOutcome,
  ): Promise<DeliveryRecord>;

  abstract appendCorrection(
    tx: TransactionContext,
    input: AppendCorrection,
  ): Promise<DeliveryRecord>;

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

  abstract createPriceSnapshot(
    tx: TransactionContext,
    input: CreatePriceSnapshot,
  ): Promise<void>;

  abstract listVendor(
    tx: TransactionContext,
    input: VendorDeliveryQuery,
  ): Promise<DeliveryPage>;

  abstract getVendorDetail(
    tx: TransactionContext,
    vendorId: string,
    id: string,
  ): Promise<DeliveryDetail>;

  abstract listCustomer(
    tx: TransactionContext,
    input: CustomerDeliveryQuery,
  ): Promise<DeliveryPage>;

  abstract getCustomerDetail(
    tx: TransactionContext,
    vendorId: string,
    householdId: string,
    id: string,
  ): Promise<DeliveryDetail>;
}
