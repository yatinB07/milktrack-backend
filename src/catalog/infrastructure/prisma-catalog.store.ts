import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { CatalogPageQuery, CatalogStatus, CreateDeliverySlot, CreateProduct, CreateUnit } from '../application/catalog.service.js';

export type UnitRecord = Readonly<{ id: string; vendorId: string; code: string; name: string; decimalScale: number; status: CatalogStatus; createdAt: Date; updatedAt: Date }>;
export type ProductRecord = Readonly<{ id: string; vendorId: string; code: string; name: string; defaultUnitId: string; status: CatalogStatus; version: number; createdAt: Date; updatedAt: Date }>;
type ProductRow = ProductRecord & Readonly<{ deletedAt: Date | null; deletedBy: string | null; deletionReason: string | null }>;
export type DeliverySlotRecord = Readonly<{
  id: string; vendorId: string; code: string; name: string;
  startLocalTime: string; endLocalTime: string; status: CatalogStatus;
  createdAt: Date; updatedAt: Date;
}>;

const unitSelect = { id: true, vendorId: true, code: true, name: true, decimalScale: true, status: true, createdAt: true, updatedAt: true } as const;
const productSelect = { id: true, vendorId: true, code: true, name: true, defaultUnitId: true, status: true, version: true, deletedAt: true, deletedBy: true, deletionReason: true, createdAt: true, updatedAt: true } as const;
const deliverySlotSelect = { id: true, vendorId: true, code: true, name: true, startLocalTime: true, endLocalTime: true, active: true, createdAt: true, updatedAt: true } as const;
const error = (code: string, message: string, status: number) => new ApplicationError(code, message, status);

@Injectable()
export class PrismaCatalogStore {
  private readonly cursors = new CursorCodec();

  async listUnits(context: TransactionContext, query: CatalogPageQuery) {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await tx.unit.findMany({
      where: {
        status: query.status ?? 'active',
        ...(query.search ? { OR: [{ code: { contains: query.search, mode: 'insensitive' } }, { name: { contains: query.search, mode: 'insensitive' } }] } : {}),
        ...(cursor ? { AND: [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] } : {}),
      }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: unitSelect,
    });
    return this.page(rows, limit);
  }
  async getUnit(context: TransactionContext, id: string) {
    const row = await unwrapPrismaTransaction(context).unit.findFirst({ where: { id }, select: unitSelect });
    if (!row) throw error('CATALOG_UNIT_NOT_FOUND', 'Unit was not found', 404);
    return row;
  }
  async createUnit(context: TransactionContext, input: CreateUnit & { id: string; vendorId: string }) {
    try { return await unwrapPrismaTransaction(context).unit.create({ data: input, select: unitSelect }); }
    catch (cause) { this.translate(cause, 'unit'); throw cause; }
  }
  async renameUnit(context: TransactionContext, id: string, name: string) {
    const before = await this.lockUnit(context, id);
    const after = await unwrapPrismaTransaction(context).unit.update({ where: { id }, data: { name }, select: unitSelect });
    return { before, after };
  }
  async changeUnitStatus(context: TransactionContext, id: string, status: CatalogStatus) {
    const tx = unwrapPrismaTransaction(context);
    const before = await this.lockUnit(context, id);
    if (status === 'inactive') {
      const count = await tx.product.count({ where: { defaultUnitId: id, status: 'active', deletedAt: null } });
      if (count > 0) throw error('CATALOG_UNIT_IN_USE', 'Unit is used by an active product', 409);
    }
    const after = await tx.unit.update({ where: { id }, data: { status }, select: unitSelect });
    return { before, after };
  }
  async listProducts(context: TransactionContext, query: CatalogPageQuery) {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await tx.product.findMany({
      where: {
        deletedAt: null, status: query.status ?? 'active',
        ...(query.search ? { OR: [{ code: { contains: query.search, mode: 'insensitive' } }, { name: { contains: query.search, mode: 'insensitive' } }] } : {}),
        ...(cursor ? { AND: [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] } : {}),
      }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: productSelect,
    });
    return this.page(rows.map((row) => this.product(row)), limit);
  }
  async getProduct(context: TransactionContext, id: string) {
    const row = await unwrapPrismaTransaction(context).product.findFirst({ where: { id, deletedAt: null }, select: productSelect });
    if (!row) throw error('CATALOG_PRODUCT_NOT_FOUND', 'Product was not found', 404);
    return this.product(row);
  }
  async createProduct(context: TransactionContext, input: CreateProduct & { id: string; vendorId: string }) {
    const tx = unwrapPrismaTransaction(context);
    await this.lockActiveUnit(context, input.defaultUnitId);
    try {
      const row = await tx.product.create({ data: input, select: productSelect });
      return this.product(row);
    } catch (cause) { this.translate(cause, 'product'); throw cause; }
  }
  async updateProduct(context: TransactionContext, id: string, expectedVersion: number, input: Readonly<{ name?: string; status?: CatalogStatus }>) {
    const tx = unwrapPrismaTransaction(context);
    const before = await this.lockProduct(context, id, false);
    this.expectVersion(before.version, expectedVersion);
    if (input.status === 'active') await this.lockActiveUnit(context, before.defaultUnitId);
    const row = await tx.product.update({ where: { id }, data: { ...input, version: { increment: 1 } }, select: productSelect });
    return { before: this.product(before), after: this.product(row) };
  }
  async deleteProduct(context: TransactionContext, id: string, expectedVersion: number, actorId: string, reason: string) {
    const tx = unwrapPrismaTransaction(context);
    const before = await this.lockProduct(context, id, false);
    this.expectVersion(before.version, expectedVersion);
    const row = await tx.product.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: actorId, deletionReason: reason, version: { increment: 1 } }, select: productSelect });
    return { before: this.product(before), after: this.product(row) };
  }
  async restoreProduct(context: TransactionContext, id: string, expectedVersion: number) {
    const tx = unwrapPrismaTransaction(context);
    const before = await this.lockProduct(context, id, true);
    this.expectVersion(before.version, expectedVersion);
    await this.lockActiveUnit(context, before.defaultUnitId);
    try {
      const row = await tx.product.update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null, version: { increment: 1 } }, select: productSelect });
      return { before: this.product(before), after: this.product(row) };
    } catch (cause) { this.translate(cause, 'product'); throw cause; }
  }
  async listDeliverySlots(context: TransactionContext, query: CatalogPageQuery) {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await tx.deliverySlot.findMany({
      where: {
        active: query.status !== 'inactive',
        ...(query.search ? { OR: [{ code: { contains: query.search, mode: 'insensitive' } }, { name: { contains: query.search, mode: 'insensitive' } }] } : {}),
        ...(cursor ? { AND: [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] } : {}),
      }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: deliverySlotSelect,
    });
    return this.page(rows.map((row) => this.deliverySlot(row)), limit);
  }
  async getDeliverySlot(context: TransactionContext, id: string) {
    const row = await unwrapPrismaTransaction(context).deliverySlot.findFirst({ where: { id }, select: deliverySlotSelect });
    if (!row) throw error('DELIVERY_SLOT_NOT_FOUND', 'Delivery slot was not found', 404);
    return this.deliverySlot(row);
  }
  async createDeliverySlot(context: TransactionContext, input: CreateDeliverySlot & { id: string; vendorId: string }) {
    try {
      const row = await unwrapPrismaTransaction(context).deliverySlot.create({
        data: {
          ...input,
          // Prisma represents PostgreSQL time-only values as UTC-anchored Dates; the API never exposes that anchor.
          startLocalTime: this.localTime(input.startLocalTime), endLocalTime: this.localTime(input.endLocalTime),
        }, select: deliverySlotSelect,
      });
      return this.deliverySlot(row);
    } catch (cause) { this.translateDeliverySlot(cause); throw cause; }
  }
  async renameDeliverySlot(context: TransactionContext, id: string, name: string) {
    const before = await this.lockDeliverySlot(context, id);
    const row = await unwrapPrismaTransaction(context).deliverySlot.update({ where: { id }, data: { name }, select: deliverySlotSelect });
    return { before, after: this.deliverySlot(row) };
  }
  async changeDeliverySlotStatus(context: TransactionContext, id: string, active: boolean) {
    const before = await this.lockDeliverySlot(context, id);
    if ((before.status === 'active') === active)
      throw error('DELIVERY_SLOT_STATE_CONFLICT', `Delivery slot is already ${before.status}`, 409);
    const row = await unwrapPrismaTransaction(context).deliverySlot.update({ where: { id }, data: { active }, select: deliverySlotSelect });
    return { before, after: this.deliverySlot(row) };
  }

  private async lockUnit(context: TransactionContext, id: string): Promise<UnitRecord> {
    // This row lock serializes product create/activation against unit deactivation.
    const rows = await unwrapPrismaTransaction(context).$queryRaw<UnitRecord[]>(Prisma.sql`
      SELECT id, vendor_id AS "vendorId", code, name, decimal_scale AS "decimalScale", status,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM units WHERE id = ${id}::uuid FOR UPDATE`);
    if (!rows[0]) throw error('CATALOG_UNIT_NOT_FOUND', 'Unit was not found', 404);
    return rows[0];
  }
  private async lockActiveUnit(context: TransactionContext, id: string) {
    const rows = await unwrapPrismaTransaction(context).$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM units WHERE id = ${id}::uuid AND status = 'active' FOR UPDATE`);
    if (!rows[0]) throw error('CATALOG_UNIT_NOT_AVAILABLE', 'Active unit was not found', 409);
  }
  private async lockProduct(context: TransactionContext, id: string, deleted: boolean): Promise<ProductRow> {
    const rows = await unwrapPrismaTransaction(context).$queryRaw<ProductRow[]>(Prisma.sql`
      SELECT id, vendor_id AS "vendorId", code, name, default_unit_id AS "defaultUnitId", status,
             version, deleted_at AS "deletedAt", deleted_by AS "deletedBy",
             deletion_reason AS "deletionReason", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM products WHERE id = ${id}::uuid AND deleted_at IS ${deleted ? Prisma.sql`NOT NULL` : Prisma.sql`NULL`} FOR UPDATE`);
    if (!rows[0]) throw error('CATALOG_PRODUCT_NOT_FOUND', 'Product was not found', 404);
    return rows[0];
  }
  private async lockDeliverySlot(context: TransactionContext, id: string): Promise<DeliverySlotRecord> {
    const tx = unwrapPrismaTransaction(context);
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM delivery_slots WHERE id=${id}::uuid FOR UPDATE`);
    if (!locked[0]) throw error('DELIVERY_SLOT_NOT_FOUND', 'Delivery slot was not found', 404);
    const row = await tx.deliverySlot.findFirst({ where: { id }, select: deliverySlotSelect });
    if (!row) throw error('DELIVERY_SLOT_NOT_FOUND', 'Delivery slot was not found', 404);
    return this.deliverySlot(row);
  }
  private expectVersion(actual: number, expected: number) {
    if (actual !== expected) throw error('CATALOG_PRODUCT_VERSION_CONFLICT', 'Product was changed by another request', 409);
  }
  private product(row: ProductRow): ProductRecord {
    return { id: row.id, vendorId: row.vendorId, code: row.code, name: row.name, defaultUnitId: row.defaultUnitId, status: row.status, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }
  private deliverySlot(row: Prisma.DeliverySlotGetPayload<{ select: typeof deliverySlotSelect }>): DeliverySlotRecord {
    return {
      id: row.id, vendorId: row.vendorId, code: row.code, name: row.name,
      startLocalTime: this.formatLocalTime(row.startLocalTime), endLocalTime: this.formatLocalTime(row.endLocalTime),
      status: row.active ? 'active' : 'inactive', createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }
  private localTime(value: string): Date { return new Date(`1970-01-01T${value}:00.000Z`); }
  private formatLocalTime(value: Date): string { return value.toISOString().slice(11, 16); }
  private page<T extends { createdAt: Date; id: string }>(rows: readonly T[], limit: number) {
    const items = rows.slice(0, limit); const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode({ createdAt: last.createdAt, id: last.id }) } : {}) };
  }
  private translate(cause: unknown, entity: 'unit' | 'product'): void {
    if (typeof cause !== 'object' || cause === null || !('code' in cause)) return;
    if (cause.code === 'P2002') throw error(entity === 'unit' ? 'CATALOG_UNIT_CONFLICT' : 'CATALOG_PRODUCT_CONFLICT', `${entity === 'unit' ? 'Unit' : 'Product'} code already exists`, 409);
    if (cause.code === 'P2003') throw error('CATALOG_UNIT_NOT_AVAILABLE', 'Active unit was not found', 409);
  }
  private translateDeliverySlot(cause: unknown): void {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'P2002')
      throw error('DELIVERY_SLOT_CODE_CONFLICT', 'Delivery slot code already exists', 409);
  }
}
