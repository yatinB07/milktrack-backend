import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { Actor } from '../../common/context/request-context.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import {
  PrismaCatalogStore,
  type DeliverySlotRecord,
  type ProductRecord,
  type UnitRecord,
} from '../infrastructure/prisma-catalog.store.js';

export type CatalogStatus = 'active' | 'inactive';
export type CatalogPageQuery = Readonly<{
  cursor?: string;
  limit?: number;
  status?: CatalogStatus;
  search?: string;
}>;
export type CreateUnit = Readonly<{ code: string; name: string; decimalScale: number }>;
export type RenameUnit = Readonly<{ name: string }>;
export type Reason = Readonly<{ reason: string }>;
export type CreateProduct = Readonly<{ code: string; name: string; defaultUnitId: string }>;
export type UpdateProduct = Readonly<{
  expectedVersion: number;
  name?: string;
  status?: CatalogStatus;
}>;
export type VersionedReason = Readonly<{ expectedVersion: number; reason: string }>;
export type RestoreProduct = Readonly<{ expectedVersion: number; reason?: string }>;
export type CreateDeliverySlot = Readonly<{
  code: string; name: string; startLocalTime: string; endLocalTime: string;
}>;
export type RenameDeliverySlot = Readonly<{ name: string }>;
export type CatalogPage<T> = Readonly<{ items: readonly T[]; nextCursor?: string }>;

export abstract class CatalogService {
  abstract requirePricingProduct(tx: TransactionContext, productId: string, unitId: string): Promise<Readonly<{ productId: string; unitId: string }>>;
  abstract getPricingDeliverySlotStart(tx: TransactionContext, slotId: string): Promise<string>;
  abstract listUnits(actor: Actor, vendorId: string, query: CatalogPageQuery): Promise<CatalogPage<UnitRecord>>;
  abstract getUnit(actor: Actor, vendorId: string, unitId: string): Promise<UnitRecord>;
  abstract createUnit(actor: Actor, vendorId: string, command: CreateUnit): Promise<UnitRecord>;
  abstract renameUnit(actor: Actor, vendorId: string, unitId: string, command: RenameUnit): Promise<UnitRecord>;
  abstract deactivateUnit(actor: Actor, vendorId: string, unitId: string, command: Reason): Promise<UnitRecord>;
  abstract reactivateUnit(actor: Actor, vendorId: string, unitId: string, command: Reason): Promise<UnitRecord>;
  abstract listProducts(actor: Actor, vendorId: string, query: CatalogPageQuery): Promise<CatalogPage<ProductRecord>>;
  abstract getProduct(actor: Actor, vendorId: string, productId: string): Promise<ProductRecord>;
  abstract createProduct(actor: Actor, vendorId: string, command: CreateProduct): Promise<ProductRecord>;
  abstract updateProduct(actor: Actor, vendorId: string, productId: string, command: UpdateProduct): Promise<ProductRecord>;
  abstract deleteProduct(actor: Actor, vendorId: string, productId: string, command: VersionedReason): Promise<void>;
  abstract restoreProduct(actor: Actor, vendorId: string, productId: string, command: RestoreProduct): Promise<ProductRecord>;
  abstract listDeliverySlots(actor: Actor, vendorId: string, query: CatalogPageQuery): Promise<CatalogPage<DeliverySlotRecord>>;
  abstract getDeliverySlot(actor: Actor, vendorId: string, slotId: string): Promise<DeliverySlotRecord>;
  abstract createDeliverySlot(actor: Actor, vendorId: string, command: CreateDeliverySlot): Promise<DeliverySlotRecord>;
  abstract renameDeliverySlot(actor: Actor, vendorId: string, slotId: string, command: RenameDeliverySlot): Promise<DeliverySlotRecord>;
  abstract deactivateDeliverySlot(actor: Actor, vendorId: string, slotId: string, command: Reason): Promise<DeliverySlotRecord>;
  abstract reactivateDeliverySlot(actor: Actor, vendorId: string, slotId: string, command: Reason): Promise<DeliverySlotRecord>;
}

const normalizedCode = (value: string) => value.trim().toUpperCase();
const normalizedName = (value: string, maximum: number) => {
  const result = value.trim();
  if (result.length < 1 || result.length > maximum)
    throw new ApplicationError('INVALID_CATALOG_NAME', `Name must be between 1 and ${maximum} characters`, 400);
  return result;
};
const normalizedReason = (value: string) => {
  const result = value.trim();
  if (result.length < 1 || result.length > 500)
    throw new ApplicationError('INVALID_REASON', 'Reason must be between 1 and 500 characters', 400);
  return result;
};

@Injectable()
export class PrismaCatalogService extends CatalogService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(PrismaCatalogStore) private readonly catalog: PrismaCatalogStore,
    @Inject(AuditWriter) private readonly audits: AuditWriter,
  ) { super(); }

  requirePricingProduct(tx: TransactionContext, productId: string, unitId: string) {
    return this.catalog.requirePricingProduct(tx, productId, unitId);
  }
  getPricingDeliverySlotStart(tx: TransactionContext, slotId: string) {
    return this.catalog.getPricingDeliverySlotStart(tx, slotId);
  }

  listUnits(actor: Actor, vendorId: string, query: CatalogPageQuery) {
    return this.execute(actor, vendorId, 'catalog:read', 'catalog.unit-list', (tx) => this.catalog.listUnits(tx, this.normalizeQuery(query)));
  }
  getUnit(actor: Actor, vendorId: string, unitId: string) {
    return this.execute(actor, vendorId, 'catalog:read', 'catalog.unit-get', (tx) => this.catalog.getUnit(tx, unitId));
  }
  createUnit(actor: Actor, vendorId: string, command: CreateUnit) {
    return this.execute(actor, vendorId, 'catalog:manage', 'catalog.unit-create', async (tx) => {
      const unit = await this.catalog.createUnit(tx, {
        id: randomUUID(), vendorId, code: normalizedCode(command.code),
        name: normalizedName(command.name, 100), decimalScale: command.decimalScale,
      });
      await this.audit(tx, actor, vendorId, unit.id, 'unit.created', 'unit', undefined, unit);
      return unit;
    });
  }
  renameUnit(actor: Actor, vendorId: string, unitId: string, command: RenameUnit) {
    return this.execute(actor, vendorId, 'catalog:manage', 'catalog.unit-rename', async (tx) => {
      const change = await this.catalog.renameUnit(tx, unitId, normalizedName(command.name, 100));
      await this.audit(tx, actor, vendorId, unitId, 'unit.renamed', 'unit', change.before, change.after);
      return change.after;
    });
  }
  deactivateUnit(actor: Actor, vendorId: string, unitId: string, command: Reason) {
    return this.changeUnitStatus(actor, vendorId, unitId, 'inactive', 'catalog.unit-deactivate', 'unit.deactivated', normalizedReason(command.reason));
  }
  reactivateUnit(actor: Actor, vendorId: string, unitId: string, command: Reason) {
    return this.changeUnitStatus(actor, vendorId, unitId, 'active', 'catalog.unit-reactivate', 'unit.reactivated', normalizedReason(command.reason));
  }
  listProducts(actor: Actor, vendorId: string, query: CatalogPageQuery) {
    return this.execute(actor, vendorId, 'catalog:read', 'catalog.product-list', (tx) => this.catalog.listProducts(tx, this.normalizeQuery(query)));
  }
  getProduct(actor: Actor, vendorId: string, productId: string) {
    return this.execute(actor, vendorId, 'catalog:read', 'catalog.product-get', (tx) => this.catalog.getProduct(tx, productId));
  }
  createProduct(actor: Actor, vendorId: string, command: CreateProduct) {
    return this.execute(actor, vendorId, 'catalog:manage', 'catalog.product-create', async (tx) => {
      const product = await this.catalog.createProduct(tx, {
        id: randomUUID(), vendorId, code: normalizedCode(command.code),
        name: normalizedName(command.name, 160), defaultUnitId: command.defaultUnitId,
      });
      await this.audit(tx, actor, vendorId, product.id, 'product.created', 'product', undefined, product);
      return product;
    });
  }
  updateProduct(actor: Actor, vendorId: string, productId: string, command: UpdateProduct) {
    if (command.name === undefined && command.status === undefined)
      throw new ApplicationError('EMPTY_UPDATE', 'At least one field must be updated', 400);
    return this.execute(actor, vendorId, 'catalog:manage', 'catalog.product-update', async (tx) => {
      const change = await this.catalog.updateProduct(tx, productId, command.expectedVersion, {
        ...(command.name === undefined ? {} : { name: normalizedName(command.name, 160) }),
        ...(command.status === undefined ? {} : { status: command.status }),
      });
      await this.audit(tx, actor, vendorId, productId, 'product.updated', 'product', change.before, change.after);
      return change.after;
    });
  }
  async deleteProduct(actor: Actor, vendorId: string, productId: string, command: VersionedReason) {
    const reason = normalizedReason(command.reason);
    await this.execute(actor, vendorId, 'catalog:manage', 'catalog.product-delete', async (tx) => {
      const change = await this.catalog.deleteProduct(tx, productId, command.expectedVersion, actor.userId, reason);
      await this.audit(tx, actor, vendorId, productId, 'product.deleted', 'product', change.before, change.after, reason);
    });
  }
  restoreProduct(actor: Actor, vendorId: string, productId: string, command: RestoreProduct) {
    const reason = command.reason === undefined ? undefined : normalizedReason(command.reason);
    return this.execute(actor, vendorId, 'catalog:manage', 'catalog.product-restore', async (tx) => {
      const change = await this.catalog.restoreProduct(tx, productId, command.expectedVersion);
      await this.audit(tx, actor, vendorId, productId, 'product.restored', 'product', change.before, change.after, reason);
      return change.after;
    });
  }
  listDeliverySlots(actor: Actor, vendorId: string, query: CatalogPageQuery) {
    return this.execute(actor, vendorId, 'catalog:read', 'catalog.delivery-slot-list', (tx) => this.catalog.listDeliverySlots(tx, this.normalizeQuery(query)));
  }
  getDeliverySlot(actor: Actor, vendorId: string, slotId: string) {
    return this.execute(actor, vendorId, 'catalog:read', 'catalog.delivery-slot-get', (tx) => this.catalog.getDeliverySlot(tx, slotId));
  }
  createDeliverySlot(actor: Actor, vendorId: string, command: CreateDeliverySlot) {
    if (command.startLocalTime >= command.endLocalTime)
      throw new ApplicationError('INVALID_DELIVERY_SLOT_TIME_RANGE', 'Start time must be before end time', 400);
    return this.execute(actor, vendorId, 'catalog:manage', 'catalog.delivery-slot-create', async (tx) => {
      const slot = await this.catalog.createDeliverySlot(tx, {
        id: randomUUID(), vendorId, code: normalizedCode(command.code),
        name: normalizedName(command.name, 100),
        startLocalTime: command.startLocalTime, endLocalTime: command.endLocalTime,
      });
      await this.audit(tx, actor, vendorId, slot.id, 'delivery_slot.created', 'delivery_slot', undefined, slot);
      return slot;
    });
  }
  renameDeliverySlot(actor: Actor, vendorId: string, slotId: string, command: RenameDeliverySlot) {
    return this.execute(actor, vendorId, 'catalog:manage', 'catalog.delivery-slot-rename', async (tx) => {
      const change = await this.catalog.renameDeliverySlot(tx, slotId, normalizedName(command.name, 100));
      await this.audit(tx, actor, vendorId, slotId, 'delivery_slot.renamed', 'delivery_slot', change.before, change.after);
      return change.after;
    });
  }
  deactivateDeliverySlot(actor: Actor, vendorId: string, slotId: string, command: Reason) {
    return this.changeDeliverySlotStatus(actor, vendorId, slotId, false, 'catalog.delivery-slot-deactivate', 'delivery_slot.deactivated', normalizedReason(command.reason));
  }
  reactivateDeliverySlot(actor: Actor, vendorId: string, slotId: string, command: Reason) {
    return this.changeDeliverySlotStatus(actor, vendorId, slotId, true, 'catalog.delivery-slot-reactivate', 'delivery_slot.reactivated', normalizedReason(command.reason));
  }

  private changeUnitStatus(actor: Actor, vendorId: string, unitId: string, status: CatalogStatus, operation: string, action: string, reason: string) {
    return this.execute(actor, vendorId, 'catalog:manage', operation, async (tx) => {
      const change = await this.catalog.changeUnitStatus(tx, unitId, status);
      await this.audit(tx, actor, vendorId, unitId, action, 'unit', change.before, change.after, reason);
      return change.after;
    });
  }
  private changeDeliverySlotStatus(actor: Actor, vendorId: string, slotId: string, active: boolean, operation: string, action: string, reason: string) {
    return this.execute(actor, vendorId, 'catalog:manage', operation, async (tx) => {
      const change = await this.catalog.changeDeliverySlotStatus(tx, slotId, active);
      await this.audit(tx, actor, vendorId, slotId, action, 'delivery_slot', change.before, change.after, reason);
      return change.after;
    });
  }
  private normalizeQuery(query: CatalogPageQuery): CatalogPageQuery {
    const search = query.search?.trim();
    return { ...query, status: query.status ?? 'active', ...(search ? { search } : { search: undefined }) };
  }
  private execute<T>(actor: Actor, vendorId: string, permission: 'catalog:read' | 'catalog:manage', operation: string, work: (tx: TransactionContext) => Promise<T>) {
    return this.authorization.execute({ actor, vendorId, permission, operation }, work);
  }
  private audit(tx: TransactionContext, actor: Actor, vendorId: string, entityId: string, action: string, entityType: string, oldValue?: unknown, newValue?: unknown, reason?: string) {
    return this.audits.append(tx, {
      id: randomUUID(), vendorId, actorUserId: actor.userId, action, entityType, entityId,
      ...(oldValue === undefined ? {} : { oldValue }), ...(newValue === undefined ? {} : { newValue }),
      ...(reason ? { reason } : {}), correlationId: requestContextStore.get()?.correlationId ?? randomUUID(),
    });
  }
}
