import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import { CatalogService } from '../../catalog/application/catalog.service.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { Actor } from '../../common/context/request-context.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { normalizeRouteCode, normalizeRouteName, normalizeRouteReason } from '../domain/route-rules.js';
import { RouteStore, type RoutePageQuery, type RouteRecord, type RouteStatus } from './route.store.js';

export type CreateRouteCommand = Readonly<{ code: string; name: string; deliverySlotId: string }>;
export type RenameRouteCommand = Readonly<{ name: string; expectedVersion: number }>;
export type RouteVersionReason = Readonly<{ expectedVersion: number; reason: string }>;

export abstract class RouteService {
  abstract list(actor: Actor, vendorId: string, query: RoutePageQuery): Promise<Readonly<{ items: readonly RouteRecord[]; nextCursor?: string }>>;
  abstract get(actor: Actor, vendorId: string, routeId: string): Promise<RouteRecord>;
  abstract create(actor: Actor, vendorId: string, command: CreateRouteCommand): Promise<RouteRecord>;
  abstract rename(actor: Actor, vendorId: string, routeId: string, command: RenameRouteCommand): Promise<RouteRecord>;
  abstract deactivate(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason): Promise<RouteRecord>;
  abstract reactivate(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason): Promise<RouteRecord>;
  abstract softDelete(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason): Promise<void>;
  abstract restore(actor: Actor, vendorId: string, routeId: string, command: RouteVersionReason): Promise<RouteRecord>;
}

@Injectable()
export class DefaultRouteService extends RouteService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(RouteStore) private readonly routes: RouteStore,
    @Inject(CatalogService) private readonly catalog: CatalogService,
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
  private audit(tx: TransactionContext, actor: Actor, vendorId: string, routeId: string, action: string, before?: RouteRecord, after?: RouteRecord, reason?: string) {
    const safe = (route: RouteRecord) => ({ code: route.code, name: route.name, deliverySlotId: route.deliverySlotId, status: route.status, version: route.version });
    return this.audits.append(tx, { id: randomUUID(), vendorId, actorUserId: actor.userId, action, entityType: 'route', entityId: routeId,
      ...(before ? { oldValue: safe(before) } : {}), ...(after ? { newValue: safe(after) } : {}), ...(reason ? { reason } : {}), correlationId: requestContextStore.require().correlationId });
  }
}
