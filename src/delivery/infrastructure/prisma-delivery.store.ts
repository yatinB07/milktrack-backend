import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  DeliveryStore,
  type AppendCorrection,
  type AppendFinalOutcome,
  type CreatePriceSnapshot,
  type CustomerDeliveryQuery,
  type DeliveryDetail,
  type DeliveryEvent,
  type DeliveryFinalStatus,
  type DeliveryOccurrenceKey,
  type DeliveryPage,
  type DeliveryPriceSnapshot,
  type DeliveryRecord,
  type LockStopInput,
  type PendingDelivery,
  type VendorDeliveryQuery,
} from '../application/delivery.store.js';
import {
  canonicalizePositiveQuantity,
  type DeliveryCurrentStatus,
  requireAgentOutcomeQuantity,
  requireAgentOutcomeTransition,
  requireCorrectionReason,
  requireCorrectionTransition,
  requireOutcomeReason,
} from '../domain/delivery-rules.js';

type DeliveryRow = Readonly<{
  id: string;
  vendorId: string;
  subscriptionId: string;
  householdId: string;
  productId: string;
  unitId: string;
  deliverySlotId: string;
  routeAssignmentId: string | null;
  serviceDate: string;
  plannedQuantity: string;
  actualQuantity?: string | null;
  currentStatus: DeliveryCurrentStatus;
  version: number;
  finalizedAt: Date | null;
  createdAt: Date;
}>;

type EventRow = Readonly<{
  id: string;
  eventType: DeliveryFinalStatus;
  source: DeliveryEvent['source'];
  actorUserId: string | null;
  occurredAt: Date;
  receivedAt: Date;
  actualQuantity: string | null;
  reasonCode: string | null;
  note: string | null;
  latitude: string | null;
  longitude: string | null;
  replacedEventId: string | null;
  createdAt: Date;
}>;

type SnapshotRow = Readonly<{
  amountMinor: bigint;
  currency: string;
  pricingLevel: DeliveryPriceSnapshot['pricingLevel'];
  sourcePriceId: string;
  sourcePriceType: DeliveryPriceSnapshot['sourcePriceType'];
  resolvedAt: Date;
}>;

const deliveryColumns = Prisma.sql`
  id,vendor_id AS "vendorId",subscription_id AS "subscriptionId",household_id AS "householdId",
  product_id AS "productId",unit_id AS "unitId",delivery_slot_id AS "deliverySlotId",
  route_assignment_id AS "routeAssignmentId",service_date::text AS "serviceDate",
  planned_quantity::text AS "plannedQuantity",status AS "currentStatus",version,
  finalized_at AS "finalizedAt",created_at AS "createdAt"`;

const deliveryProjectionColumns = Prisma.sql`
  d.id,d.vendor_id AS "vendorId",d.subscription_id AS "subscriptionId",d.household_id AS "householdId",
  d.product_id AS "productId",d.unit_id AS "unitId",d.delivery_slot_id AS "deliverySlotId",
  d.route_assignment_id AS "routeAssignmentId",d.service_date::text AS "serviceDate",
  d.planned_quantity::text AS "plannedQuantity",latest."actualQuantity",d.status AS "currentStatus",d.version,
  d.finalized_at AS "finalizedAt",d.created_at AS "createdAt"`;

const latestDeliveryQuantityJoin = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT e.actual_quantity::text AS "actualQuantity" FROM delivery_events e
    WHERE e.vendor_id=d.vendor_id AND e.scheduled_delivery_id=d.id
    ORDER BY e.created_at DESC,e.id DESC LIMIT 1
  ) latest ON true`;

@Injectable()
export class PrismaDeliveryStore extends DeliveryStore {
  private readonly cursors = new CursorCodec();

  async lockStopPendingSet(context: TransactionContext, input: LockStopInput): Promise<readonly PendingDelivery[]> {
    const submitted = new Map(input.submitted.map((item) => [item.scheduledDeliveryId, item]));
    if (submitted.size !== input.submitted.length) {
      throw failure('INCOMPLETE_STOP_SET', 'Delivery items must be unique', 409);
    }
    const rows = await unwrapPrismaTransaction(context).$queryRaw<DeliveryRow[]>(Prisma.sql`
      SELECT ${deliveryColumns}
      FROM scheduled_deliveries d
      JOIN route_assignments a ON a.vendor_id=d.vendor_id AND a.id=d.route_assignment_id
        AND a.service_date=d.service_date AND a.delivery_slot_id=d.delivery_slot_id
        AND a.agent_membership_id=${input.agentMembershipId}::uuid AND a.status='assigned'
      JOIN LATERAL (
        SELECT p.id FROM route_stop_plans p
        WHERE p.vendor_id=d.vendor_id AND p.route_id=a.route_id AND p.delivery_slot_id=d.delivery_slot_id
          AND p.superseded_at IS NULL AND p.effective_from<=d.service_date
          AND (p.effective_to IS NULL OR p.effective_to>d.service_date)
        ORDER BY p.effective_from DESC,p.id DESC LIMIT 1
      ) p ON true
      JOIN route_stops s ON s.vendor_id=d.vendor_id AND s.route_id=a.route_id AND s.plan_id=p.id
        AND s.household_id=d.household_id AND s.delivery_slot_id=d.delivery_slot_id
        AND s.superseded_at IS NULL AND s.effective_from<=d.service_date
        AND (s.effective_to IS NULL OR s.effective_to>d.service_date)
      WHERE d.vendor_id=${input.vendorId}::uuid AND d.service_date=${input.serviceDate}::date
        AND s.id=${input.routeStopId}::uuid AND d.status='scheduled' AND d.finalized_at IS NULL
      ORDER BY d.id FOR UPDATE`);
    if (rows.length !== submitted.size || rows.some((row) => !submitted.has(row.id))) {
      throw failure('INCOMPLETE_STOP_SET', 'Submitted deliveries do not match the pending stop', 409);
    }
    for (const row of rows) {
      if (submitted.get(row.id)?.expectedVersion !== row.version) {
        throw failure('STALE_VERSION', 'Delivery version is stale', 409);
      }
    }
    return rows.map((row) => ({ ...this.record(row), routeAssignmentId: row.routeAssignmentId!, currentStatus: 'scheduled' }));
  }

  async appendFinalOutcome(context: TransactionContext, input: AppendFinalOutcome): Promise<DeliveryRecord> {
    const tx = unwrapPrismaTransaction(context);
    const current = await this.lockDelivery(tx, input.vendorId, input.scheduledDeliveryId);
    this.requireVersion(current, input.expectedVersion);
    requireAgentOutcomeTransition(current.currentStatus, input.outcome);
    const actualQuantity = requireAgentOutcomeQuantity(input.outcome, input.actualQuantity);
    if (input.outcome !== 'delivered') requireOutcomeReason(input.outcome, input.reasonCode, input.note);
    if (input.outcome === 'delivered') {
      await this.requirePriceSnapshot(tx, input.vendorId, input.scheduledDeliveryId);
    }
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO delivery_events (
        id,vendor_id,scheduled_delivery_id,event_type,source,actor_user_id,occurred_at,received_at,
        actual_quantity,reason_code,note,latitude,longitude
      ) VALUES (
        ${input.id}::uuid,${input.vendorId}::uuid,${input.scheduledDeliveryId}::uuid,${input.outcome},
        ${input.source},${input.actorUserId}::uuid,${input.occurredAt},${input.receivedAt},
        ${actualQuantity ?? null},${input.reasonCode ?? null},${input.note ?? null},
        ${input.latitude ?? null},${input.longitude ?? null})`);
    return this.updateProjection(tx, input.vendorId, input.scheduledDeliveryId, input.expectedVersion, input.outcome, input.receivedAt);
  }

  async appendCorrection(context: TransactionContext, input: AppendCorrection): Promise<DeliveryRecord> {
    const tx = unwrapPrismaTransaction(context);
    const current = await this.lockDelivery(tx, input.vendorId, input.scheduledDeliveryId);
    this.requireVersion(current, input.expectedVersion);
    requireCorrectionTransition(current.currentStatus, input.replacementOutcome, input.actualQuantity);
    requireCorrectionReason(input.reason);
    if (input.replacementOutcome === 'delivered') {
      await this.requirePriceSnapshot(tx, input.vendorId, input.scheduledDeliveryId);
    }
    const previous = await tx.$queryRaw<Readonly<{ id: string }>[]>(Prisma.sql`
      SELECT id FROM delivery_events WHERE vendor_id=${input.vendorId}::uuid
        AND scheduled_delivery_id=${input.scheduledDeliveryId}::uuid
      ORDER BY created_at DESC,id DESC LIMIT 1`);
    if (!previous[0]) throw failure('DELIVERY_EVENT_NOT_FOUND', 'Delivery event was not found', 409);
    const actualQuantity = input.replacementOutcome === 'delivered'
      ? canonicalizePositiveQuantity(input.actualQuantity)
      : undefined;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO delivery_events (
        id,vendor_id,scheduled_delivery_id,event_type,source,actor_user_id,occurred_at,received_at,
        actual_quantity,reason_code,replaced_event_id
      ) VALUES (
        ${input.id}::uuid,${input.vendorId}::uuid,${input.scheduledDeliveryId}::uuid,
        ${input.replacementOutcome},'vendor_admin',${input.actorUserId}::uuid,${input.occurredAt},
        ${input.receivedAt},${actualQuantity ?? null},${input.reason},${previous[0].id}::uuid)`);
    return this.updateProjection(tx, input.vendorId, input.scheduledDeliveryId, input.expectedVersion, input.replacementOutcome, input.receivedAt);
  }

  async lockCorrection(context: TransactionContext, vendorId: string, scheduledDeliveryId: string, expectedVersion: number): Promise<DeliveryDetail> {
    const tx = unwrapPrismaTransaction(context);
    const current = await this.lockDelivery(tx, vendorId, scheduledDeliveryId);
    this.requireVersion(current, expectedVersion);
    return this.detail(tx, vendorId, scheduledDeliveryId);
  }

  async applyCustomerLeave(context: TransactionContext, key: DeliveryOccurrenceKey, actorUserId: string): Promise<void> {
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<DeliveryRow[]>(Prisma.sql`
      SELECT ${deliveryColumns} FROM scheduled_deliveries
      WHERE vendor_id=${key.vendorId}::uuid AND subscription_id=${key.subscriptionId}::uuid
        AND service_date=${key.serviceDate}::date AND delivery_slot_id=${key.deliverySlotId}::uuid
        AND status='scheduled' AND finalized_at IS NULL
      ORDER BY id FOR UPDATE`);
    for (const row of rows) {
      const now = new Date();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO delivery_events(id,vendor_id,scheduled_delivery_id,event_type,source,actor_user_id,occurred_at,received_at)
        VALUES(${Prisma.raw(`gen_random_uuid()`)} ,${key.vendorId}::uuid,${row.id}::uuid,'skipped_by_customer','customer',${actorUserId}::uuid,${now},${now})`);
      await this.updateProjection(tx, key.vendorId, row.id, row.version, 'skipped_by_customer', now);
    }
  }

  async reverseCustomerLeave(context: TransactionContext, key: DeliveryOccurrenceKey, actorUserId: string): Promise<void> {
    void actorUserId;
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<DeliveryRow[]>(Prisma.sql`
      SELECT ${deliveryColumns} FROM scheduled_deliveries d
      JOIN LATERAL (
        SELECT event_type,source,reason_code FROM delivery_events e
        WHERE e.vendor_id=d.vendor_id AND e.scheduled_delivery_id=d.id
        ORDER BY e.created_at DESC,e.id DESC LIMIT 1
      ) latest ON latest.event_type='skipped_by_customer' AND (
        latest.source='customer' OR (latest.source='system' AND latest.reason_code='customer_on_leave')
      )
      WHERE d.vendor_id=${key.vendorId}::uuid AND d.subscription_id=${key.subscriptionId}::uuid
        AND d.service_date=${key.serviceDate}::date AND d.delivery_slot_id=${key.deliverySlotId}::uuid
        AND d.status='skipped_by_customer'
      ORDER BY d.id FOR UPDATE OF d`);
    for (const row of rows) {
      const now = new Date();
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE scheduled_deliveries SET status='scheduled',finalized_at=NULL,version=version+1,updated_at=${now}
        WHERE id=${row.id}::uuid AND vendor_id=${key.vendorId}::uuid AND version=${row.version}`);
      if (changed !== 1) throw failure('STALE_VERSION', 'Delivery version is stale', 409);
    }
  }

  async createPriceSnapshot(context: TransactionContext, input: CreatePriceSnapshot): Promise<void> {
    try {
      await unwrapPrismaTransaction(context).$executeRaw(Prisma.sql`
        INSERT INTO delivery_price_snapshots(
          vendor_id,scheduled_delivery_id,amount_minor,currency,pricing_level,source_price_id,source_price_type,resolved_at
        ) VALUES (
          ${input.vendorId}::uuid,${input.scheduledDeliveryId}::uuid,${input.amountMinor}::bigint,
          ${input.currency},${input.pricingLevel},${input.sourcePriceId}::uuid,${input.sourcePriceType},${input.resolvedAt})`);
    } catch (error) {
      if (/duplicate key|unique/i.test(String(error))) {
        throw failure('DELIVERY_SNAPSHOT_EXISTS', 'Delivery price snapshot already exists', 409);
      }
      throw error;
    }
  }

  async listVendor(context: TransactionContext, input: VendorDeliveryQuery): Promise<DeliveryPage> {
    return this.list(unwrapPrismaTransaction(context), input.vendorId, input);
  }

  async getVendorDetail(context: TransactionContext, vendorId: string, id: string): Promise<DeliveryDetail> {
    return this.detail(unwrapPrismaTransaction(context), vendorId, id);
  }

  async listCustomer(context: TransactionContext, input: CustomerDeliveryQuery): Promise<DeliveryPage> {
    return this.list(unwrapPrismaTransaction(context), input.vendorId, input, input.householdId);
  }

  async getCustomerDetail(context: TransactionContext, vendorId: string, householdId: string, id: string): Promise<DeliveryDetail> {
    const detail = await this.detail(unwrapPrismaTransaction(context), vendorId, id);
    if (detail.householdId !== householdId) throw failure('DELIVERY_NOT_FOUND', 'Delivery was not found', 404);
    return detail;
  }

  private async list(
    tx: ReturnType<typeof unwrapPrismaTransaction>,
    vendorId: string,
    query: VendorDeliveryQuery | CustomerDeliveryQuery,
    householdId?: string,
  ): Promise<DeliveryPage> {
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const filters = [Prisma.sql`d.vendor_id=${vendorId}::uuid`];
    const scopedHouseholdId = householdId ?? ('householdId' in query ? query.householdId : undefined);
    if (scopedHouseholdId) filters.push(Prisma.sql`d.household_id=${scopedHouseholdId}::uuid`);
    if ('serviceDate' in query && query.serviceDate) filters.push(Prisma.sql`d.service_date=${query.serviceDate}::date`);
    if ('productId' in query && query.productId) filters.push(Prisma.sql`d.product_id=${query.productId}::uuid`);
    if ('routeAssignmentId' in query && query.routeAssignmentId) filters.push(Prisma.sql`d.route_assignment_id=${query.routeAssignmentId}::uuid`);
    if ('routeId' in query && query.routeId) filters.push(Prisma.sql`a.route_id=${query.routeId}::uuid`);
    if ('agentMembershipId' in query && query.agentMembershipId) filters.push(Prisma.sql`a.agent_membership_id=${query.agentMembershipId}::uuid`);
    if ('currentStatus' in query && query.currentStatus) filters.push(Prisma.sql`d.status=${query.currentStatus}`);
    if (cursor) filters.push(Prisma.sql`(d.service_date<${cursor.createdAt}::date OR (d.service_date=${cursor.createdAt}::date AND d.id<${cursor.id}::uuid))`);
    const rows = await tx.$queryRaw<DeliveryRow[]>(Prisma.sql`
      SELECT ${deliveryProjectionColumns} FROM scheduled_deliveries d
      ${latestDeliveryQuantityJoin}
      LEFT JOIN route_assignments a ON a.vendor_id=d.vendor_id AND a.id=d.route_assignment_id
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY d.service_date DESC,d.id DESC LIMIT ${limit + 1}`);
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => this.record(row)),
      ...(rows.length > limit && last
        ? { nextCursor: this.cursors.encode({ createdAt: new Date(`${last.serviceDate}T00:00:00.000Z`), id: last.id }) }
        : {}),
    };
  }

  private async detail(tx: ReturnType<typeof unwrapPrismaTransaction>, vendorId: string, id: string): Promise<DeliveryDetail> {
    const rows = await tx.$queryRaw<DeliveryRow[]>(Prisma.sql`
      SELECT ${deliveryProjectionColumns} FROM scheduled_deliveries d
      ${latestDeliveryQuantityJoin}
      WHERE d.vendor_id=${vendorId}::uuid AND d.id=${id}::uuid`);
    if (!rows[0]) throw failure('DELIVERY_NOT_FOUND', 'Delivery was not found', 404);
    const [events, snapshots, customers] = await Promise.all([
      tx.$queryRaw<EventRow[]>(Prisma.sql`
        SELECT id,event_type AS "eventType",source,actor_user_id AS "actorUserId",occurred_at AS "occurredAt",
          received_at AS "receivedAt",actual_quantity::text AS "actualQuantity",reason_code AS "reasonCode",note,
          latitude::text AS latitude,longitude::text AS longitude,replaced_event_id AS "replacedEventId",created_at AS "createdAt"
        FROM delivery_events WHERE vendor_id=${vendorId}::uuid AND scheduled_delivery_id=${id}::uuid
        ORDER BY occurred_at,created_at,id`),
      tx.$queryRaw<SnapshotRow[]>(Prisma.sql`
        SELECT amount_minor AS "amountMinor",currency,pricing_level AS "pricingLevel",source_price_id AS "sourcePriceId",
          source_price_type AS "sourcePriceType",resolved_at AS "resolvedAt"
        FROM delivery_price_snapshots WHERE vendor_id=${vendorId}::uuid AND scheduled_delivery_id=${id}::uuid`),
      tx.$queryRaw<Readonly<{ userId: string }>[]>(Prisma.sql`
        SELECT m.user_id AS "userId" FROM household_members h
        JOIN vendor_memberships m ON m.vendor_id=h.vendor_id AND m.id=h.customer_membership_id
        WHERE h.vendor_id=${vendorId}::uuid AND h.household_id=${rows[0].householdId}::uuid
          AND h.status='active' AND m.role='customer' AND m.status='active' AND m.ended_at IS NULL AND m.deleted_at IS NULL
        ORDER BY m.user_id`),
    ]);
    return { ...this.record(rows[0]), events: events.map((event) => this.event(event)), ...(snapshots[0] ? { snapshot: this.snapshot(snapshots[0]) } : {}), ...(customers.length ? { customerUserIds: customers.map(({ userId }) => userId) } : {}) };
  }

  private async lockDelivery(tx: ReturnType<typeof unwrapPrismaTransaction>, vendorId: string, id: string): Promise<DeliveryRow> {
    const rows = await tx.$queryRaw<DeliveryRow[]>(Prisma.sql`
      SELECT ${deliveryColumns} FROM scheduled_deliveries
      WHERE vendor_id=${vendorId}::uuid AND id=${id}::uuid FOR UPDATE`);
    if (!rows[0]) throw failure('DELIVERY_NOT_FOUND', 'Delivery was not found', 404);
    return rows[0];
  }

  private async requirePriceSnapshot(
    tx: ReturnType<typeof unwrapPrismaTransaction>, vendorId: string, scheduledDeliveryId: string,
  ): Promise<void> {
    const snapshots = await tx.$queryRaw<Readonly<{ present: boolean }>[]>(Prisma.sql`
      SELECT EXISTS(
        SELECT 1 FROM delivery_price_snapshots
        WHERE vendor_id=${vendorId}::uuid AND scheduled_delivery_id=${scheduledDeliveryId}::uuid
      ) AS present`);
    if (!snapshots[0]?.present) {
      throw failure('DELIVERY_PRICE_SNAPSHOT_REQUIRED', 'Delivered outcome requires a price snapshot', 409);
    }
  }

  private async updateProjection(
    tx: ReturnType<typeof unwrapPrismaTransaction>, vendorId: string, id: string, version: number,
    status: DeliveryFinalStatus, finalizedAt: Date,
  ): Promise<DeliveryRecord> {
    const rows = await tx.$queryRaw<DeliveryRow[]>(Prisma.sql`
      UPDATE scheduled_deliveries SET status=${status},finalized_at=${finalizedAt},version=version+1,updated_at=${finalizedAt}
      WHERE vendor_id=${vendorId}::uuid AND id=${id}::uuid AND version=${version}
      RETURNING ${deliveryColumns}`);
    if (!rows[0]) throw failure('STALE_VERSION', 'Delivery version is stale', 409);
    return this.record(rows[0]);
  }

  private requireVersion(current: DeliveryRow, expected: number): void {
    if (current.version !== expected) throw failure('STALE_VERSION', 'Delivery version is stale', 409);
  }

  private record(row: DeliveryRow): DeliveryRecord {
    return {
      id: row.id, vendorId: row.vendorId, subscriptionId: row.subscriptionId, householdId: row.householdId,
      productId: row.productId, unitId: row.unitId, deliverySlotId: row.deliverySlotId, serviceDate: row.serviceDate,
      plannedQuantity: canonicalDecimal(row.plannedQuantity), currentStatus: row.currentStatus, version: row.version,
      ...(row.currentStatus === 'delivered' && row.actualQuantity
        ? { actualQuantity: canonicalDecimal(row.actualQuantity) }
        : {}),
      ...(row.routeAssignmentId ? { routeAssignmentId: row.routeAssignmentId } : {}),
      ...(row.finalizedAt ? { finalizedAt: row.finalizedAt } : {}),
    };
  }

  private event(row: EventRow): DeliveryEvent {
    return {
      id: row.id, eventType: row.eventType, source: row.source, occurredAt: row.occurredAt, receivedAt: row.receivedAt,
      createdAt: row.createdAt, ...(row.actorUserId ? { actorUserId: row.actorUserId } : {}),
      ...(row.actualQuantity ? { actualQuantity: canonicalDecimal(row.actualQuantity) } : {}),
      ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}), ...(row.note ? { note: row.note } : {}),
      ...(row.latitude ? { latitude: row.latitude } : {}), ...(row.longitude ? { longitude: row.longitude } : {}),
      ...(row.replacedEventId ? { replacedEventId: row.replacedEventId } : {}),
    };
  }

  private snapshot(row: SnapshotRow): DeliveryPriceSnapshot {
    return { ...row, amountMinor: row.amountMinor.toString(), currency: row.currency.trim() };
  }
}

function canonicalDecimal(value: string): string {
  const [integer, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/u, '');
  return trimmed ? `${integer}.${trimmed}` : integer;
}

function failure(code: string, message: string, status: number): ApplicationError {
  return new ApplicationError(code, message, status);
}
