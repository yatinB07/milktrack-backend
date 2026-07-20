import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PricingStore, type OverrideRecord, type PricePageQuery, type PriceRecord } from '../application/pricing.store.js';

const priceSelect = { id: true, vendorId: true, productId: true, unitId: true, amountMinor: true, currency: true, effectiveFrom: true, effectiveTo: true, createdAt: true, updatedAt: true } as const;
const overrideSelect = { ...priceSelect, householdId: true, reason: true } as const;
const failure = (code: string, message: string, status: number) => new ApplicationError(code, message, status);

@Injectable()
export class PrismaPricingStore extends PricingStore {
  private readonly cursors = new CursorCodec();

  constructor() { super(); }

  async resolveManySchedule(
    context: TransactionContext,
    vendorId: string,
    serviceDate: string,
    candidates: readonly Readonly<{ subscriptionId: string; householdId: string; productId: string; unitId: string; deliverySlotId: string }>[],
  ) {
    if (candidates.length === 0) return [];
    type Availability = typeof candidates[number] & { status: 'resolved' | 'missing' };
    return unwrapPrismaTransaction(context).$queryRaw<Availability[]>(Prisma.sql`
      WITH candidates AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb) AS c(
          "subscriptionId" uuid,"householdId" uuid,"productId" uuid,"unitId" uuid,"deliverySlotId" uuid
        )
      ), instants AS (
        SELECT c.*,(${serviceDate}::date + ds.start_local_time) AT TIME ZONE v.timezone AS service_at
        FROM candidates c
        JOIN delivery_slots ds ON ds.vendor_id=${vendorId}::uuid AND ds.id=c."deliverySlotId"
        JOIN vendors v ON v.id=ds.vendor_id
      )
      SELECT i."subscriptionId",i."householdId",i."productId",i."unitId",i."deliverySlotId",
        CASE WHEN EXISTS (
          SELECT 1 FROM customer_price_overrides p
          WHERE p.vendor_id=${vendorId}::uuid AND p.household_id=i."householdId"
            AND p.product_id=i."productId" AND p.unit_id=i."unitId"
            AND p.effective_from<=i.service_at AND (p.effective_to IS NULL OR p.effective_to>i.service_at)
        ) OR EXISTS (
          SELECT 1 FROM global_prices p
          WHERE p.vendor_id=${vendorId}::uuid AND p.product_id=i."productId" AND p.unit_id=i."unitId"
            AND p.effective_from<=i.service_at AND (p.effective_to IS NULL OR p.effective_to>i.service_at)
        ) THEN 'resolved' ELSE 'missing' END AS status
      FROM instants i ORDER BY i."subscriptionId",i."deliverySlotId"`);
  }

  async listGlobals(context: TransactionContext, query: PricePageQuery) {
    const tx = unwrapPrismaTransaction(context); const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await tx.globalPrice.findMany({
      where: { ...(query.productId ? { productId: query.productId } : {}), ...(query.unitId ? { unitId: query.unitId } : {}),
        ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: priceSelect,
    });
    return this.page(rows.map((row) => this.price(row)), limit);
  }
  async listOverrides(context: TransactionContext, householdId: string, query: PricePageQuery) {
    const tx = unwrapPrismaTransaction(context); const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await tx.customerPriceOverride.findMany({
      where: { householdId, ...(query.productId ? { productId: query.productId } : {}), ...(query.unitId ? { unitId: query.unitId } : {}),
        ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: overrideSelect,
    });
    return this.page(rows.map((row) => this.override(row)), limit);
  }
  async getGlobal(context: TransactionContext, id: string) {
    const row = await unwrapPrismaTransaction(context).globalPrice.findFirst({ where: { id }, select: priceSelect });
    if (!row) throw failure('GLOBAL_PRICE_NOT_FOUND', 'Global price was not found', 404);
    return this.price(row);
  }
  async getOverride(context: TransactionContext, householdId: string, id: string) {
    const row = await unwrapPrismaTransaction(context).customerPriceOverride.findFirst({ where: { id, householdId }, select: overrideSelect });
    if (!row) throw failure('CUSTOMER_PRICE_OVERRIDE_NOT_FOUND', 'Customer price override was not found', 404);
    return this.override(row);
  }
  async createGlobal(context: TransactionContext, input: Readonly<{ id: string; vendorId: string; productId: string; unitId: string; amountMinor: bigint; currency: string; effectiveFrom: Date; effectiveTo?: Date; createdBy: string }>) {
    try { return this.price(await unwrapPrismaTransaction(context).globalPrice.create({ data: input, select: priceSelect })); }
    catch (cause) { this.translateOverlap(cause); throw cause; }
  }
  async createOverride(context: TransactionContext, input: Readonly<{ id: string; vendorId: string; householdId: string; productId: string; unitId: string; amountMinor: bigint; currency: string; effectiveFrom: Date; effectiveTo?: Date; reason: string; createdBy: string }>) {
    try { return this.override(await unwrapPrismaTransaction(context).customerPriceOverride.create({ data: input, select: overrideSelect })); }
    catch (cause) { this.translateOverlap(cause); throw cause; }
  }
  async closeGlobal(context: TransactionContext, id: string, effectiveTo: Date) {
    const before = await this.lockGlobal(context, id);
    if (before.effectiveTo) throw failure('PRICE_ALREADY_CLOSED', 'Price is already closed', 409);
    if (effectiveTo <= before.effectiveFrom) throw failure('INVALID_EFFECTIVE_PERIOD', 'Effective period is invalid', 400);
    const after = this.price(await unwrapPrismaTransaction(context).globalPrice.update({ where: { id }, data: { effectiveTo }, select: priceSelect }));
    return { before, after };
  }
  async closeOverride(context: TransactionContext, householdId: string, id: string, effectiveTo: Date) {
    const before = await this.lockOverride(context, householdId, id);
    if (before.effectiveTo) throw failure('PRICE_ALREADY_CLOSED', 'Price is already closed', 409);
    if (effectiveTo <= before.effectiveFrom) throw failure('INVALID_EFFECTIVE_PERIOD', 'Effective period is invalid', 400);
    const after = this.override(await unwrapPrismaTransaction(context).customerPriceOverride.update({ where: { id }, data: { effectiveTo }, select: overrideSelect }));
    return { before, after };
  }
  async resolveOverride(context: TransactionContext, householdId: string, productId: string, unitId: string, at: Date) {
    const row = await unwrapPrismaTransaction(context).customerPriceOverride.findFirst({ where: { householdId, productId, unitId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] }, orderBy: { effectiveFrom: 'desc' }, select: overrideSelect });
    return row ? this.override(row) : undefined;
  }
  async resolveGlobal(context: TransactionContext, productId: string, unitId: string, at: Date) {
    const row = await unwrapPrismaTransaction(context).globalPrice.findFirst({ where: { productId, unitId, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] }, orderBy: { effectiveFrom: 'desc' }, select: priceSelect });
    return row ? this.price(row) : undefined;
  }
  private async lockGlobal(context: TransactionContext, id: string) {
    const tx = unwrapPrismaTransaction(context); const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM global_prices WHERE id=${id}::uuid FOR UPDATE`);
    if (!locked[0]) throw failure('GLOBAL_PRICE_NOT_FOUND', 'Global price was not found', 404);
    return this.getGlobal(context, id);
  }
  private async lockOverride(context: TransactionContext, householdId: string, id: string) {
    const tx = unwrapPrismaTransaction(context); const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM customer_price_overrides WHERE id=${id}::uuid AND household_id=${householdId}::uuid FOR UPDATE`);
    if (!locked[0]) throw failure('CUSTOMER_PRICE_OVERRIDE_NOT_FOUND', 'Customer price override was not found', 404);
    return this.getOverride(context, householdId, id);
  }
  private price(row: { id: string; vendorId: string; productId: string; unitId: string; amountMinor: bigint; currency: string; effectiveFrom: Date; effectiveTo: Date | null; createdAt: Date; updatedAt: Date }): PriceRecord {
    return { ...row, amountMinor: row.amountMinor.toString() };
  }
  private override(row: Parameters<PrismaPricingStore['price']>[0] & { householdId: string; reason: string }): OverrideRecord { return { ...this.price(row), householdId: row.householdId, reason: row.reason }; }
  private page<T extends { id: string; createdAt: Date }>(rows: readonly T[], limit: number) {
    const items = rows.slice(0, limit); const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode(last) } : {}) };
  }
  private translateOverlap(cause: unknown) {
    const value = `${cause instanceof Error ? `${cause.name} ${cause.message}` : ''} ${JSON.stringify(cause)}`;
    if (/23P01|exclusion|no_overlap/i.test(value)) throw failure('PRICE_PERIOD_OVERLAP', 'Price period overlaps an existing price', 409);
  }
}
