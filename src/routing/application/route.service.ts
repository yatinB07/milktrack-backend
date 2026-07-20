import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import { CatalogService } from '../../catalog/application/catalog.service.js';
import { HouseholdService } from '../../customers/application/household.service.js';
import { MembershipService } from '../../memberships/application/membership.service.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { Actor } from '../../common/context/request-context.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { VendorService } from '../../vendors/application/vendor.service.js';
import { ScheduleDateLock } from '../../schedule-coordination/application/schedule-date-lock.js';
import { ScheduleRegenerationWriter } from '../../schedule-coordination/application/schedule-regeneration-writer.js';
import { affectedScheduleDates, scheduleHorizon } from '../../schedule-coordination/application/schedule-horizon.js';
import { normalizeRouteCode, normalizeRouteName, normalizeRouteReason } from '../domain/route-rules.js';
import { normalizeRouteAssignmentMutation, validateRouteAssignmentDate } from '../domain/route-assignment-rules.js';
import { RouteAssignmentStore, type RouteAssignmentMutation, type RouteAssignmentPage, type RouteAssignmentPageQuery } from './route-assignment.store.js';
import { normalizeRouteStopReplacement, validateRouteStopDate } from '../domain/route-stop-rules.js';
import { RouteStopPlanStore, type RouteStopPageQuery, type RouteStopProjection, type RouteStopSnapshot } from './route-stop-plan.store.js';
import { RouteStore, type RoutePageQuery, type RouteRecord, type RouteStatus } from './route.store.js';

export type CreateRouteCommand = Readonly<{ code: string; name: string; deliverySlotId: string }>;
export type RenameRouteCommand = Readonly<{ name: string; expectedVersion: number }>;
export type RouteVersionReason = Readonly<{ expectedVersion: number; reason: string }>;
export type ReplaceRouteStopsCommand = Readonly<{ effectiveDate: string; expectedVersion: number; reason: string; householdIds: readonly string[] }>;
export type AssignRouteCommand = Readonly<{ agentMembershipId: string; expectedVersion: number; reason: string }>;

export abstract class RouteService {
  abstract list(actor: Actor, vendorId: string, query: RoutePageQuery): Promise<Readonly<{ items: readonly RouteRecord[]; nextCursor?: string }>>;
  abstract get(actor: Actor, vendorId: string, routeId: string): Promise<RouteRecord>;
  abstract create(actor: Actor, vendorId: string, command: CreateRouteCommand): Promise<RouteRecord>;
  abstract rename(actor: Actor, vendorId: string, routeId: string, command: RenameRouteCommand): Promise<RouteRecord>;
  abstract deactivate(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason): Promise<RouteRecord>;
  abstract reactivate(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason): Promise<RouteRecord>;
  abstract softDelete(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason): Promise<void>;
  abstract restore(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason): Promise<RouteRecord>;
  abstract listStops(actor: Actor, vendorId: string, routeId: string, query: RouteStopPageQuery): Promise<RouteStopProjection>;
  abstract replaceStops(actor: Actor, vendorId: string, routeId: string, command: ReplaceRouteStopsCommand): Promise<RouteStopProjection>;
  abstract listAssignments(actor: Actor, vendorId: string, routeId: string, query: RouteAssignmentPageQuery): Promise<RouteAssignmentPage>;
  abstract assign(actor: Actor, vendorId: string, routeId: string, serviceDate: string, command: AssignRouteCommand): Promise<RouteAssignmentMutation>;
  abstract cancelAssignment(actor: Actor, vendorId: string, routeId: string, serviceDate: string, command: RouteVersionReason): Promise<RouteAssignmentMutation>;
  abstract listSelfAssignments(actor: Actor, vendorId: string, query: Readonly<{ serviceDate: string; cursor?: string; limit?: number }>): Promise<RouteAssignmentPage>;
}

@Injectable()
export class DefaultRouteService extends RouteService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(RouteStore) private readonly routes: RouteStore,
    @Inject(RouteStopPlanStore) private readonly stopPlans: RouteStopPlanStore,
    @Inject(RouteAssignmentStore) private readonly assignments: RouteAssignmentStore,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(VendorService) private readonly vendors: VendorService,
    @Inject(AuditWriter) private readonly audits: AuditWriter,
    @Inject(ScheduleDateLock) private readonly scheduleDates: ScheduleDateLock,
    @Inject(ScheduleRegenerationWriter) private readonly regeneration?: ScheduleRegenerationWriter,
  ) { super(); }

  list(actor: Actor, vendorId: string, query: RoutePageQuery) {
    const search = query.search?.trim();
    return this.execute(actor, vendorId, 'route:read', 'route.list', (tx) => this.routes.list(tx, { ...query, ...(search ? { search } : { search: undefined }) }));
  }
  get(actor: Actor, vendorId: string, routeId: string) { return this.execute(actor, vendorId, 'route:read', 'route.get', (tx) => this.routes.get(tx, routeId)); }
  create(actor: Actor, vendorId: string, command: CreateRouteCommand) {
    const code = normalizeRouteCode(command.code); const name = normalizeRouteName(command.name);
    return this.execute(actor, vendorId, 'route:manage', 'route.create', async (tx) => {
      await this.catalog.requireRouteDeliverySlot(tx, command.deliverySlotId);
      const route = await this.routes.create(tx, { id: randomUUID(), vendorId, code, name, deliverySlotId: command.deliverySlotId, status: 'active', version: 1, createdAt: new Date(), updatedAt: new Date() });
      await this.audit(tx, actor, vendorId, route.id, 'route.created', undefined, route);
      return route;
    });
  }
  rename(actor: Actor, vendorId: string, routeId: string, command: RenameRouteCommand) {
    const name = normalizeRouteName(command.name);
    return this.execute(actor, vendorId, 'route:manage', 'route.rename', async (tx) => {
      const change = await this.routes.rename(tx, routeId, command.expectedVersion, name);
      await this.audit(tx, actor, vendorId, routeId, 'route.renamed', change.before, change.after); return change.after;
    });
  }
  deactivate(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason) { return this.changeStatus(actor, vendorId, routeId, command, 'inactive', 'route.deactivate', 'route.deactivated'); }
  reactivate(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason) { return this.changeStatus(actor, vendorId, routeId, command, 'active', 'route.reactivate', 'route.reactivated'); }
  async softDelete(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason) {
    const reason = normalizeRouteReason(command.reason);
    await this.execute(actor, vendorId, 'route:manage', 'route.delete', async (tx) => {
      const today = await this.today(tx, vendorId);
      const dates = scheduleHorizon(today);
      await this.scheduleDates.lock(tx, vendorId, dates);
      const route = await this.routes.lockRoot(tx, routeId, command.expectedVersion);
      if (route.status !== 'inactive')
        throw new ApplicationError('ROUTE_DELETE_REQUIRES_INACTIVE', 'Route must be inactive before deletion', 409);
      if (await this.stopPlans.hasCurrentOrFutureStops(tx, routeId, today))
        throw new ApplicationError('ROUTE_DELETE_REQUIRES_EMPTY', 'Route must have no current or future stops before deletion', 409);
      if (await this.assignments.hasAssignedOnOrAfter(tx, routeId, today))
        throw new ApplicationError('ROUTE_DELETE_REQUIRES_EMPTY', 'Route must have no current or future assignments before deletion', 409);
      const change = await this.routes.softDelete(tx, routeId, command.expectedVersion, actor.userId, reason);
      await this.audit(tx, actor, vendorId, routeId, 'route.deleted', change.before, change.after, reason);
      await this.regenerate(tx, vendorId, today, dates, actor.userId);
    });
  }
  restore(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason) {
    const reason = normalizeRouteReason(command.reason);
    return this.execute(actor, vendorId, 'route:manage', 'route.restore', async (tx) => {
      const today = await this.today(tx, vendorId);
      const dates = scheduleHorizon(today);
      await this.scheduleDates.lock(tx, vendorId, dates);
      const change = await this.routes.restore(tx, routeId, command.expectedVersion);
      await this.audit(tx, actor, vendorId, routeId, 'route.restored', change.before, change.after, reason);
      await this.regenerate(tx, vendorId, today, dates, actor.userId); return change.after;
    });
  }
  listStops(actor: Actor, vendorId: string, routeId: string, query: RouteStopPageQuery) {
    validateRouteStopDate(query.serviceDate);
    return this.execute(actor, vendorId, 'route:read', 'route.stops-list', async (tx) =>
      this.stopPlans.list(tx, await this.routes.get(tx, routeId), query));
  }
  replaceStops(actor: Actor, vendorId: string, routeId: string, command: ReplaceRouteStopsCommand) {
    return this.execute(actor, vendorId, 'route:manage', 'route.stops-replace', async (tx) => {
      const today = await this.today(tx, vendorId);
      const normalized = normalizeRouteStopReplacement(command.effectiveDate, command.householdIds, command.reason, today);
      const dates = affectedScheduleDates(today, normalized.effectiveDate);
      await this.scheduleDates.lock(tx, vendorId, dates);
      const route = await this.routes.lockRoot(tx, routeId, command.expectedVersion);
      if (route.status !== 'active') throw new ApplicationError('ROUTE_STATE_CONFLICT', 'Route state does not allow stop replacement', 409);
      await this.catalog.requireRouteDeliverySlot(tx, route.deliverySlotId);
      if(normalized.householdIds.length>0) await this.households.requireRouteHouseholds(tx,[...normalized.householdIds].sort());
      const {projection,previous}=await this.stopPlans.replace(tx, { route, ...normalized, createdBy: actor.userId });
      await this.auditStops(tx,actor,vendorId,route,normalized.effectiveDate,normalized.householdIds,normalized.reason,previous,projection);
      await this.regenerate(tx, vendorId, today, dates, actor.userId);
      return projection;
    });
  }
  listAssignments(actor: Actor, vendorId: string, routeId: string, query: RouteAssignmentPageQuery) {
    if (query.fromDate) validateRouteAssignmentDate(query.fromDate);
    if (query.toDate) validateRouteAssignmentDate(query.toDate);
    if (query.fromDate && query.toDate && query.fromDate > query.toDate) {
      throw new ApplicationError('INVALID_ROUTE_DATE', 'Assignment date range is invalid', 400);
    }
    return this.execute(actor, vendorId, 'route:read', 'route.assignments-list', async (tx) =>
      this.assignments.list(tx, await this.routes.get(tx, routeId), query));
  }

  assign(actor: Actor, vendorId: string, routeId: string, serviceDate: string, command: AssignRouteCommand) {
    return this.execute(actor, vendorId, 'route:manage', 'route.assignment-put', async (tx) => {
      const today = await this.today(tx, vendorId);
      const normalized = normalizeRouteAssignmentMutation(
        serviceDate,
        command.reason,
        today,
      );
      const dates = await this.lockAssignmentDate(tx, vendorId, normalized.serviceDate, today);
      const route = await this.routes.lockRoot(tx, routeId, command.expectedVersion);
      if (route.status !== 'active') {
        throw new ApplicationError('ROUTE_STATE_CONFLICT', 'Route state does not allow assignment', 409);
      }
      await this.catalog.requireRouteDeliverySlot(tx, route.deliverySlotId);
      await this.memberships.requireRouteAgent(tx, vendorId, command.agentMembershipId);
      const result = await this.assignments.assign(tx, {
        route,
        serviceDate: normalized.serviceDate,
        agentMembershipId: command.agentMembershipId,
        actorId: actor.userId,
      });
      const action = result.created || result.previous?.status === 'cancelled'
        ? 'route_assignment.assigned'
        : 'route_assignment.reassigned';
      await this.auditAssignment(tx, actor, vendorId, route, result, action, normalized.reason);
      await this.regenerate(tx, vendorId, today, dates, actor.userId);
      return result;
    });
  }

  cancelAssignment(actor: Actor, vendorId: string, routeId: string, serviceDate: string, command: RouteVersionReason) {
    return this.execute(actor, vendorId, 'route:manage', 'route.assignment-cancel', async (tx) => {
      const today = await this.today(tx, vendorId);
      const normalized = normalizeRouteAssignmentMutation(
        serviceDate,
        command.reason,
        today,
      );
      const dates = await this.lockAssignmentDate(tx, vendorId, normalized.serviceDate, today);
      const route = await this.routes.lockRoot(tx, routeId, command.expectedVersion);
      const result = await this.assignments.cancel(tx, {
        route,
        serviceDate: normalized.serviceDate,
        actorId: actor.userId,
        reason: normalized.reason,
      });
      await this.auditAssignment(
        tx,
        actor,
        vendorId,
        route,
        result,
        'route_assignment.cancelled',
        normalized.reason,
      );
      await this.regenerate(tx, vendorId, today, dates, actor.userId);
      return result;
    });
  }

  listSelfAssignments(
    actor: Actor,
    vendorId: string,
    query: Readonly<{ serviceDate: string; cursor?: string; limit?: number }>,
  ) {
    validateRouteAssignmentDate(query.serviceDate);
    return this.execute(actor, vendorId, 'route:self', 'route.assignments-self', async (tx) => {
      const agent = await this.memberships.resolveSelfRouteAgent(tx, vendorId, actor.userId);
      return this.assignments.listSelf(tx, agent.membershipId, query.serviceDate, query);
    });
  }
  private changeStatus(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason, status: RouteStatus, operation: string, action: string) {
    const reason = normalizeRouteReason(command.reason);
    return this.execute(actor, vendorId, 'route:manage', operation, async (tx) => {
      const today = await this.today(tx, vendorId);
      const dates = scheduleHorizon(today);
      await this.scheduleDates.lock(tx, vendorId, dates);
      if (status === 'active') {
        const route = await this.routes.lockRoot(tx, routeId, command.expectedVersion); await this.catalog.requireRouteDeliverySlot(tx, route.deliverySlotId);
      }
      const change = await this.routes.changeStatus(tx, routeId, command.expectedVersion, status);
      await this.audit(tx, actor, vendorId, routeId, action, change.before, change.after, reason);
      await this.regenerate(tx, vendorId, today, dates, actor.userId); return change.after;
    });
  }
  private execute<T>(actor: Actor, vendorId: string, permission: 'route:read' | 'route:manage' | 'route:self', operation: string, work: (tx: TransactionContext) => Promise<T>) { return this.authorization.execute({ actor, vendorId, permission, operation }, work); }
  private async today(tx: TransactionContext, vendorId: string) {
    const { timezone } = await this.vendors.getSubscriptionTimezone(tx, vendorId);
    const today = DateTime.now().setZone(timezone).toISODate();
    if (!today) throw new ApplicationError('VENDOR_TIMEZONE_INVALID', 'Vendor timezone is invalid', 503);
    return today;
  }
  private async lockAssignmentDate(tx: TransactionContext, vendorId: string, serviceDate: string, today: string) {
    const dates = scheduleHorizon(today);
    const affected = dates.includes(serviceDate) ? [serviceDate] : [];
    if (affected.length > 0) await this.scheduleDates.lock(tx, vendorId, affected);
    return affected;
  }
  private regenerate(tx: TransactionContext, vendorId: string, today: string, dates: readonly string[], userId: string) {
    return this.regeneration?.write(tx, vendorId, today, dates, userId);
  }
  private auditStops(tx:TransactionContext,actor:Actor,vendorId:string,route:RouteRecord,effectiveDate:string,householdIds:readonly string[],reason:string,previous:RouteStopSnapshot,projection:RouteStopProjection) {
    const safe=(ids:readonly string[],value:RouteStopSnapshot|RouteStopProjection,version:number)=>({householdIds:[...ids],effectiveDate,...(value.startDate?{startDate:value.startDate}:{}),...(value.endDate?{endDate:value.endDate}:{}),deliverySlotId:route.deliverySlotId,routeStatus:route.status,routeVersion:version});
    return this.audits.append(tx,{id:randomUUID(),vendorId,actorUserId:actor.userId,action:'route_stops.replaced',entityType:'route',entityId:route.id,oldValue:safe(previous.stops.map(({householdId})=>householdId),previous,route.version),newValue:safe(householdIds,projection,projection.routeVersion),reason,correlationId:requestContextStore.require().correlationId});
  }
  private auditAssignment(tx:TransactionContext,actor:Actor,vendorId:string,route:RouteRecord,result:RouteAssignmentMutation,action:string,reason:string){
    const safe=(assignment:RouteAssignmentMutation['assignment'],version:number)=>({assignmentId:assignment.id,agentMembershipId:assignment.agentMembershipId,serviceDate:assignment.serviceDate,status:assignment.status,deliverySlotId:assignment.deliverySlotId,routeVersion:version});
    return this.audits.append(tx,{id:randomUUID(),vendorId,actorUserId:actor.userId,action,entityType:'route_assignment',entityId:result.assignment.id,...(result.previous?{oldValue:safe(result.previous,route.version)}:{}),newValue:safe(result.assignment,result.routeVersion),reason,correlationId:requestContextStore.require().correlationId});
  }
  private audit(tx: TransactionContext, actor: Actor, vendorId: string, routeId: string, action: string, before?: RouteRecord, after?: RouteRecord, reason?: string) {
    const safe = (route: RouteRecord) => ({ code: route.code, name: route.name, deliverySlotId: route.deliverySlotId, status: route.status, version: route.version });
    return this.audits.append(tx, { id: randomUUID(), vendorId, actorUserId: actor.userId, action, entityType: 'route', entityId: routeId,
      ...(before ? { oldValue: safe(before) } : {}), ...(after ? { newValue: safe(after) } : {}), ...(reason ? { reason } : {}), correlationId: requestContextStore.require().correlationId });
  }
}
