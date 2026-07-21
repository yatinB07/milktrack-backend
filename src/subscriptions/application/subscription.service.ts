import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import { CatalogService } from '../../catalog/application/catalog.service.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import { recordLifecycleOf, type RecordLifecycle } from '../../common/application/record-lifecycle.js';
import type { Actor } from '../../common/context/request-context.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { HouseholdService } from '../../customers/application/household.service.js';
import { VendorService } from '../../vendors/application/vendor.service.js';
import { ScheduleDateLock } from '../../schedule-coordination/application/schedule-date-lock.js';
import { ScheduleRegenerationWriter } from '../../schedule-coordination/application/schedule-regeneration-writer.js';
import { RoutingScheduleService } from '../../routing/application/routing-schedule.service.js';
import { affectedScheduleDates, scheduleHorizon } from '../../schedule-coordination/application/schedule-horizon.js';
import {
  deriveSubscriptionStatus,
  normalizeSubscriptionWeekdays,
  parseSubscriptionPeriod,
  parseSubscriptionQuantity,
  periodContainsServiceDay,
  type SubscriptionOperationalStatus,
} from '../domain/subscription-rules.js';
import {
  SubscriptionStore,
  type SubscriptionAggregateRecord,
  type CustomerSubscriptionHistoryPage,
  type CustomerSubscriptionRevision,
  type SubscriptionHistoryPage,
  type SubscriptionPageQuery,
  type SubscriptionStorePageQuery,
} from './subscription.store.js';

export type CreateSubscriptionCommand = Readonly<{
  householdId: string; productId: string; unitId: string; deliverySlotId: string; quantity: string;
  weekdays: readonly number[]; startDate: string; endDate?: string;
}>;
export type ModifySubscriptionCommand = Omit<CreateSubscriptionCommand, 'householdId' | 'startDate'> & Readonly<{
  effectiveDate: string; expectedVersion: number; reason: string;
}>;
export type SubscriptionTransitionCommand = Readonly<{ effectiveDate: string; expectedVersion: number; reason: string }>;
export type SubscriptionVersionReason = Readonly<{ expectedVersion: number; reason: string }>;
export type SubscriptionResult = Omit<SubscriptionAggregateRecord, 'deletedAt' | 'deletedBy' | 'deletionReason'> & Readonly<{
  status: 'future' | SubscriptionOperationalStatus | 'completed'; lifecycle: RecordLifecycle; supersededRevisionCount?: number;
}>;
export type CustomerSubscriptionResult = Omit<SubscriptionResult, 'deletedAt' | 'deletedBy' | 'deletionReason' | 'lifecycle' | 'revisions'> & Readonly<{
  revisions: readonly CustomerSubscriptionRevision[];
}>;

export abstract class SubscriptionService {
  abstract create(actor: Actor, vendorId: string, command: CreateSubscriptionCommand): Promise<SubscriptionResult>;
  abstract list(actor: Actor, vendorId: string, query: SubscriptionPageQuery): Promise<Readonly<{ items: readonly SubscriptionResult[]; nextCursor?: string }>>;
  abstract get(actor: Actor, vendorId: string, subscriptionId: string, lifecycle: RecordLifecycle): Promise<SubscriptionResult>;
  abstract history(actor: Actor, vendorId: string, subscriptionId: string, query: Pick<SubscriptionPageQuery, 'cursor' | 'limit'>): Promise<SubscriptionHistoryPage>;
  abstract modify(actor: Actor, vendorId: string, subscriptionId: string, command: ModifySubscriptionCommand): Promise<SubscriptionResult>;
  abstract pause(actor: Actor, vendorId: string, subscriptionId: string, command: SubscriptionTransitionCommand): Promise<SubscriptionResult>;
  abstract resume(actor: Actor, vendorId: string, subscriptionId: string, command: SubscriptionTransitionCommand): Promise<SubscriptionResult>;
  abstract cancel(actor: Actor, vendorId: string, subscriptionId: string, command: SubscriptionTransitionCommand): Promise<SubscriptionResult>;
  abstract softDelete(actor: Actor, vendorId: string, subscriptionId: string, command: SubscriptionVersionReason): Promise<void>;
  abstract restore(actor: Actor, vendorId: string, subscriptionId: string, command: SubscriptionVersionReason): Promise<SubscriptionResult>;
  abstract listCustomer(actor: Actor, vendorId: string, householdId: string, query: Omit<SubscriptionPageQuery, 'lifecycle'>): Promise<Readonly<{ items: readonly CustomerSubscriptionResult[]; nextCursor?: string }>>;
  abstract getCustomer(actor: Actor, vendorId: string, householdId: string, subscriptionId: string): Promise<CustomerSubscriptionResult>;
  abstract historyCustomer(actor: Actor, vendorId: string, householdId: string, subscriptionId: string, query: Pick<SubscriptionPageQuery, 'cursor' | 'limit'>): Promise<CustomerSubscriptionHistoryPage>;
}

@Injectable()
export class DefaultSubscriptionService extends SubscriptionService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(SubscriptionStore) private readonly subscriptions: SubscriptionStore,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(VendorService) private readonly vendors: VendorService,
    @Inject(AuditWriter) private readonly audits: AuditWriter,
    @Inject(ScheduleDateLock) private readonly scheduleDates: ScheduleDateLock,
    @Inject(ScheduleRegenerationWriter) private readonly regeneration: ScheduleRegenerationWriter,
    @Inject(RoutingScheduleService) private readonly routing: RoutingScheduleService,
  ) { super(); }

  create(actor: Actor, vendorId: string, command: CreateSubscriptionCommand): Promise<SubscriptionResult> {
    const period = parseSubscriptionPeriod(command.startDate, command.endDate);
    const weekdays = normalizeSubscriptionWeekdays(command.weekdays);
    if (!periodContainsServiceDay(period.effectiveFrom, period.effectiveTo, weekdays)) this.invalidDate();
    return this.execute(actor, vendorId, 'subscription:manage', 'subscription.create', async (tx) => {
      const today = await this.today(tx, vendorId); this.requireNotPast(period.effectiveFrom, today);
      const dates = affectedScheduleDates(today, period.effectiveFrom, period.effectiveTo, weekdays);
      await this.scheduleDates.lock(tx, vendorId, dates);
      await this.households.requireSubscriptionHousehold(tx, command.householdId);
      const selected = await this.catalog.requireSubscriptionSelection(tx, command.productId, command.unitId, command.deliverySlotId);
      const quantity = parseSubscriptionQuantity(command.quantity, selected.unitDecimalScale);
      const created = await this.subscriptions.create(tx, {
        id: randomUUID(), vendorId, householdId: command.householdId, productId: command.productId, unitId: command.unitId,
        deliverySlotId: command.deliverySlotId, quantity, weekdays, ...period, createdBy: actor.userId,
      });
      await this.audit(tx, actor, vendorId, created.id, 'subscription.created', created, undefined);
      await this.regenerate(tx, vendorId, today, dates, actor.userId);
      return this.project(created, today);
    });
  }

  list(actor: Actor, vendorId: string, query: SubscriptionPageQuery) {
    if (Boolean(query.routeId) !== Boolean(query.routeServiceDate))
      throw new ApplicationError('INVALID_ROUTE_FILTER', 'Route and service date must be provided together', 400);
    return this.execute(actor, vendorId, query.lifecycle === 'deleted' ? 'subscription:manage' : 'subscription:read', query.lifecycle === 'deleted' ? 'subscription.deleted-list' : 'subscription.list', async (tx) => {
      const today = await this.today(tx, vendorId);
      const { routeId, routeServiceDate, lifecycle, ...baseQuery } = query;
      const rootQuery: SubscriptionStorePageQuery = { ...baseQuery, lifecycle };
      let storeQuery: SubscriptionStorePageQuery = rootQuery;
      if (routeId && routeServiceDate) {
        const route = await this.routing.projectRoute(tx, vendorId, routeId, routeServiceDate);
        if (!route) throw new ApplicationError('ROUTE_NOT_FOUND', 'Route was not found', 404);
        storeQuery = { ...rootQuery, route: {
          serviceDate: routeServiceDate,
          deliverySlotId: route.deliverySlotId,
          householdIds: route.stops.map(({ householdId }) => householdId),
        } };
      }
      const page = await this.subscriptions.list(tx, storeQuery, today);
      const items = page.items.map((item) => this.project(item, today));
      return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    });
  }
  get(actor: Actor, vendorId: string, subscriptionId: string, lifecycle: RecordLifecycle) {
    return this.execute(actor, vendorId, lifecycle === 'deleted' ? 'subscription:manage' : 'subscription:read', lifecycle === 'deleted' ? 'subscription.deleted-get' : 'subscription.get', async (tx) => this.project(await this.subscriptions.get(tx, subscriptionId, lifecycle), await this.today(tx, vendorId)));
  }
  history(actor: Actor, vendorId: string, subscriptionId: string, query: Pick<SubscriptionPageQuery, 'cursor' | 'limit'>) {
    return this.execute(actor, vendorId, 'subscription:read', 'subscription.history', (tx) => this.subscriptions.history(tx, subscriptionId, query));
  }
  modify(actor: Actor, vendorId: string, subscriptionId: string, command: ModifySubscriptionCommand) {
    return this.mutate(actor, vendorId, subscriptionId, command, 'modify');
  }
  pause(actor: Actor, vendorId: string, subscriptionId: string, command: SubscriptionTransitionCommand) {
    return this.mutate(actor, vendorId, subscriptionId, command, 'pause');
  }
  resume(actor: Actor, vendorId: string, subscriptionId: string, command: SubscriptionTransitionCommand) {
    return this.mutate(actor, vendorId, subscriptionId, command, 'resume');
  }
  cancel(actor: Actor, vendorId: string, subscriptionId: string, command: SubscriptionTransitionCommand) {
    return this.mutate(actor, vendorId, subscriptionId, command, 'cancel');
  }

  async softDelete(actor: Actor, vendorId: string, subscriptionId: string, command: SubscriptionVersionReason): Promise<void> {
    const reason = this.reason(command.reason);
    await this.execute(actor, vendorId, 'subscription:manage', 'subscription.delete', async (tx) => {
      const today = await this.today(tx, vendorId);
      const dates = scheduleHorizon(today);
      await this.scheduleDates.lock(tx, vendorId, dates);
      const locked = await this.subscriptions.lockRoot(tx, subscriptionId, command.expectedVersion);
      const status = deriveSubscriptionStatus(this.currentPlan(locked), today);
      if (status !== 'cancelled' && status !== 'completed')
        throw new ApplicationError('SUBSCRIPTION_DELETE_REQUIRES_TERMINAL', 'Subscription must be terminal before deletion', 409);
      const deleted = await this.subscriptions.softDelete(tx, subscriptionId, command.expectedVersion, actor.userId, reason);
      await this.audit(tx, actor, vendorId, subscriptionId, 'subscription.deleted', deleted, reason, undefined, locked);
      await this.regenerate(tx, vendorId, today, dates, actor.userId);
    });
  }
  restore(actor: Actor, vendorId: string, subscriptionId: string, command: SubscriptionVersionReason) {
    const reason = this.reason(command.reason);
    return this.execute(actor, vendorId, 'subscription:manage', 'subscription.restore', async (tx) => {
      const today = await this.today(tx, vendorId);
      const dates = scheduleHorizon(today);
      await this.scheduleDates.lock(tx, vendorId, dates);
      const locked = await this.subscriptions.lockRoot(tx, subscriptionId, command.expectedVersion, true);
      const status = deriveSubscriptionStatus(this.currentPlan(locked), today);
      if (status !== 'cancelled' && status !== 'completed')
        throw new ApplicationError('SUBSCRIPTION_STATE_CONFLICT', 'Only terminal subscription history can be restored', 409);
      const restored = await this.subscriptions.restore(tx, subscriptionId, command.expectedVersion);
      await this.audit(tx, actor, vendorId, subscriptionId, 'subscription.restored', restored, reason, undefined, locked);
      await this.regenerate(tx, vendorId, today, dates, actor.userId);
      return this.project(restored, today);
    });
  }

  listCustomer(actor: Actor, vendorId: string, householdId: string, query: Omit<SubscriptionPageQuery, 'lifecycle'>) {
    return this.execute(actor, vendorId, 'customer:self', 'subscription.self-list', async (tx) => {
      await this.households.requireCustomerSubscriptionHousehold(tx, actor, vendorId, householdId);
      const today = await this.today(tx, vendorId); const page = await this.subscriptions.list(tx, { ...query, lifecycle: 'current' }, today, householdId);
      return { items: page.items.map((item) => this.projectCustomer(item, today)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    });
  }
  getCustomer(actor: Actor, vendorId: string, householdId: string, subscriptionId: string) {
    return this.execute(actor, vendorId, 'customer:self', 'subscription.self-get', async (tx) => {
      await this.households.requireCustomerSubscriptionHousehold(tx, actor, vendorId, householdId);
      return this.projectCustomer(await this.subscriptions.get(tx, subscriptionId, 'current', householdId), await this.today(tx, vendorId));
    });
  }
  historyCustomer(actor: Actor, vendorId: string, householdId: string, subscriptionId: string, query: Pick<SubscriptionPageQuery, 'cursor' | 'limit'>) {
    return this.execute(actor, vendorId, 'customer:self', 'subscription.self-history', async (tx) => {
      await this.households.requireCustomerSubscriptionHousehold(tx, actor, vendorId, householdId);
      const page = await this.subscriptions.history(tx, subscriptionId, query, householdId);
      return {
        items: page.items.map(({ createdBy, supersessionReason, ...revision }) => {
          void createdBy; void supersessionReason; return revision;
        }),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    });
  }

  private mutate(actor: Actor, vendorId: string, subscriptionId: string, command: ModifySubscriptionCommand | SubscriptionTransitionCommand, operation: 'modify' | 'pause' | 'resume' | 'cancel') {
    const reason = this.reason(command.reason); parseSubscriptionPeriod(command.effectiveDate);
    return this.execute(actor, vendorId, 'subscription:manage', `subscription.${operation}`, async (tx) => {
      const today = await this.today(tx, vendorId); this.requireNotPast(command.effectiveDate, today);
      const dates = affectedScheduleDates(today, command.effectiveDate);
      await this.scheduleDates.lock(tx, vendorId, dates);
      const locked = await this.subscriptions.lockForMutation(tx, subscriptionId, command.expectedVersion, command.effectiveDate);
      this.requireTransition(locked.selected.status, operation);
      let config = locked.selected;
      let effectiveTo = operation === 'cancel' ? undefined : locked.selected.effectiveTo;
      if (operation === 'modify') {
        const modify = command as ModifySubscriptionCommand;
        await this.households.requireSubscriptionHousehold(tx, locked.householdId);
        const selected = await this.catalog.requireSubscriptionSelection(tx, modify.productId, modify.unitId, modify.deliverySlotId);
        const period = parseSubscriptionPeriod(modify.effectiveDate, modify.endDate);
        const weekdays = normalizeSubscriptionWeekdays(modify.weekdays);
        if (!periodContainsServiceDay(period.effectiveFrom, period.effectiveTo, weekdays)) this.invalidDate();
        config = { ...locked.selected, productId: modify.productId, unitId: modify.unitId, deliverySlotId: modify.deliverySlotId, quantity: parseSubscriptionQuantity(modify.quantity, selected.unitDecimalScale), weekdays };
        effectiveTo = period.effectiveTo;
      } else if (operation === 'resume') {
        await this.households.requireSubscriptionHousehold(tx, locked.householdId);
        const selected = await this.catalog.requireSubscriptionSelection(tx, config.productId, config.unitId, config.deliverySlotId);
        config = { ...config, quantity: parseSubscriptionQuantity(config.quantity, selected.unitDecimalScale) };
      }
      const status: SubscriptionOperationalStatus = operation === 'pause' ? 'paused' : operation === 'cancel' ? 'cancelled' : operation === 'resume' ? 'active' : config.status;
      if (effectiveTo && !periodContainsServiceDay(command.effectiveDate, effectiveTo, config.weekdays)) this.invalidDate();
      const changed = await this.subscriptions.replacePlan(tx, {
        subscription: locked, replacementRevisionId: randomUUID(), productId: config.productId, unitId: config.unitId,
        deliverySlotId: config.deliverySlotId, quantity: config.quantity, weekdays: config.weekdays, status,
        effectiveFrom: command.effectiveDate, ...(effectiveTo ? { effectiveTo } : {}), reason, createdBy: actor.userId,
      });
      await this.audit(tx, actor, vendorId, subscriptionId, `subscription.${operation === 'modify' ? 'modified' : operation === 'pause' ? 'paused' : operation === 'resume' ? 'resumed' : 'cancelled'}`, changed, reason, {
        replacementRevisionId: changed.replacementRevisionId, supersededRevisionIds: changed.supersededRevisionIds,
      }, locked);
      await this.regenerate(tx, vendorId, today, dates, actor.userId);
      return { ...this.project(changed, today), supersededRevisionCount: changed.supersededRevisionCount };
    });
  }

  private requireTransition(status: SubscriptionOperationalStatus, operation: 'modify' | 'pause' | 'resume' | 'cancel') {
    const allowed = operation === 'resume' ? status === 'paused' : operation === 'pause' ? status === 'active' : status === 'active' || status === 'paused';
    if (!allowed) throw new ApplicationError('SUBSCRIPTION_STATE_CONFLICT', 'Subscription state does not allow this transition', 409);
  }
  private currentPlan(value: SubscriptionAggregateRecord) { return value.revisions.filter(({ supersededAt }) => !supersededAt); }
  private project(value: SubscriptionAggregateRecord, today: string): SubscriptionResult { const { deletedAt, deletedBy, deletionReason, ...root } = value; void deletedBy; void deletionReason; return { ...root, status: deriveSubscriptionStatus(this.currentPlan(value), today), lifecycle: recordLifecycleOf(deletedAt) }; }
  private projectCustomer(value: SubscriptionAggregateRecord, today: string): CustomerSubscriptionResult {
    const { lifecycle, revisions, ...root } = this.project(value, today);
    void lifecycle;
    return { ...root, revisions: revisions.map(({ createdBy, supersessionReason, ...revision }) => {
      void createdBy; void supersessionReason; return revision;
    }) };
  }
  private async today(tx: TransactionContext, vendorId: string) {
    const { timezone } = await this.vendors.getSubscriptionTimezone(tx, vendorId);
    const today = DateTime.now().setZone(timezone).toISODate();
    if (!today) throw new ApplicationError('VENDOR_TIMEZONE_INVALID', 'Vendor timezone is invalid', 503);
    return today;
  }
  private requireNotPast(value: string, today: string) { if (value < today) this.invalidDate(); }
  private invalidDate(): never { throw new ApplicationError('INVALID_SUBSCRIPTION_DATE', 'Subscription date is invalid', 400); }
  private regenerate(tx: TransactionContext, vendorId: string, today: string, dates: readonly string[], userId: string) {
    return this.regeneration.write(tx, vendorId, today, dates, userId);
  }
  private reason(value: string) { const result = value.trim(); if (result.length < 1 || result.length > 500) throw new ApplicationError('INVALID_REASON', 'Reason must be between 1 and 500 characters', 400); return result; }
  private execute<T>(actor: Actor, vendorId: string, permission: 'subscription:read' | 'subscription:manage' | 'customer:self', operation: string, work: (tx: TransactionContext) => Promise<T>) { return this.authorization.execute({ actor, vendorId, permission, operation }, work); }
  private audit(tx: TransactionContext, actor: Actor, vendorId: string, id: string, action: string, value: SubscriptionAggregateRecord, reason?: string, mutation?: Readonly<{ replacementRevisionId: string; supersededRevisionIds: readonly string[] }>, before?: SubscriptionAggregateRecord) {
    const latest = mutation ? value.revisions.find(({ id: revisionId }) => revisionId === mutation.replacementRevisionId) : value.revisions.at(-1);
    return this.audits.append(tx, { id: randomUUID(), vendorId, actorUserId: actor.userId, action, entityType: 'subscription', entityId: id,
      ...(before ? { oldValue: { version: before.version, plan: this.safePlan(before) } } : {}),
      newValue: { version: value.version, ...(latest ? { revisionId: latest.id, effectiveFrom: latest.effectiveFrom, effectiveTo: latest.effectiveTo, status: latest.status, quantity: latest.quantity, weekdays: latest.weekdays, deliverySlotId: latest.deliverySlotId } : {}), ...(mutation ? { supersededRevisionIds: mutation.supersededRevisionIds } : {}) },
      ...(reason ? { reason } : {}), correlationId: requestContextStore.require().correlationId });
  }
  private safePlan(value: SubscriptionAggregateRecord) {
    return value.revisions.filter(({ supersededAt }) => !supersededAt).map(({ id, productId, unitId, deliverySlotId, quantity, weekdays, status, effectiveFrom, effectiveTo }) => ({
      id, productId, unitId, deliverySlotId, quantity, weekdays, status, effectiveFrom, effectiveTo,
    }));
  }
}
