import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  CreateSubscriptionAggregate,
  EnrichedCustomerSubscriptionRevision,
  LockedSubscription,
  ReplaceSubscriptionPlan,
  SubscriptionAggregateRecord,
  SubscriptionPageQuery,
  SubscriptionRevisionRecord,
  SubscriptionStorePageQuery,
} from '../application/subscription.store.js';
import { SubscriptionStore } from '../application/subscription.store.js';

const revisionInclude = {
  weekdays: { select: { weekday: true }, orderBy: { weekday: 'asc' as const } },
} satisfies Prisma.SubscriptionRevisionInclude;
const customerRevisionInclude = {
  ...revisionInclude,
  product: { select: { code: true, name: true, defaultUnit: { select: { code: true, name: true } } } },
  deliverySlot: { select: { name: true, startLocalTime: true, endLocalTime: true } },
} satisfies Prisma.SubscriptionRevisionInclude;
const aggregateInclude = {
  revisions: { include: revisionInclude, orderBy: [
    { effectiveFrom: 'asc' as const },
    { supersededAt: { sort: 'asc' as const, nulls: 'first' as const } },
    { createdAt: 'asc' as const },
    { id: 'asc' as const },
  ] },
} satisfies Prisma.SubscriptionInclude;
const customerAggregateInclude = {
  revisions: { include: customerRevisionInclude, orderBy: aggregateInclude.revisions.orderBy },
} satisfies Prisma.SubscriptionInclude;
const error = (code: string, message: string, status: number) => new ApplicationError(code, message, status);
const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
const dateString = (value: Date) => value.toISOString().slice(0, 10);

type RevisionRow = Prisma.SubscriptionRevisionGetPayload<{ include: typeof revisionInclude }>;
type CustomerRevisionRow = Prisma.SubscriptionRevisionGetPayload<{ include: typeof customerRevisionInclude }>;
type AggregateRow = Prisma.SubscriptionGetPayload<{ include: typeof aggregateInclude }>;
type CustomerAggregateRow = Prisma.SubscriptionGetPayload<{ include: typeof customerAggregateInclude }>;

@Injectable()
export class PrismaSubscriptionStore extends SubscriptionStore {
  private readonly cursors = new CursorCodec();

  async projectSchedule(context: TransactionContext, vendorId: string, serviceDate: string) {
    const rows = await unwrapPrismaTransaction(context).$queryRaw<Array<{
      subscriptionId: string; revisionId: string; householdId: string; productId: string;
      unitId: string; deliverySlotId: string; plannedQuantity: string;
    }>>(Prisma.sql`
      SELECT s.id AS "subscriptionId",r.id AS "revisionId",s.household_id AS "householdId",
        r.product_id AS "productId",r.unit_id AS "unitId",r.delivery_slot_id AS "deliverySlotId",
        r.quantity::text AS "plannedQuantity"
      FROM subscriptions s
      JOIN subscription_revisions r ON r.vendor_id=s.vendor_id AND r.subscription_id=s.id
      JOIN subscription_revision_weekdays w ON w.vendor_id=r.vendor_id AND w.subscription_revision_id=r.id
      JOIN units u ON u.vendor_id=r.vendor_id AND u.id=r.unit_id
      WHERE s.vendor_id=${vendorId}::uuid AND s.deleted_at IS NULL
        AND r.superseded_at IS NULL AND r.status='active'
        AND r.effective_from<=${serviceDate}::date
        AND (r.effective_to IS NULL OR r.effective_to>${serviceDate}::date)
        AND w.weekday=EXTRACT(ISODOW FROM ${serviceDate}::date)
        AND r.quantity=round(r.quantity,u.decimal_scale)
      ORDER BY s.id,r.id`);
    return rows.map((row) => ({ ...row, plannedQuantity: canonicalDecimal(row.plannedQuantity) }));
  }

  async list(context: TransactionContext, query: SubscriptionStorePageQuery, today: string, routeHouseholdId?: string) {
    const tx = unwrapPrismaTransaction(context); const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const householdId = routeHouseholdId ?? query.householdId;
    const filters: Prisma.Sql[] = [];
    const lifecycleFilter = query.lifecycle === 'deleted' ? Prisma.sql`s.deleted_at IS NOT NULL` : Prisma.sql`s.deleted_at IS NULL`;
    filters.push(lifecycleFilter);
    if (householdId) filters.push(Prisma.sql`s.household_id=${householdId}::uuid`);
    if (cursor) filters.push(Prisma.sql`(s.created_at < ${cursor.createdAt} OR (s.created_at=${cursor.createdAt} AND s.id < ${cursor.id}::uuid))`);
    if (query.productId && !query.route) filters.push(Prisma.sql`EXISTS (SELECT 1 FROM subscription_revisions f WHERE f.subscription_id=s.id AND f.superseded_at IS NULL AND f.product_id=${query.productId}::uuid)`);
    if (query.deliverySlotId && !query.route) filters.push(Prisma.sql`EXISTS (SELECT 1 FROM subscription_revisions f WHERE f.subscription_id=s.id AND f.superseded_at IS NULL AND f.delivery_slot_id=${query.deliverySlotId}::uuid)`);
    if (query.route) {
      filters.push(query.route.householdIds.length === 0
        ? Prisma.sql`FALSE`
        : Prisma.sql`s.household_id IN (${Prisma.join(query.route.householdIds.map((id) => Prisma.sql`${id}::uuid`))})`);
      filters.push(Prisma.sql`EXISTS (
        SELECT 1 FROM subscription_revisions f
        JOIN subscription_revision_weekdays w ON w.vendor_id=f.vendor_id AND w.subscription_revision_id=f.id
        WHERE f.subscription_id=s.id AND f.superseded_at IS NULL AND f.status='active'
          AND f.delivery_slot_id=${query.route.deliverySlotId}::uuid
          ${query.productId ? Prisma.sql`AND f.product_id=${query.productId}::uuid` : Prisma.empty}
          ${query.deliverySlotId ? Prisma.sql`AND f.delivery_slot_id=${query.deliverySlotId}::uuid` : Prisma.empty}
          AND f.effective_from<=${query.route.serviceDate}::date
          AND (f.effective_to IS NULL OR f.effective_to>${query.route.serviceDate}::date)
          AND w.weekday=EXTRACT(ISODOW FROM ${query.route.serviceDate}::date)
      )`);
    }
    if (query.status) filters.push(Prisma.sql`COALESCE(current_revision.status, CASE WHEN EXISTS (
      SELECT 1 FROM subscription_revisions future WHERE future.subscription_id=s.id AND future.superseded_at IS NULL AND future.effective_from>${today}::date
    ) THEN 'future' ELSE 'completed' END)=${query.status}`);
    const selected = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT s.id FROM subscriptions s
      LEFT JOIN LATERAL (
        SELECT r.status FROM subscription_revisions r
        WHERE r.subscription_id=s.id AND r.superseded_at IS NULL AND r.effective_from<=${today}::date
          AND (r.effective_to IS NULL OR r.effective_to>${today}::date)
        ORDER BY r.effective_from DESC,r.id DESC LIMIT 1
      ) current_revision ON true
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY s.created_at DESC,s.id DESC LIMIT ${limit + 1}`);
    const selectedIds = selected.map(({ id }) => id);
    const visible = routeHouseholdId
      ? this.customerAggregates(await tx.subscription.findMany({ where: { id: { in: selectedIds.slice(0, limit) } }, include: customerAggregateInclude }), selectedIds, limit)
      : this.aggregates(await tx.subscription.findMany({ where: { id: { in: selectedIds.slice(0, limit) } }, include: aggregateInclude }), selectedIds, limit);
    const next = selected.length > limit ? visible.at(-1) : undefined;
    return { items: visible, ...(next ? { nextCursor: this.cursors.encode({ createdAt: next.createdAt, id: next.id }) } : {}) };
  }

  async get(context: TransactionContext, subscriptionId: string, lifecycle: 'current' | 'deleted', householdId?: string) {
    const tx = unwrapPrismaTransaction(context);
    const where = { id: subscriptionId, deletedAt: lifecycle === 'deleted' ? { not: null } : null, ...(householdId ? { householdId } : {}) };
    const row = householdId
      ? await tx.subscription.findFirst({ where, include: customerAggregateInclude })
      : await tx.subscription.findFirst({ where, include: aggregateInclude });
    if (!row) throw error('SUBSCRIPTION_NOT_FOUND', 'Subscription was not found', 404);
    return householdId ? this.customerAggregate(row as CustomerAggregateRow) : this.aggregate(row);
  }

  async history(context: TransactionContext, subscriptionId: string, query: Pick<SubscriptionPageQuery, 'cursor' | 'limit'>, householdId?: string) {
    const tx = unwrapPrismaTransaction(context);
    const root = await tx.subscription.findFirst({ where: { id: subscriptionId, deletedAt: null, ...(householdId ? { householdId } : {}) }, select: { id: true } });
    if (!root) throw error('SUBSCRIPTION_NOT_FOUND', 'Subscription was not found', 404);
    const limit = this.cursors.parseLimit(query.limit); const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const where = { subscriptionId, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) };
    const rows = householdId
      ? await tx.subscriptionRevision.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, include: customerRevisionInclude })
      : await tx.subscriptionRevision.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, include: revisionInclude });
    const items = rows.slice(0, limit).map((row) => householdId ? this.customerRevision(row as CustomerRevisionRow) : this.revision(row));
    const next = rows.length > limit ? items.at(-1) : undefined;
    return { items, ...(next ? { nextCursor: this.cursors.encode({ createdAt: next.createdAt, id: next.id }) } : {}) };
  }

  async create(context: TransactionContext, input: CreateSubscriptionAggregate) {
    const tx = unwrapPrismaTransaction(context); await this.lockHousehold(tx, input.vendorId, input.householdId);
    await this.requireNoDuplicate(tx, input, undefined);
    await tx.subscription.create({ data: { id: input.id, vendorId: input.vendorId, householdId: input.householdId } });
    const revisionId = randomRevisionId();
    await tx.subscriptionRevision.create({
      data: {
        id: revisionId, vendorId: input.vendorId, subscriptionId: input.id, productId: input.productId, unitId: input.unitId,
        deliverySlotId: input.deliverySlotId, quantity: new Prisma.Decimal(input.quantity), status: 'active',
        effectiveFrom: date(input.effectiveFrom), effectiveTo: input.effectiveTo ? date(input.effectiveTo) : undefined,
        createdBy: input.createdBy,
      },
    });
    await tx.subscriptionRevisionWeekday.createMany({
      data: input.weekdays.map((weekday) => ({ vendorId: input.vendorId, subscriptionRevisionId: revisionId, weekday })),
    });
    return this.getAny(tx, input.id);
  }

  async lockForMutation(context: TransactionContext, subscriptionId: string, expectedVersion: number, effectiveDate: string, includeDeleted = false): Promise<LockedSubscription> {
    const aggregate = await this.lockRoot(context, subscriptionId, expectedVersion, includeDeleted);
    const plan = aggregate.revisions.filter(({ supersededAt }) => !supersededAt);
    const selected = plan.find(({ effectiveFrom, effectiveTo }) => effectiveFrom <= effectiveDate && (!effectiveTo || effectiveDate < effectiveTo))
      ?? plan.filter(({ effectiveFrom }) => effectiveFrom > effectiveDate).sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom))[0];
    if (!selected) throw error('SUBSCRIPTION_STATE_CONFLICT', 'Subscription has no applicable or future plan', 409);
    return { ...aggregate, selected };
  }

  async lockRoot(context: TransactionContext, subscriptionId: string, expectedVersion: number, includeDeleted = false) {
    const tx = unwrapPrismaTransaction(context);
    const candidate = await tx.subscription.findFirst({ where: { id: subscriptionId }, select: { householdId: true, vendorId: true, deletedAt: true } });
    if (!candidate || (includeDeleted ? !candidate.deletedAt : candidate.deletedAt))
      throw error('SUBSCRIPTION_NOT_FOUND', 'Subscription was not found', 404);
    await this.lockHousehold(tx, candidate.vendorId, candidate.householdId);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM subscriptions WHERE id=${subscriptionId}::uuid FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM subscription_revisions WHERE subscription_id=${subscriptionId}::uuid AND superseded_at IS NULL FOR UPDATE`);
    const row = await tx.subscription.findFirst({ where: { id: subscriptionId }, include: aggregateInclude });
    if (!row) throw error('SUBSCRIPTION_NOT_FOUND', 'Subscription was not found', 404);
    if (row.version !== expectedVersion) throw error('SUBSCRIPTION_VERSION_CONFLICT', 'Subscription was changed by another request', 409);
    return this.aggregate(row);
  }

  async replacePlan(context: TransactionContext, input: ReplaceSubscriptionPlan) {
    const tx = unwrapPrismaTransaction(context); const effectiveFrom = date(input.effectiveFrom);
    await tx.subscriptionRevision.updateMany({
      where: { subscriptionId: input.subscription.id, supersededAt: null, effectiveFrom: { lt: effectiveFrom }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveFrom } }] },
      data: { effectiveTo: effectiveFrom },
    });
    await this.requireNoDuplicate(tx, { ...input, vendorId: input.subscription.vendorId, householdId: input.subscription.householdId }, input.subscription.id);
    const supersededRows = await tx.subscriptionRevision.findMany({
      where: { subscriptionId: input.subscription.id, supersededAt: null, effectiveFrom: { gte: effectiveFrom } }, select: { id: true },
    });
    await tx.subscriptionRevision.updateMany({
      where: { subscriptionId: input.subscription.id, supersededAt: null, effectiveFrom: { gte: effectiveFrom } },
      data: { supersededAt: new Date(), supersededByRevisionId: input.replacementRevisionId, supersessionReason: input.reason },
    });
    await tx.subscriptionRevision.create({
      data: {
        id: input.replacementRevisionId, vendorId: input.subscription.vendorId, subscriptionId: input.subscription.id,
        productId: input.productId, unitId: input.unitId, deliverySlotId: input.deliverySlotId,
        quantity: new Prisma.Decimal(input.quantity), status: input.status, effectiveFrom,
        effectiveTo: input.effectiveTo ? date(input.effectiveTo) : undefined, createdBy: input.createdBy,
      },
    });
    await tx.subscriptionRevisionWeekday.createMany({ data: input.weekdays.map((weekday) => ({
      vendorId: input.subscription.vendorId, subscriptionRevisionId: input.replacementRevisionId, weekday,
    })) });
    const changed = await tx.subscription.updateMany({ where: { id: input.subscription.id, version: input.subscription.version, deletedAt: null }, data: { version: { increment: 1 } } });
    if (changed.count !== 1) throw error('SUBSCRIPTION_VERSION_CONFLICT', 'Subscription was changed by another request', 409);
    const supersededRevisionIds = supersededRows.map(({ id }) => id);
    return { ...await this.getAny(tx, input.subscription.id), replacementRevisionId: input.replacementRevisionId, supersededRevisionIds, supersededRevisionCount: supersededRevisionIds.length };
  }

  async softDelete(context: TransactionContext, subscriptionId: string, expectedVersion: number, actorId: string, reason: string) {
    const tx = unwrapPrismaTransaction(context);
    const changed = await tx.subscription.updateMany({ where: { id: subscriptionId, version: expectedVersion, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: actorId, deletionReason: reason, version: { increment: 1 } } });
    if (changed.count !== 1) throw error('SUBSCRIPTION_VERSION_CONFLICT', 'Subscription was changed by another request', 409);
    return this.getAny(tx, subscriptionId);
  }
  async restore(context: TransactionContext, subscriptionId: string, expectedVersion: number) {
    const tx = unwrapPrismaTransaction(context);
    const changed = await tx.subscription.updateMany({ where: { id: subscriptionId, version: expectedVersion, deletedAt: { not: null } }, data: { deletedAt: null, deletedBy: null, deletionReason: null, version: { increment: 1 } } });
    if (changed.count !== 1) throw error('SUBSCRIPTION_VERSION_CONFLICT', 'Subscription was changed by another request', 409);
    return this.getAny(tx, subscriptionId);
  }

  private async getAny(tx: Prisma.TransactionClient, id: string): Promise<SubscriptionAggregateRecord> {
    const row = await tx.subscription.findFirst({ where: { id }, include: aggregateInclude });
    if (!row) throw error('SUBSCRIPTION_NOT_FOUND', 'Subscription was not found', 404);
    return this.aggregate(row);
  }
  private async lockHousehold(tx: Prisma.TransactionClient, vendorId: string, householdId: string) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('subscription-household:' || ${vendorId}::text || ':' || ${householdId}::text, 0))`);
  }
  private async requireNoDuplicate(tx: Prisma.TransactionClient, input: Readonly<{
    vendorId: string; householdId: string; productId: string; unitId: string; deliverySlotId: string;
    weekdays: readonly number[]; effectiveFrom: string; effectiveTo?: string; status?: string;
  }>, excludeSubscriptionId?: string) {
    if (input.status && input.status !== 'active') return;
    const weekdays = Prisma.join(input.weekdays);
    const rows = await tx.$queryRaw<Array<{ duplicate: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM subscriptions s
        JOIN subscription_revisions r ON r.vendor_id=s.vendor_id AND r.subscription_id=s.id
        JOIN subscription_revision_weekdays w ON w.vendor_id=r.vendor_id AND w.subscription_revision_id=r.id
        WHERE s.vendor_id=${input.vendorId}::uuid AND s.household_id=${input.householdId}::uuid AND s.deleted_at IS NULL
          AND r.superseded_at IS NULL AND r.status='active'
          AND r.product_id=${input.productId}::uuid AND r.unit_id=${input.unitId}::uuid AND r.delivery_slot_id=${input.deliverySlotId}::uuid
          AND daterange(r.effective_from,r.effective_to,'[)') && daterange(${input.effectiveFrom}::date,${input.effectiveTo ?? null}::date,'[)')
          AND w.weekday IN (${weekdays})
          ${excludeSubscriptionId ? Prisma.sql`AND s.id <> ${excludeSubscriptionId}::uuid` : Prisma.empty}
      ) AS duplicate`);
    if (rows[0]?.duplicate) throw error('SUBSCRIPTION_DUPLICATE', 'Subscription would create a duplicate delivery', 409);
  }
  private revision(row: RevisionRow): SubscriptionRevisionRecord {
    return {
      id: row.id, vendorId: row.vendorId, subscriptionId: row.subscriptionId, productId: row.productId, unitId: row.unitId,
      deliverySlotId: row.deliverySlotId, quantity: canonicalDecimal(row.quantity.toString()), weekdays: row.weekdays.map(({ weekday }) => weekday),
      status: row.status as SubscriptionRevisionRecord['status'], effectiveFrom: dateString(row.effectiveFrom),
      ...(row.effectiveTo ? { effectiveTo: dateString(row.effectiveTo) } : {}), createdBy: row.createdBy,
      ...(row.supersededAt ? { supersededAt: row.supersededAt } : {}),
      ...(row.supersededByRevisionId ? { supersededByRevisionId: row.supersededByRevisionId } : {}),
      ...(row.supersessionReason ? { supersessionReason: row.supersessionReason } : {}), createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }
  private customerRevision(row: CustomerRevisionRow): SubscriptionRevisionRecord & EnrichedCustomerSubscriptionRevision {
    return {
      ...this.revision(row),
      productCode: row.product.code, productName: row.product.name,
      unitCode: row.product.defaultUnit.code, unitName: row.product.defaultUnit.name,
      deliverySlotName: row.deliverySlot.name,
      deliverySlotStartLocalTime: row.deliverySlot.startLocalTime.toISOString().slice(11, 16),
      deliverySlotEndLocalTime: row.deliverySlot.endLocalTime.toISOString().slice(11, 16),
    };
  }
  private aggregates(rows: readonly AggregateRow[], selectedIds: readonly string[], limit: number) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return selectedIds.slice(0, limit).flatMap((id) => { const row = byId.get(id); return row ? [this.aggregate(row)] : []; });
  }
  private customerAggregates(rows: readonly CustomerAggregateRow[], selectedIds: readonly string[], limit: number) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return selectedIds.slice(0, limit).flatMap((id) => { const row = byId.get(id); return row ? [this.customerAggregate(row)] : []; });
  }
  private customerAggregate(row: CustomerAggregateRow): SubscriptionAggregateRecord {
    return { ...this.aggregate(row), revisions: row.revisions.map((revision) => this.customerRevision(revision)) };
  }
  private aggregate(row: AggregateRow): SubscriptionAggregateRecord {
    return {
      id: row.id, vendorId: row.vendorId, householdId: row.householdId, version: row.version,
      deletedAt: row.deletedAt, ...(row.deletedBy ? { deletedBy: row.deletedBy } : {}),
      ...(row.deletionReason ? { deletionReason: row.deletionReason } : {}), createdAt: row.createdAt, updatedAt: row.updatedAt,
      revisions: row.revisions.map((revision) => this.revision(revision)),
    };
  }
}

function canonicalDecimal(value: string) {
  const [integer = '', fraction = ''] = value.split('.'); const trimmed = fraction.replace(/0+$/u, '');
  return trimmed ? `${integer}.${trimmed}` : integer;
}
function randomRevisionId() { return randomUUID(); }
