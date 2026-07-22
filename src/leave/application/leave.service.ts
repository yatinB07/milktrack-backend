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
import { VendorService } from '../../vendors/application/vendor.service.js';
import { deriveLeaveStatus, validateLeaveRange, type LeaveRequestStatus } from '../domain/leave-rules.js';
import { LeaveStore, type LeaveDecisionPage as StoreDecisionPage, type LeaveDecisionResult as StoreDecisionResult, type LeaveRequestPage as StoreRequestPage, type LeaveRequestRecord, type LeavePreviewPage } from './leave.store.js';

export type PageQuery = Readonly<{ cursor?: string; limit?: number }>;
export type LeaveSelectionCommand = Readonly<{ startDate: string; endDate: string; subscriptionIds: readonly string[]; note?: string }>;
export type AmendLeaveCommand = LeaveSelectionCommand & Readonly<{ expectedVersion: number }>;
export type CancelLeaveCommand = Readonly<{ expectedVersion: number; note?: string }>;
export type LeaveDecisionQuery = PageQuery;
export type DecideLeaveOccurrenceCommand = Readonly<{ expectedVersion: number; decision: 'approved' | 'rejected'; reason: string }>;

export type LeaveRequestResult = Omit<LeaveRequestRecord, 'status'> & Readonly<{ currentStatus: LeaveRequestStatus }>;
export type LeaveRequestPage = Readonly<{ items: readonly LeaveRequestResult[]; nextCursor?: string }>;
export type LeaveDecisionResult = Omit<StoreDecisionResult, 'status' | 'request'> & Readonly<{ currentStatus: StoreDecisionResult['status']; request: LeaveRequestResult }>;
export type LeaveDecisionPage = Readonly<{ items: readonly (Omit<StoreDecisionPage['items'][number], 'status'> & Readonly<{ currentStatus: StoreDecisionPage['items'][number]['status'] }>)[]; nextCursor?: string }>;
export type LeavePreviewResult = LeavePreviewPage & Readonly<{ timezone: string; skipCutoffMinutes: number; lateLeavePolicy: 'reject' | 'approval' }>;

export abstract class LeaveService {
  abstract preview(actor: Actor, vendorId: string, householdId: string, command: LeaveSelectionCommand & PageQuery): Promise<LeavePreviewResult>;
  abstract create(actor: Actor, vendorId: string, householdId: string, command: LeaveSelectionCommand): Promise<LeaveRequestResult>;
  abstract listCustomer(actor: Actor, vendorId: string, householdId: string, query: PageQuery): Promise<LeaveRequestPage>;
  abstract getCustomer(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string): Promise<LeaveRequestResult>;
  abstract amend(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string, command: AmendLeaveCommand): Promise<LeaveRequestResult>;
  abstract cancel(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string, command: CancelLeaveCommand): Promise<LeaveRequestResult>;
  abstract listDecisions(actor: Actor, vendorId: string, query: LeaveDecisionQuery): Promise<LeaveDecisionPage>;
  abstract getVendorRequest(actor: Actor, vendorId: string, leaveRequestId: string): Promise<LeaveRequestResult>;
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
  ) { super(); }

  preview(actor: Actor, vendorId: string, householdId: string, command: LeaveSelectionCommand & PageQuery) {
    return this.customer(actor, vendorId, householdId, 'leave.preview', async (tx) => {
      const context = await this.context(tx, vendorId);
      this.validate(command, context.timezone);
      return { ...await this.leaves.preview(tx, { vendorId, householdId, ...command, ...context, now: this.now() }), ...context };
    });
  }

  create(actor: Actor, vendorId: string, householdId: string, command: LeaveSelectionCommand) {
    return this.customer(actor, vendorId, householdId, 'leave.create', async (tx) => {
      const context = await this.context(tx, vendorId);
      this.validate(command, context.timezone);
      await this.leaves.lockSubscriptions(tx, vendorId, command.subscriptionIds);
      const status = await this.statusFor(tx, vendorId, householdId, command, context);
      const result = await this.leaves.createRevision(tx, {
        vendorId, householdId, requestId: randomUUID(), revisionId: randomUUID(), action: 'create', source: 'customer', createdBy: actor.userId,
        startDate: command.startDate, endDate: command.endDate, ...(command.note ? { note: command.note } : {}),
        subscriptions: command.subscriptionIds.map((subscriptionId) => ({ subscriptionId, selected: true })),
        status: status.status, decisions: status.decisions,
      });
      const agentUserIds = await this.synchronize(tx, vendorId, householdId, [command], context, actor.userId);
      await this.audit(tx, actor, vendorId, result, 'leave.created');
      await this.notifyOutcome(tx, result, actor.userId, agentUserIds);
      return request(result);
    });
  }

  listCustomer(actor: Actor, vendorId: string, householdId: string, query: PageQuery) {
    return this.customer(actor, vendorId, householdId, 'leave.list', async (tx) => page(await this.leaves.listRequests(tx, { vendorId, householdId, ...query })));
  }

  getCustomer(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string) {
    return this.customer(actor, vendorId, householdId, 'leave.get', async (tx) => request(await this.leaves.getRequest(tx, vendorId, householdId, leaveRequestId)));
  }

  amend(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string, command: AmendLeaveCommand) {
    return this.customer(actor, vendorId, householdId, 'leave.amend', async (tx) => {
      const context = await this.context(tx, vendorId); this.validate(command, context.timezone);
      const current = await this.leaves.getRequest(tx, vendorId, householdId, leaveRequestId);
      await this.leaves.lockSubscriptions(tx, vendorId, command.subscriptionIds);
      const status = await this.statusFor(tx, vendorId, householdId, command, context);
      const result = await this.leaves.createRevision(tx, {
        vendorId, householdId, requestId: leaveRequestId, revisionId: randomUUID(), action: 'amend', previousRevisionId: current.currentRevisionId,
        source: 'customer', createdBy: actor.userId, startDate: command.startDate, endDate: command.endDate,
        ...(command.note ? { note: command.note } : {}),
        subscriptions: command.subscriptionIds.map((subscriptionId) => ({ subscriptionId, selected: true })),
        expectedVersion: command.expectedVersion, status: status.status, decisions: status.decisions,
      });
      const previous = { startDate: current.revisions.find(({ id }) => id === current.currentRevisionId)?.startDate ?? command.startDate,
        endDate: current.revisions.find(({ id }) => id === current.currentRevisionId)?.endDate ?? command.endDate,
        subscriptionIds: current.revisions.find(({ id }) => id === current.currentRevisionId)?.subscriptionIds ?? command.subscriptionIds };
      const agentUserIds = await this.synchronize(tx, vendorId, householdId, [previous, command], context, actor.userId);
      await this.audit(tx, actor, vendorId, result, 'leave.amended');
      await this.notifyOutcome(tx, result, actor.userId, agentUserIds);
      return request(result);
    });
  }

  cancel(actor: Actor, vendorId: string, householdId: string, leaveRequestId: string, command: CancelLeaveCommand) {
    return this.customer(actor, vendorId, householdId, 'leave.cancel', async (tx) => {
      const current = await this.leaves.getRequest(tx, vendorId, householdId, leaveRequestId);
      const revision = current.revisions.find(({ id }) => id === current.currentRevisionId) ?? current.revisions[0];
      if (!revision) throw new ApplicationError('LEAVE_REQUEST_STATE_CONFLICT', 'Leave request has no current revision', 409);
      await this.leaves.lockSubscriptions(tx, vendorId, revision.subscriptionIds);
      const result = await this.leaves.createRevision(tx, {
        vendorId, householdId, requestId: leaveRequestId, revisionId: randomUUID(), action: 'cancel', previousRevisionId: revision.id,
        source: 'customer', createdBy: actor.userId, startDate: revision.startDate, endDate: revision.endDate,
        subscriptions: revision.subscriptionIds.map((subscriptionId) => ({ subscriptionId, selected: true })),
        expectedVersion: command.expectedVersion, ...(command.note ? { note: command.note } : {}), status: 'cancelled', decisions: [],
      });
      const context = await this.context(tx, vendorId);
      await this.synchronize(tx, vendorId, householdId, [revision], context, actor.userId);
      await this.audit(tx, actor, vendorId, result, 'leave.cancelled'); return request(result);
    });
  }

  listDecisions(actor: Actor, vendorId: string, query: LeaveDecisionQuery) {
    return this.authorization.execute({ actor, vendorId, permission: 'schedule:read', operation: 'leave.decision-list' }, async (tx) => decisionPage(await this.leaves.listPendingDecisions(tx, { vendorId, ...query })));
  }

  getVendorRequest(actor: Actor, vendorId: string, leaveRequestId: string) {
    return this.authorization.execute({ actor, vendorId, permission: 'schedule:read', operation: 'leave.vendor-get' }, async (tx) => request(await this.leaves.getVendorRequest(tx, vendorId, leaveRequestId)));
  }

  decideOccurrence(actor: Actor, vendorId: string, decisionId: string, command: DecideLeaveOccurrenceCommand) {
    return this.authorization.execute({ actor, vendorId, permission: 'schedule:manage', operation: 'leave.decision' }, async (tx) => {
      const result = await this.leaves.decide(tx, { vendorId, id: decisionId, ...command, decidedBy: actor.userId, now: this.now(), reason: command.reason.trim() });
      const key = { vendorId, subscriptionId: result.subscriptionId, serviceDate: result.serviceDate, deliverySlotId: result.deliverySlotId };
      const effective = await this.leaves.isEffectivelyOnLeave(tx, key);
      if (effective) await this.deliveries.applyCustomerLeave(tx, key, actor.userId);
      else await this.deliveries.reverseCustomerLeave(tx, key, actor.userId);
      await this.audit(tx, actor, vendorId, result.request, `leave.decision.${command.decision}`);
      const revision = result.request.revisions.find(({ id }) => id === result.request.currentRevisionId) ?? result.request.revisions[0];
      if (!revision) throw new ApplicationError('LEAVE_REQUEST_STATE_CONFLICT', 'Leave request has no current revision', 409);
      const agents = command.decision === 'approved' && effective
        ? await this.agentUserIds(tx, vendorId, result.request.householdId, [{ serviceDate: result.serviceDate, deliverySlotId: result.deliverySlotId }])
        : [];
      await this.notify(tx, vendorId, result.request.id, revision.createdBy, result.request.householdId,
        command.decision === 'approved' && effective ? 'leave_accepted' : 'leave_rejected', agents);
      return decision(result);
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

  private async statusFor(tx: TransactionContext, vendorId: string, householdId: string, command: LeaveSelectionCommand, context: Awaited<ReturnType<DefaultLeaveService['context']>>) {
    const decisions: Array<{ id: string; subscriptionId: string; serviceDate: string; deliverySlotId: string; status: 'pending' | 'rejected' }> = [];
    let cursor: string | undefined;
    const first = await this.leaves.preview(tx, { vendorId, householdId, ...command, ...context, now: this.now(), limit: 100 });
    const onTime = first.onTimeCount; const late = first.lateCount;
    let preview = first;
    do {
      for (const item of preview.items) if (item.timing === 'late') decisions.push({ id: randomUUID(), subscriptionId: item.subscriptionId, serviceDate: item.serviceDate, deliverySlotId: item.deliverySlotId, status: item.proposedBehavior === 'reject' ? 'rejected' : 'pending' });
      cursor = preview.nextCursor;
      if (cursor) preview = await this.leaves.preview(tx, { vendorId, householdId, ...command, ...context, now: this.now(), cursor, limit: 100 });
    } while (cursor);
    return { status: deriveLeaveStatus({ effective: onTime, pending: context.lateLeavePolicy === 'approval' ? late : 0 }), decisions };
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

  private audit(tx: TransactionContext, actor: Actor, vendorId: string, value: LeaveRequestRecord, action: string) {
    return this.audits.append(tx, { id: randomUUID(), vendorId, actorUserId: actor.userId, action, entityType: 'leave_request', entityId: value.id, newValue: { currentStatus: value.status, version: value.version }, correlationId: requestContextStore.require().correlationId });
  }
}

function request(value: LeaveRequestRecord): LeaveRequestResult { const { status, ...result } = value; return { ...result, currentStatus: status }; }
function page(value: StoreRequestPage): LeaveRequestPage { return { items: value.items.map(request), ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}) }; }
function decision(value: StoreDecisionResult): LeaveDecisionResult { const { status, request: leave, ...result } = value; return { ...result, currentStatus: status, request: request(leave) }; }
function decisionPage(value: StoreDecisionPage): LeaveDecisionPage { return { items: value.items.map(({ status, ...item }) => ({ ...item, currentStatus: status })), ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}) }; }
