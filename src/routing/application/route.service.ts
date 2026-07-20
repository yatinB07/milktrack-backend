import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import { CatalogService } from '../../catalog/application/catalog.service.js';
import { HouseholdService } from '../../customers/application/household.service.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { Actor } from '../../common/context/request-context.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { VendorService } from '../../vendors/application/vendor.service.js';
import { normalizeRouteCode, normalizeRouteName, normalizeRouteReason } from '../domain/route-rules.js';
import { normalizeRouteStopReplacement, validateRouteStopDate } from '../domain/route-stop-rules.js';
import { RouteStopPlanStore, type RouteStopPageQuery, type RouteStopProjection, type RouteStopSnapshot } from './route-stop-plan.store.js';
import { RouteStore, type RoutePageQuery, type RouteRecord, type RouteStatus } from './route.store.js';

export type CreateRouteCommand = Readonly<{ code: string; name: string; deliverySlotId: string }>;
export type RenameRouteCommand = Readonly<{ name: string; expectedVersion: number }>;
export type RouteVersionReason = Readonly<{ expectedVersion: number; reason: string }>;
export type ReplaceRouteStopsCommand = Readonly<{ effectiveDate: string; expectedVersion: number; reason: string; householdIds: readonly string[] }>;

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
}

@Injectable()
export class DefaultRouteService extends RouteService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(RouteStore) private readonly routes: RouteStore,
    @Inject(RouteStopPlanStore) private readonly stopPlans: RouteStopPlanStore,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(VendorService) private readonly vendors: VendorService,
    @Inject(AuditWriter) private readonly audits: AuditWriter,
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
      const route = await this.routes.lockRoot(tx, routeId, command.expectedVersion);
      if (route.status !== 'inactive')
        throw new ApplicationError('ROUTE_DELETE_REQUIRES_INACTIVE', 'Route must be inactive before deletion', 409);
      if (await this.stopPlans.hasCurrentOrFutureStops(tx, routeId, await this.today(tx, vendorId)))
        throw new ApplicationError('ROUTE_DELETE_REQUIRES_EMPTY', 'Route must have no current or future stops before deletion', 409);
      const change = await this.routes.softDelete(tx, routeId, command.expectedVersion, actor.userId, reason);
      await this.audit(tx, actor, vendorId, routeId, 'route.deleted', change.before, change.after, reason);
    });
  }
  restore(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason) {
    const reason = normalizeRouteReason(command.reason);
    return this.execute(actor, vendorId, 'route:manage', 'route.restore', async (tx) => {
      const change = await this.routes.restore(tx, routeId, command.expectedVersion);
      await this.audit(tx, actor, vendorId, routeId, 'route.restored', change.before, change.after, reason); return change.after;
    });
  }
  listStops(actor: Actor, vendorId: string, routeId: string, query: RouteStopPageQuery) {
    validateRouteStopDate(query.serviceDate);
    return this.execute(actor, vendorId, 'route:read', 'route.stops-list', async (tx) =>
      this.stopPlans.list(tx, await this.routes.get(tx, routeId), query));
  }
  replaceStops(actor: Actor, vendorId: string, routeId: string, command: ReplaceRouteStopsCommand) {
    return this.execute(actor, vendorId, 'route:manage', 'route.stops-replace', async (tx) => {
      const normalized = normalizeRouteStopReplacement(command.effectiveDate, command.householdIds, command.reason, await this.today(tx, vendorId));
      const route = await this.routes.lockRoot(tx, routeId, command.expectedVersion);
      if (route.status !== 'active') throw new ApplicationError('ROUTE_STATE_CONFLICT', 'Route state does not allow stop replacement', 409);
      await this.catalog.requireRouteDeliverySlot(tx, route.deliverySlotId);
      if(normalized.householdIds.length>0) await this.households.requireRouteHouseholds(tx,[...normalized.householdIds].sort());
      const {projection,previous}=await this.stopPlans.replace(tx, { route, ...normalized, createdBy: actor.userId });
      await this.auditStops(tx,actor,vendorId,route,normalized.effectiveDate,normalized.householdIds,normalized.reason,previous,projection);
      return projection;
    });
  }
  private changeStatus(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason, status: RouteStatus, operation: string, action: string) {
    const reason = normalizeRouteReason(command.reason);
    return this.execute(actor, vendorId, 'route:manage', operation, async (tx) => {
      if (status === 'active') {
        const route = await this.routes.lockRoot(tx, routeId, command.expectedVersion); await this.catalog.requireRouteDeliverySlot(tx, route.deliverySlotId);
      }
      const change = await this.routes.changeStatus(tx, routeId, command.expectedVersion, status);
      await this.audit(tx, actor, vendorId, routeId, action, change.before, change.after, reason); return change.after;
    });
  }
  private execute<T>(actor: Actor, vendorId: string, permission: 'route:read' | 'route:manage', operation: string, work: (tx: TransactionContext) => Promise<T>) { return this.authorization.execute({ actor, vendorId, permission, operation }, work); }
  private async today(tx: TransactionContext, vendorId: string) {
    const { timezone } = await this.vendors.getSubscriptionTimezone(tx, vendorId);
    const today = DateTime.now().setZone(timezone).toISODate();
    if (!today) throw new ApplicationError('VENDOR_TIMEZONE_INVALID', 'Vendor timezone is invalid', 503);
    return today;
  }
  private auditStops(tx:TransactionContext,actor:Actor,vendorId:string,route:RouteRecord,effectiveDate:string,householdIds:readonly string[],reason:string,previous:RouteStopSnapshot,projection:RouteStopProjection) {
    const safe=(ids:readonly string[],value:RouteStopSnapshot|RouteStopProjection,version:number)=>({householdIds:[...ids],effectiveDate,...(value.startDate?{startDate:value.startDate}:{}),...(value.endDate?{endDate:value.endDate}:{}),deliverySlotId:route.deliverySlotId,routeStatus:route.status,routeVersion:version});
    return this.audits.append(tx,{id:randomUUID(),vendorId,actorUserId:actor.userId,action:'route_stops.replaced',entityType:'route',entityId:route.id,oldValue:safe(previous.stops.map(({householdId})=>householdId),previous,route.version),newValue:safe(householdIds,projection,projection.routeVersion),reason,correlationId:requestContextStore.require().correlationId});
  }
  private audit(tx: TransactionContext, actor: Actor, vendorId: string, routeId: string, action: string, before?: RouteRecord, after?: RouteRecord, reason?: string) {
    const safe = (route: RouteRecord) => ({ code: route.code, name: route.name, deliverySlotId: route.deliverySlotId, status: route.status, version: route.version });
    return this.audits.append(tx, { id: randomUUID(), vendorId, actorUserId: actor.userId, action, entityType: 'route', entityId: routeId,
      ...(before ? { oldValue: safe(before) } : {}), ...(after ? { newValue: safe(after) } : {}), ...(reason ? { reason } : {}), correlationId: requestContextStore.require().correlationId });
  }
}
