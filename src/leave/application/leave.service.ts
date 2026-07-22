import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { Actor } from '../../common/context/request-context.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { HouseholdService } from '../../customers/application/household.service.js';
import { DeliveryLeaveProjection } from '../../delivery/application/delivery-leave.projection.js';
import { MembershipService } from '../../memberships/application/membership.service.js';
import { NotificationWriter, type NotificationType } from '../../notifications/application/notification-writer.js';
import { RoutingScheduleService } from '../../routing/application/routing-schedule.service.js';
import { SubscriptionLabelReader, type LeaveSubscriptionLabel, type SubscriptionLabelMatch, type SubscriptionLabelReference } from '../../subscriptions/application/subscription-label.reader.js';
import { VendorService } from '../../vendors/application/vendor.service.js';
import { deriveLeaveOccurrenceTransitions, deriveLeaveStatus, validateLeaveRange, type LeaveOccurrenceClassification, type LeaveRequestStatus } from '../domain/leave-rules.js';
import { LeaveStore, type LeaveDecisionPage as StoreDecisionPage, type LeaveDecisionRecord as StoreDecisionRecord, type LeaveDecisionResult as StoreDecisionResult, type LeaveRequestPage as StoreRequestPage, type LeaveRequestRecord, type LeaveRevisionDecisionRecord, type LeaveRevisionRecord, type LeavePreviewPage, type PersistLeaveRevision } from './leave.store.js';

export type PageQuery = Readonly<{ cursor?: string; limit?: number }>;
export type LeaveSelectionCommand = Readonly<{ startDate: string; endDate: string; subscriptionIds: readonly string[]; note?: string }>;
export type AmendLeaveCommand = LeaveSelectionCommand & Readonly<{ expectedVersion: number }>;
export type CancelLeaveCommand = Readonly<{ expectedVersion: number; note?: string }>;
export type LeaveDecisionQuery = PageQuery;
export type DecideLeaveOccurrenceCommand = Readonly<{ expectedVersion: number; decision: 'approved' | 'rejected'; reason: string }>;

export type CustomerLeaveAction = 'amend' | 'cancel';
export type VendorLeaveDecisionAction = 'approve' | 'reject';
type LeaveDecisionLabel = Pick<LeaveSubscriptionLabel, 'productId' | 'productName' | 'deliverySlotName'>;
type LeaveDecisionTimeline = LeaveRevisionDecisionRecord & LeaveDecisionLabel;
type LeaveRevisionResult = Omit<LeaveRevisionRecord, 'decisions'> & Readonly<{
  subscriptionLabels: readonly LeaveSubscriptionLabel[]; decisions?: readonly LeaveDecisionTimeline[];
}>;
type EnrichedLeaveRequestRecord = Omit<LeaveRequestRecord, 'revisions'> & Readonly<{ revisions: readonly LeaveRevisionResult[] }>;
export type LeaveRequestResult = Omit<LeaveRequestRecord, 'status' | 'revisions'> & Readonly<{
  currentStatus: LeaveRequestStatus; availableActions: readonly CustomerLeaveAction[]; revisions: readonly LeaveRevisionResult[];
}>;
export type VendorLeaveRequestResult = Omit<LeaveRequestResult, 'availableActions' | 'revisions'> & Readonly<{
  revisions: readonly (Omit<LeaveRevisionResult, 'decisions'> & Readonly<{
    decisions?: readonly (LeaveDecisionTimeline & Readonly<{ availableActions: readonly VendorLeaveDecisionAction[] }>)[];
  }>)[];
}>;
export type LeaveRequestPage = Readonly<{ items: readonly LeaveRequestResult[]; nextCursor?: string }>;
type LeaveDecisionItem = StoreDecisionRecord & LeaveDecisionLabel;
export type LeaveDecisionResult = Omit<StoreDecisionResult, 'status' | 'request'> & LeaveDecisionLabel & Readonly<{ currentStatus: StoreDecisionResult['status']; request: VendorLeaveRequestResult }>;
export type LeaveDecisionPage = Readonly<{ items: readonly (Omit<LeaveDecisionItem, 'status'> & Readonly<{ currentStatus: LeaveDecisionItem['status'] }>)[]; nextCursor?: string }>;
export type LeavePreviewResult = Omit<LeavePreviewPage, 'items'> & Readonly<{
  items: readonly (LeavePreviewPage['items'][number] & LeaveDecisionLabel)[];
  timezone: string; skipCutoffMinutes: number; lateLeavePolicy: 'reject' | 'approval';
}>;

export abstract class LeaveService {
  abstract preview(actor: Actor, vendorId: string, householdId: string, command: LeaveSelectionCommand & PageQuery): Promise<LeavePreviewResult>;
  abstract create(actor: Actor, vendorId: string, householdId: string, command: LeaveSelectionCommand): Promise<LeaveRequestResult>;
  abstract listCustomer(actor: Actor, vendorId: string, householdId: string, query: PageQuery): Promise<LeaveRequestPage>;
  abstract getCustomer(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string): Promise<LeaveRequestResult>;
  abstract amend(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string, command: AmendLeaveCommand): Promise<LeaveRequestResult>;
  abstract cancel(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string, command: CancelLeaveCommand): Promise<LeaveRequestResult>;
  abstract listDecisions(actor: Actor, vendorId: string, query: LeaveDecisionQuery): Promise<LeaveDecisionPage>;
  abstract getVendorRequest(actor: Actor, vendorId: string, leaveRequestId: string): Promise<VendorLeaveRequestResult>;
  abstract decideOccurrence(actor: Actor, vendorId: string, decisionId: string, command: DecideLeaveOccurrenceCommand): Promise<LeaveDecisionResult>;
}

@Injectable()
export class DefaultLeaveService extends LeaveService {
  private readonly now = () => new Date();

  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(LeaveStore) private readonly leaves: LeaveStore,
    @Inject(VendorService) private readonly vendors: VendorService,
    @Inject(AuditWriter) private readonly audits: AuditWriter,
    @Inject(DeliveryLeaveProjection) private readonly deliveries: DeliveryLeaveProjection,
    @Inject(NotificationWriter) private readonly notifications: NotificationWriter,
    @Inject(RoutingScheduleService) private readonly routing: RoutingScheduleService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(SubscriptionLabelReader) private readonly labels: SubscriptionLabelReader,
  ) { super(); }

  preview(actor: Actor, vendorId: string, householdId: string, command: LeaveSelectionCommand & PageQuery) {
    return this.customer(actor, vendorId, householdId, 'leave.preview', async (tx) => {
      const context = await this.context(tx, vendorId);
      this.validate(command, context.timezone);
      const input = { vendorId, householdId, ...command, ...context, now: this.now() };
      const preview = await this.leaves.preview(tx, input);
      await this.leaves.assertNoOverlap(tx, input);
      return { ...await this.previewResult(tx, vendorId, householdId, preview), ...context };
    });
  }

  create(actor: Actor, vendorId: string, householdId: string, command: LeaveSelectionCommand) {
    return this.customer(actor, vendorId, householdId, 'leave.create', async (tx) => {
      const context = await this.context(tx, vendorId);
      this.validate(command, context.timezone);
      await this.leaves.lockSubscriptions(tx, vendorId, command.subscriptionIds);
      const status = await this.statusFor(tx, vendorId, householdId, undefined, command, context);
      const result = await this.leaves.createRevision(tx, {
        vendorId, householdId, requestId: randomUUID(), revisionId: randomUUID(), action: 'create', source: 'customer', createdBy: actor.userId,
        startDate: command.startDate, endDate: command.endDate, ...(command.note ? { note: command.note } : {}),
        subscriptions: command.subscriptionIds.map((subscriptionId) => ({ subscriptionId, selected: true })),
        status: status.status, decisions: status.decisions,
      });
      const agentUserIds = await this.synchronize(tx, vendorId, householdId, [command], context, actor.userId);
      await this.audit(tx, actor, vendorId, result, 'leave.created');
      await this.notifyOutcome(tx, result, actor.userId, agentUserIds);
      return this.customerResult(tx, vendorId, householdId, result);
    });
  }

  listCustomer(actor: Actor, vendorId: string, householdId: string, query: PageQuery) {
    return this.customer(actor, vendorId, householdId, 'leave.list', async (tx) => this.customerPage(tx, vendorId, householdId, await this.leaves.listRequests(tx, { vendorId, householdId, ...query })));
  }

  getCustomer(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string) {
    return this.customer(actor, vendorId, householdId, 'leave.get', async (tx) => this.customerResult(tx, vendorId, householdId, await this.leaves.getRequest(tx, vendorId, householdId, leaveRequestId)));
  }

  amend(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string, command: AmendLeaveCommand) {
    return this.customer(actor, vendorId, householdId, 'leave.amend', async (tx) => {
      const context = await this.context(tx, vendorId); this.validate(command, context.timezone);
      const current = await this.leaves.getRequest(tx, vendorId, householdId, leaveRequestId);
      const previous = selections(current, command);
      const subscriptionIds = [...new Set([...previous.flatMap(({ subscriptionIds }) => subscriptionIds), ...command.subscriptionIds])].sort();
      await this.leaves.lockSubscriptions(tx, vendorId, subscriptionIds);
      const status = await this.statusFor(tx, vendorId, householdId, previous, command, context);
      const result = await this.leaves.createRevision(tx, {
        vendorId, householdId, requestId: leaveRequestId, revisionId: randomUUID(), action: 'amend', previousRevisionId: current.currentRevisionId,
        source: 'customer', createdBy: actor.userId, startDate: command.startDate, endDate: command.endDate,
        ...(command.note ? { note: command.note } : {}),
        subscriptions: subscriptionIds.map((subscriptionId) => ({ subscriptionId, selected: command.subscriptionIds.includes(subscriptionId) })),
        expectedVersion: command.expectedVersion, status: status.status, decisions: status.decisions,
      });
      const agentUserIds = await this.synchronize(tx, vendorId, householdId, [...previous, command], context, actor.userId);
      await this.audit(tx, actor, vendorId, result, 'leave.amended');
      await this.notifyOutcome(tx, result, actor.userId, agentUserIds);
      return this.customerResult(tx, vendorId, householdId, result);
    });
  }

  cancel(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string, command: CancelLeaveCommand) {
    return this.customer(actor, vendorId, householdId, 'leave.cancel', async (tx) => {
      const current = await this.leaves.getRequest(tx, vendorId, householdId, leaveRequestId);
      const revision = current.revisions.find(({ id }) => id === current.currentRevisionId) ?? current.revisions[0];
      if (!revision) throw new ApplicationError('LEAVE_REQUEST_STATE_CONFLICT', 'Leave request has no current revision', 409);
      const context = await this.context(tx, vendorId);
      const previous = selections(current, { startDate: revision.startDate, endDate: revision.endDate, subscriptionIds: revision.subscriptionIds });
      const subscriptionIds = [...new Set(previous.flatMap((selection) => selection.subscriptionIds))].sort();
      await this.leaves.lockSubscriptions(tx, vendorId, subscriptionIds);
      const status = await this.statusFor(tx, vendorId, householdId, previous, undefined, context);
      const result = await this.leaves.createRevision(tx, {
        vendorId, householdId, requestId: leaveRequestId, revisionId: randomUUID(), action: 'cancel', previousRevisionId: revision.id,
        source: 'customer', createdBy: actor.userId, startDate: revision.startDate, endDate: revision.endDate,
        subscriptions: subscriptionIds.map((subscriptionId) => ({ subscriptionId, selected: false })),
        expectedVersion: command.expectedVersion, ...(command.note ? { note: command.note } : {}), status: status.status, decisions: status.decisions,
      });
      await this.synchronize(tx, vendorId, householdId, previous, context, actor.userId);
      await this.audit(tx, actor, vendorId, result, 'leave.cancelled'); return this.customerResult(tx, vendorId, householdId, result);
    });
  }

  listDecisions(actor: Actor, vendorId: string, query: LeaveDecisionQuery) {
    return this.authorization.execute({ actor, vendorId, permission: 'schedule:read', operation: 'leave.decision-list' }, async (tx) => this.decisionPage(tx, vendorId, await this.leaves.listPendingDecisions(tx, { vendorId, ...query })));
  }

  getVendorRequest(actor: Actor, vendorId: string, leaveRequestId: string) {
    return this.authorization.execute({ actor, vendorId, permission: 'schedule:read', operation: 'leave.vendor-get' }, async (tx) => this.vendorResult(tx, vendorId, await this.leaves.getVendorRequest(tx, vendorId, leaveRequestId)));
  }

  decideOccurrence(actor: Actor, vendorId: string, decisionId: string, command: DecideLeaveOccurrenceCommand) {
    return this.authorization.execute({ actor, vendorId, permission: 'schedule:manage', operation: 'leave.decision' }, async (tx) => {
      const result = await this.leaves.decide(tx, { vendorId, id: decisionId, ...command, decidedBy: actor.userId, now: this.now(), reason: command.reason.trim() });
      const key = { vendorId, subscriptionId: result.subscriptionId, serviceDate: result.serviceDate, deliverySlotId: result.deliverySlotId };
      const effective = await this.leaves.isEffectivelyOnLeave(tx, key);
      if (effective) await this.deliveries.applyCustomerLeave(tx, key, actor.userId, 'vendor_admin');
      else await this.deliveries.reverseCustomerLeave(tx, key, actor.userId, 'vendor_admin');
      await this.audit(tx, actor, vendorId, result.request, `leave.decision.${command.decision}`);
      const revision = result.request.revisions.find(({ id }) => id === result.request.currentRevisionId) ?? result.request.revisions[0];
      if (!revision) throw new ApplicationError('LEAVE_REQUEST_STATE_CONFLICT', 'Leave request has no current revision', 409);
      const agents = command.decision === 'approved' && effective
        ? await this.agentUserIds(tx, vendorId, result.request.householdId, [{ serviceDate: result.serviceDate, deliverySlotId: result.deliverySlotId }])
        : [];
      await this.notify(tx, vendorId, result.request.id, revision.createdBy, result.request.householdId,
        command.decision === 'approved' && effective ? 'leave_accepted' : 'leave_rejected', agents);
      return this.decisionResult(tx, vendorId, result);
    });
  }

  private customer<T>(actor: Actor, vendorId: string, householdId: string, operation: string, work: (tx: TransactionContext) => Promise<T>) {
    return this.authorization.execute({ actor, vendorId, permission: 'customer:self', operation }, async (tx) => {
      await this.households.requireCustomerSubscriptionHousehold(tx, actor, vendorId, householdId);
      return work(tx);
    });
  }

  private async context(tx: TransactionContext, vendorId: string) {
    const [policy, settings] = await Promise.all([this.vendors.getDeliveryPolicyForTransaction(tx, vendorId), this.vendors.getSubscriptionTimezone(tx, vendorId)]);
    return { timezone: settings.timezone, skipCutoffMinutes: policy.skipCutoffMinutes, lateLeavePolicy: policy.lateLeavePolicy };
  }

  private validate(command: LeaveSelectionCommand, timezone: string) {
    const today = DateTime.fromJSDate(this.now()).setZone(timezone).toISODate();
    if (!today) throw new ApplicationError('VENDOR_TIMEZONE_INVALID', 'Vendor timezone is invalid', 503);
    validateLeaveRange(command.startDate, command.endDate, today);
  }

  private async statusFor(
    tx: TransactionContext,
    vendorId: string,
    householdId: string,
    previous: readonly LeaveSelectionCommand[] | undefined,
    requested: LeaveSelectionCommand | undefined,
    context: Awaited<ReturnType<DefaultLeaveService['context']>>,
  ): Promise<Readonly<{ status: LeaveRequestStatus; decisions: PersistLeaveRevision['decisions'] }>> {
    const now = this.now();
    const requestedTotal = requested ? await this.occurrenceCount(tx, vendorId, householdId, requested, context, now) : 0;
    const previousOccurrences = previous ? (await Promise.all(previous.map((selection) => this.lateHorizon(tx, vendorId, householdId, selection, context, now)))).flat() : [];
    const requestedOccurrences = requested ? await this.lateHorizon(tx, vendorId, householdId, requested, context, now) : [];
    const transitions = deriveLeaveOccurrenceTransitions(previousOccurrences, requestedOccurrences);
    const late = transitions.filter(({ timing }) => timing === 'late');
    const decisions = late.map((transition) => ({
      id: randomUUID(), subscriptionId: transition.subscriptionId, serviceDate: transition.serviceDate,
      deliverySlotId: transition.deliverySlotId, cutoffAt: transition.cutoffAt,
      status: transition.proposedBehavior === 'reject' ? 'rejected' as const : 'pending' as const,
      previousEffectiveStatus: transition.previousEffectiveStatus,
      requestedEffectiveStatus: transition.requestedEffectiveStatus,
    }));
    const pending = decisions.filter(({ status }) => status === 'pending').length;
    if (!requested) {
      const previousTotal = previous ? (await Promise.all(previous.map((selection) => this.occurrenceCount(tx, vendorId, householdId, selection, context, now)))).reduce((sum, count) => sum + count, 0) : 0;
      const applied = previousTotal - late.length;
      const rejected = decisions.some(({ status }) => status === 'rejected');
      const status = pending > 0 ? (applied > 0 ? 'partially_pending' : 'pending_approval') : rejected ? 'accepted' : 'cancelled';
      return { status, decisions };
    }
    const effective = late.reduce((count, transition) => count
      + (transition.previousEffectiveStatus === 'skipped_by_customer' ? 1 : 0)
      - (transition.requestedEffectiveStatus === 'skipped_by_customer' ? 1 : 0), requestedTotal);
    return { status: deriveLeaveStatus({ effective, pending }), decisions };
  }

  private async occurrenceCount(
    tx: TransactionContext, vendorId: string, householdId: string, selection: LeaveSelectionCommand,
    context: Awaited<ReturnType<DefaultLeaveService['context']>>, now: Date,
  ) {
    const page = await this.leaves.preview(tx, { vendorId, householdId, ...selection, ...context, now, limit: 1 });
    return page.onTimeCount + page.lateCount;
  }

  private async lateHorizon(
    tx: TransactionContext, vendorId: string, householdId: string, selection: LeaveSelectionCommand,
    context: Awaited<ReturnType<DefaultLeaveService['context']>>, now: Date,
  ): Promise<readonly LeaveOccurrenceClassification[]> {
    const horizon = DateTime.fromJSDate(now, { zone: context.timezone }).plus({ minutes: context.skipCutoffMinutes }).toISODate();
    if (!horizon || selection.startDate > horizon) return [];
    const bounded = { ...selection, endDate: selection.endDate < horizon ? selection.endDate : horizon };
    const occurrences: LeaveOccurrenceClassification[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.leaves.preview(tx, { vendorId, householdId, ...bounded, ...context, now, limit: 100, ...(cursor ? { cursor } : {}) });
      occurrences.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return occurrences;
  }

  private async synchronize(
    tx: TransactionContext,
    vendorId: string,
    householdId: string,
    selections: readonly Readonly<{ startDate: string; endDate: string; subscriptionIds: readonly string[] }>[],
    context: Awaited<ReturnType<DefaultLeaveService['context']>>,
    actorUserId: string,
  ): Promise<readonly string[]> {
    const accepted: Array<{ serviceDate: string; deliverySlotId: string }> = [];
    for (const selection of selections) {
      let cursor: string | undefined;
      do {
        const page = await this.leaves.preview(tx, {
          vendorId, householdId, ...selection, ...context, now: this.now(), limit: 100, ...(cursor ? { cursor } : {}),
        });
        for (const occurrence of page.items) {
          const key = { vendorId, subscriptionId: occurrence.subscriptionId, serviceDate: occurrence.serviceDate, deliverySlotId: occurrence.deliverySlotId };
          if (await this.leaves.isEffectivelyOnLeave(tx, key)) {
            await this.deliveries.applyCustomerLeave(tx, key, actorUserId);
            accepted.push(occurrence);
          } else {
            await this.deliveries.reverseCustomerLeave(tx, key, actorUserId);
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    return this.agentUserIds(tx, vendorId, householdId, accepted);
  }

  private async agentUserIds(
    tx: TransactionContext,
    vendorId: string,
    householdId: string,
    occurrences: readonly Readonly<{ serviceDate: string; deliverySlotId: string }>[],
  ): Promise<readonly string[]> {
    const assignmentIds = new Set<string>();
    const routesByDate = new Map<string, Awaited<ReturnType<RoutingScheduleService['project']>>>();
    for (const occurrence of occurrences) {
      let routes = routesByDate.get(occurrence.serviceDate);
      if (!routes) {
        routes = await this.routing.project(tx, vendorId, occurrence.serviceDate);
        routesByDate.set(occurrence.serviceDate, routes);
      }
      for (const route of routes) {
        if (route.deliverySlotId === occurrence.deliverySlotId
          && route.stops.some((stop) => stop.householdId === householdId)
          && route.assignment) assignmentIds.add(route.assignment.agentMembershipId);
      }
    }
    if (assignmentIds.size === 0) return [];
    return (await this.memberships.customerMembershipHistory(tx, vendorId, [...assignmentIds])).map(({ userId }) => userId);
  }

  private notifyOutcome(
    tx: TransactionContext,
    result: LeaveRequestRecord,
    customerUserId: string,
    agentUserIds: readonly string[],
  ) {
    if (result.status !== 'accepted' && result.status !== 'partially_pending' && result.status !== 'rejected') return Promise.resolve();
    return this.notify(tx, result.vendorId, result.id, customerUserId,
      result.householdId,
      result.status === 'rejected' ? 'leave_rejected' : 'leave_accepted',
      result.status === 'rejected' ? [] : agentUserIds);
  }

  private async notify(
    tx: TransactionContext,
    vendorId: string,
    leaveRequestId: string,
    customerUserId: string,
    householdId: string,
    type: Extract<NotificationType, 'leave_accepted' | 'leave_rejected'>,
    agentUserIds: readonly string[],
  ) {
    const recipients = new Set([customerUserId, ...agentUserIds]);
    for (const recipientUserId of recipients) {
      await this.notifications.append(tx, { id: randomUUID(), vendorId, householdId, recipientUserId, type, payload: { leaveRequestId } });
    }
  }

  private async previewResult(tx: TransactionContext, vendorId: string, householdId: string, value: LeavePreviewPage) {
    const references = value.items.map((item) => occurrenceReference(`preview:${occurrenceKey(item)}`, item));
    const matches = await this.readLabels(tx, vendorId, references, householdId);
    return { ...value, items: value.items.map((item) => ({ ...item, ...decisionLabel(matches, `preview:${occurrenceKey(item)}`, item) })) };
  }

  private async customerResult(tx: TransactionContext, vendorId: string, householdId: string, value: LeaveRequestRecord) {
    return customerRequest((await this.enrichRequests(tx, vendorId, [value], householdId))[0]);
  }

  private async customerPage(tx: TransactionContext, vendorId: string, householdId: string, value: StoreRequestPage): Promise<LeaveRequestPage> {
    const items = await this.enrichRequests(tx, vendorId, value.items, householdId);
    return { items: items.map(customerRequest), ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}) };
  }

  private async vendorResult(tx: TransactionContext, vendorId: string, value: LeaveRequestRecord) {
    return vendorRequest((await this.enrichRequests(tx, vendorId, [value]))[0]);
  }

  private async decisionPage(tx: TransactionContext, vendorId: string, value: StoreDecisionPage): Promise<LeaveDecisionPage> {
    const references = value.items.map((item) => occurrenceReference(`decision:${item.id}`, item));
    const matches = await this.readLabels(tx, vendorId, references);
    return { items: value.items.map(({ status, ...item }) => ({ ...item, ...decisionLabel(matches, `decision:${item.id}`, item), currentStatus: status })),
      ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}) };
  }

  private async decisionResult(tx: TransactionContext, vendorId: string, value: StoreDecisionResult): Promise<LeaveDecisionResult> {
    const references = [...requestLabelReferences([value.request]), occurrenceReference(`decision:${value.id}`, value)];
    const matches = await this.readLabels(tx, vendorId, references);
    const { status, request: leave, ...result } = value;
    return { ...result, ...decisionLabel(matches, `decision:${value.id}`, value), currentStatus: status,
      request: vendorRequest(enrichRequest(leave, matches)) };
  }

  private async enrichRequests(
    tx: TransactionContext,
    vendorId: string,
    values: readonly LeaveRequestRecord[],
    householdId?: string,
  ): Promise<readonly EnrichedLeaveRequestRecord[]> {
    const matches = await this.readLabels(tx, vendorId, requestLabelReferences(values), householdId);
    return values.map((value) => enrichRequest(value, matches));
  }

  private readLabels(
    tx: TransactionContext,
    vendorId: string,
    references: readonly SubscriptionLabelReference[],
    householdId?: string,
  ): Promise<readonly SubscriptionLabelMatch[]> {
    if (references.length === 0) return Promise.resolve([]);
    return this.labels.read(tx, { vendorId, ...(householdId ? { householdId } : {}), references });
  }

  private audit(tx: TransactionContext, actor: Actor, vendorId: string, value: LeaveRequestRecord, action: string) {
    return this.audits.append(tx, { id: randomUUID(), vendorId, actorUserId: actor.userId, action, entityType: 'leave_request', entityId: value.id, newValue: { currentStatus: value.status, version: value.version }, correlationId: requestContextStore.require().correlationId });
  }
}

function customerRequest(value: EnrichedLeaveRequestRecord): LeaveRequestResult {
  const { status, ...result } = value;
  const hasCurrent = value.revisions.some(({ id }) => id === value.currentRevisionId);
  return { ...result, currentStatus: status, availableActions: hasCurrent && status !== 'cancelled' ? ['amend', 'cancel'] : [] };
}
function vendorRequest(value: EnrichedLeaveRequestRecord): VendorLeaveRequestResult {
  const { status, revisions, ...result } = value;
  return { ...result, currentStatus: status, revisions: revisions.map(({ decisions, ...revision }) => ({ ...revision,
    ...(decisions ? { decisions: decisions.map((item) => ({ ...item,
      availableActions: revision.id === value.currentRevisionId && item.status === 'pending' ? ['approve', 'reject'] : [],
    })) } : {}),
  })) };
}

function requestLabelReferences(values: readonly LeaveRequestRecord[]): readonly SubscriptionLabelReference[] {
  return values.flatMap(({ revisions }) => revisions.flatMap((revision) => [
    ...revision.subscriptionIds.map((subscriptionId) => ({
      kind: 'range' as const, referenceId: `revision:${revision.id}`, subscriptionId,
      startDate: revision.startDate, endDate: revision.endDate,
    })),
    ...(revision.decisions ?? []).map((item) => occurrenceReference(`decision:${item.id}`, item)),
  ]));
}

function occurrenceReference(
  referenceId: string,
  item: Readonly<{ subscriptionId: string; serviceDate: string; deliverySlotId: string }>,
): SubscriptionLabelReference {
  return { kind: 'occurrence', referenceId, subscriptionId: item.subscriptionId, serviceDate: item.serviceDate, deliverySlotId: item.deliverySlotId };
}

function enrichRequest(value: LeaveRequestRecord, matches: readonly SubscriptionLabelMatch[]): EnrichedLeaveRequestRecord {
  return { ...value, revisions: [...value.revisions].sort(compareRevisions).map(({ decisions, ...revision }) => ({ ...revision,
    subscriptionLabels: uniqueLabels(
      matches.filter(({ referenceId }) => referenceId === `revision:${revision.id}`),
      revision.subscriptionIds,
    ),
    ...(decisions ? { decisions: [...decisions].sort(compareDecisions).map((item) => ({
      ...item, ...decisionLabel(matches, `decision:${item.id}`, item),
    })) } : {}),
  })) };
}

function decisionLabel(
  matches: readonly SubscriptionLabelMatch[],
  referenceId: string,
  item: Readonly<{ subscriptionId: string; deliverySlotId: string }>,
): LeaveDecisionLabel {
  const match = matches.find((candidate) => candidate.referenceId === referenceId
    && candidate.subscriptionId === item.subscriptionId && candidate.deliverySlotId === item.deliverySlotId);
  if (!match) throw new ApplicationError('LEAVE_SUBSCRIPTION_LABEL_UNAVAILABLE', 'Leave subscription label is unavailable', 503);
  return { productId: match.productId, productName: match.productName, deliverySlotName: match.deliverySlotName };
}

function uniqueLabels(
  matches: readonly SubscriptionLabelMatch[],
  subscriptionIds: readonly string[],
): readonly LeaveSubscriptionLabel[] {
  const allowed = new Set(subscriptionIds);
  const labels = new Map<string, LeaveSubscriptionLabel>();
  for (const match of matches) {
    const label = {
      subscriptionId: match.subscriptionId,
      productId: match.productId,
      productName: match.productName,
      deliverySlotId: match.deliverySlotId,
      deliverySlotName: match.deliverySlotName,
    };
    if (allowed.has(label.subscriptionId)) labels.set(`${label.subscriptionId}:${label.productId}:${label.deliverySlotId}`, label);
  }
  return [...labels.values()].sort(compareLabels);
}

function compareRevisions(left: LeaveRevisionRecord, right: LeaveRevisionRecord) {
  return right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id);
}
function compareDecisions(left: LeaveRevisionDecisionRecord, right: LeaveRevisionDecisionRecord) {
  return left.serviceDate.localeCompare(right.serviceDate) || left.id.localeCompare(right.id);
}
function compareLabels(left: LeaveSubscriptionLabel, right: LeaveSubscriptionLabel) {
  return left.subscriptionId.localeCompare(right.subscriptionId)
    || left.productId.localeCompare(right.productId)
    || left.deliverySlotId.localeCompare(right.deliverySlotId);
}
function occurrenceKey(item: Readonly<{ subscriptionId: string; serviceDate: string; deliverySlotId: string }>) {
  return `${item.serviceDate}:${item.subscriptionId}:${item.deliverySlotId}`;
}
function selections(value: LeaveRequestRecord, fallback: LeaveSelectionCommand): readonly LeaveSelectionCommand[] {
  const revision = value.revisions.find(({ id }) => id === value.currentRevisionId) ?? value.revisions[0];
  if (!revision) return [fallback];
  const selected = [{ startDate: revision.startDate, endDate: revision.endDate, subscriptionIds: revision.subscriptionIds }];
  const unselected = new Set(revision.subscriptions.filter(({ selected }) => !selected).map(({ subscriptionId }) => subscriptionId));
  for (const decision of revision.decisions ?? []) {
    const effectiveStatus = decision.status === 'approved' ? decision.requestedEffectiveStatus : decision.previousEffectiveStatus;
    if (unselected.has(decision.subscriptionId) && effectiveStatus === 'skipped_by_customer') {
      selected.push({ startDate: decision.serviceDate, endDate: decision.serviceDate, subscriptionIds: [decision.subscriptionId] });
    }
  }
  return selected.filter(({ subscriptionIds }) => subscriptionIds.length > 0);
}
