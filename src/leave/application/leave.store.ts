import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { LateLeavePolicy } from '../../vendors/domain/delivery-policy.js';
import type { LeaveAction, LeaveOccurrenceClassification, LeaveRequestStatus } from '../domain/leave-rules.js';

export type LeaveDecisionStatus = 'pending' | 'approved' | 'rejected';
export type LeaveSource = 'customer' | 'vendor_admin' | 'system';
export type LeaveRevisionSubscription = Readonly<{
  subscriptionId: string;
  selected: boolean;
}>;
export type LeaveRevisionDecisionRecord = Readonly<{
  id: string; subscriptionId: string; serviceDate: string; deliverySlotId: string; status: LeaveDecisionStatus;
  previousEffectiveStatus: 'scheduled' | 'skipped_by_customer'; requestedEffectiveStatus: 'scheduled' | 'skipped_by_customer';
  version: number; createdAt: Date;
}>;
export type LeaveRevisionRecord = Readonly<{
  id: string; action: LeaveAction; startDate: string; endDate: string; source: LeaveSource; createdBy: string;
  status: LeaveRequestStatus; note?: string; previousRevisionId?: string; createdAt: Date;
  subscriptions: readonly LeaveRevisionSubscription[]; subscriptionIds: readonly string[]; decisions?: readonly LeaveRevisionDecisionRecord[];
}>;
export type LeaveRequestRecord = Readonly<{
  id: string; vendorId: string; householdId: string; status: LeaveRequestStatus; currentRevisionId?: string;
  version: number; createdAt: Date; updatedAt: Date; revisions: readonly LeaveRevisionRecord[];
}>;
export type LeaveOccurrenceKey = Readonly<{ vendorId: string; subscriptionId: string; deliverySlotId: string; serviceDate: string }>;
export type LeaveOccurrenceCandidate = Readonly<{ subscriptionId: string; deliverySlotId: string; serviceDate: string }>;
export type LeavePreviewInput = Readonly<{
  vendorId: string; householdId: string; subscriptionIds: readonly string[]; startDate: string; endDate: string;
  timezone: string; skipCutoffMinutes: number; lateLeavePolicy: LateLeavePolicy; now: Date; cursor?: string; limit?: number;
}>;
export type LeavePreviewPage = Readonly<{
  items: readonly LeaveOccurrenceClassification[]; nextCursor?: string; onTimeCount: number; lateCount: number;
}>;
export type PersistLeaveRevision = Readonly<{
  vendorId: string; householdId: string; requestId: string; revisionId: string; action: LeaveAction;
  previousRevisionId?: string; source: LeaveSource; createdBy: string; startDate: string; endDate: string;
  subscriptions: readonly LeaveRevisionSubscription[]; status: LeaveRequestStatus; expectedVersion?: number; note?: string;
  decisions: readonly Readonly<{
    id: string; subscriptionId?: string; serviceDate: string; deliverySlotId: string; status: 'pending' | 'rejected';
    previousEffectiveStatus?: 'scheduled' | 'skipped_by_customer'; requestedEffectiveStatus?: 'scheduled' | 'skipped_by_customer';
  }>[];
}>;
export type LeaveListInput = Readonly<{ vendorId: string; householdId: string; cursor?: string; limit?: number }>;
export type LeaveRequestPage = Readonly<{ items: readonly LeaveRequestRecord[]; nextCursor?: string }>;
export type LeaveDecisionRecord = Readonly<{
  id: string; vendorId: string; leaveRequestRevisionId: string; subscriptionId: string; serviceDate: string;
  deliverySlotId: string; status: LeaveDecisionStatus; version: number; createdAt: Date;
}>;
export type LeaveDecisionListInput = Readonly<{ vendorId: string; cursor?: string; limit?: number }>;
export type LeaveDecisionPage = Readonly<{ items: readonly LeaveDecisionRecord[]; nextCursor?: string }>;
export type DecideLeaveOccurrence = Readonly<{
  vendorId: string; id: string; expectedVersion: number; decision: 'approved' | 'rejected'; decidedBy: string; reason: string; now: Date;
}>;
export type LeaveDecisionResult = LeaveDecisionRecord & Readonly<{ request: LeaveRequestRecord }>;

/** Transaction-bound persistence boundary for compact leave ranges and late exceptions. */
export abstract class LeaveStore {
  abstract lockSubscriptions(tx: TransactionContext, vendorId: string, ids: readonly string[]): Promise<void>;
  abstract preview(tx: TransactionContext, input: LeavePreviewInput): Promise<LeavePreviewPage>;
  abstract assertNoOverlap(tx: TransactionContext, input: LeavePreviewInput): Promise<void>;
  abstract createRevision(tx: TransactionContext, input: PersistLeaveRevision): Promise<LeaveRequestRecord>;
  abstract getRequest(tx: TransactionContext, vendorId: string, householdId: string, id: string): Promise<LeaveRequestRecord>;
  abstract getVendorRequest(tx: TransactionContext, vendorId: string, id: string): Promise<LeaveRequestRecord>;
  abstract listRequests(tx: TransactionContext, input: LeaveListInput): Promise<LeaveRequestPage>;
  abstract listPendingDecisions(tx: TransactionContext, input: LeaveDecisionListInput): Promise<LeaveDecisionPage>;
  abstract decide(tx: TransactionContext, input: DecideLeaveOccurrence): Promise<LeaveDecisionResult>;
  abstract effectiveOccurrenceKeys(tx: TransactionContext, input: Readonly<{
    vendorId: string;
    candidates: readonly LeaveOccurrenceCandidate[];
  }>): Promise<ReadonlySet<string>>;
  abstract isEffectivelyOnLeave(tx: TransactionContext, input: LeaveOccurrenceKey): Promise<boolean>;
}
