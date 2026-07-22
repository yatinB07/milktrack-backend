import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma, type LeaveOccurrenceDecision } from '../../generated/prisma/client.js';
import {
  LeaveStore,
  type DecideLeaveOccurrence,
  type LeaveDecisionListInput,
  type LeaveDecisionPage,
  type LeaveDecisionRecord,
  type LeaveDecisionResult,
  type LeaveListInput,
  type LeaveOccurrenceKey,
  type LeavePreviewInput,
  type LeavePreviewPage,
  type LeaveRequestPage,
  type LeaveRequestRecord,
  type PersistLeaveRevision,
} from '../application/leave.store.js';
import {
  classifyLeaveOccurrence,
  countWeekdayOccurrences,
  deriveLeaveOccurrences,
  deriveLeaveStatus,
  requestedEffectiveStatus,
  type LeaveOccurrencePlan,
} from '../domain/leave-rules.js';

const requestInclude = {
  revisions: {
    include: { subscriptions: { select: {
      subscriptionId: true, selected: true,
      occurrenceDecisions: { orderBy: [{ serviceDate: 'asc' as const }, { id: 'asc' as const }] },
    }, orderBy: { subscriptionId: 'asc' as const } } },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
  },
} satisfies Prisma.LeaveRequestInclude;
type RequestRow = Prisma.LeaveRequestGetPayload<{ include: typeof requestInclude }>;

const error = (code: string, message: string, status: number) => new ApplicationError(code, message, status);
const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
const dateString = (value: Date) => value.toISOString().slice(0, 10);

@Injectable()
export class PrismaLeaveStore extends LeaveStore {
  private readonly cursors = new CursorCodec();

  async lockSubscriptions(context: TransactionContext, vendorId: string, ids: readonly string[]) {
    this.requireSelection(ids);
    const rows = await unwrapPrismaTransaction(context).$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM subscriptions WHERE vendor_id=${vendorId}::uuid AND id=ANY(${[...ids]}::uuid[]) AND deleted_at IS NULL
      ORDER BY id FOR UPDATE`);
    if (rows.length !== ids.length) throw error('LEAVE_SUBSCRIPTION_NOT_FOUND', 'An active subscription was not found', 404);
  }

  async preview(context: TransactionContext, input: LeavePreviewInput): Promise<LeavePreviewPage> {
    await this.requireApplicableSelection(context, input, false);
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<Array<{
      subscriptionId: string; deliverySlotId: string; weekdays: number[]; effectiveFrom: string; effectiveTo: string | null; slotStartLocalTime: string;
    }>>(Prisma.sql`
      SELECT s.id AS "subscriptionId",r.delivery_slot_id AS "deliverySlotId",array_agg(w.weekday ORDER BY w.weekday) AS weekdays,
        r.effective_from::text AS "effectiveFrom",r.effective_to::text AS "effectiveTo",to_char(slot.start_local_time,'HH24:MI') AS "slotStartLocalTime"
      FROM subscriptions s JOIN subscription_revisions r ON r.vendor_id=s.vendor_id AND r.subscription_id=s.id
      JOIN subscription_revision_weekdays w ON w.vendor_id=r.vendor_id AND w.subscription_revision_id=r.id
      JOIN delivery_slots slot ON slot.vendor_id=r.vendor_id AND slot.id=r.delivery_slot_id
      WHERE s.vendor_id=${input.vendorId}::uuid AND s.household_id=${input.householdId}::uuid AND s.id=ANY(${[...input.subscriptionIds]}::uuid[])
        AND s.deleted_at IS NULL AND r.superseded_at IS NULL AND r.status='active'
        AND r.effective_from<=${input.endDate}::date AND (r.effective_to IS NULL OR r.effective_to>${input.startDate}::date)
      GROUP BY s.id,r.id,slot.start_local_time ORDER BY s.id,r.id`);
    const plans: LeaveOccurrencePlan[] = rows.map((row) => ({
      subscriptionId: row.subscriptionId, deliverySlotId: row.deliverySlotId, weekdays: row.weekdays,
      effectiveFrom: row.effectiveFrom, ...(row.effectiveTo ? { effectiveTo: row.effectiveTo } : {}),
    }));
    const cursor = input.cursor ? decodeOccurrenceCursor(input.cursor) : undefined;
    const page = deriveLeaveOccurrences({ startDate: input.startDate, endDate: input.endDate, subscriptions: plans, limit: input.limit, cursor });
    const byOccurrence = new Map(rows.map((row) => [`${row.subscriptionId}:${row.deliverySlotId}`, row]));
    const items = page.items.map((occurrence) => {
      const row = byOccurrence.get(`${occurrence.subscriptionId}:${occurrence.deliverySlotId}`);
      if (!row) throw error('LEAVE_SUBSCRIPTION_NOT_FOUND', 'Subscription schedule was not found', 404);
      return { ...occurrence, ...classifyLeaveOccurrence({
        timezone: input.timezone, serviceDate: occurrence.serviceDate, slotStartLocalTime: row.slotStartLocalTime,
        skipCutoffMinutes: input.skipCutoffMinutes, lateLeavePolicy: input.lateLeavePolicy, now: input.now,
      }) };
    });
    const total = plans.reduce((sum, plan) => sum + plan.weekdays.reduce((count, weekday) => {
      const start = plan.effectiveFrom && plan.effectiveFrom > input.startDate ? plan.effectiveFrom : input.startDate;
      const endExclusive = plan.effectiveTo && plan.effectiveTo < dateAfter(input.endDate) ? plan.effectiveTo : dateAfter(input.endDate);
      return count + (start < endExclusive ? countWeekdayOccurrences(start, dateBefore(endExclusive), weekday) : 0);
    }, 0), 0);
    const lateCount = this.countLateOccurrences(rows, input);
    return { items, ...(page.nextCursor ? { nextCursor: encodeOccurrenceCursor(page.nextCursor) } : {}), onTimeCount: total - lateCount, lateCount };
  }

  async assertNoOverlap(context: TransactionContext, input: LeavePreviewInput): Promise<void> {
    await this.requireNoOverlap(unwrapPrismaTransaction(context), input, input.subscriptionIds);
  }

  async createRevision(context: TransactionContext, input: PersistLeaveRevision): Promise<LeaveRequestRecord> {
    const tx = unwrapPrismaTransaction(context);
    const subscriptionIds = input.subscriptions.map(({ subscriptionId }) => subscriptionId);
    const selectedSubscriptionIds = input.subscriptions.filter(({ selected }) => selected).map(({ subscriptionId }) => subscriptionId);
    this.requireSelection(subscriptionIds);
    if (input.previousRevisionId) {
      const current = await tx.$queryRaw<Array<{ id: string; status: string; version: number; currentRevisionId: string | null }>>(Prisma.sql`
        SELECT id,status,version,current_revision_id AS "currentRevisionId" FROM leave_requests
        WHERE vendor_id=${input.vendorId}::uuid AND household_id=${input.householdId}::uuid AND id=${input.requestId}::uuid FOR UPDATE`);
      const row = current[0];
      if (!row) throw error('LEAVE_REQUEST_NOT_FOUND', 'Leave request was not found', 404);
      if (row.version !== input.expectedVersion || row.currentRevisionId !== input.previousRevisionId)
        throw error('LEAVE_REQUEST_VERSION_CONFLICT', 'Leave request was changed by another request', 409);
      if (row.status === 'cancelled')
        throw error('LEAVE_REQUEST_STATE_CONFLICT', 'Cancelled leave requests cannot be changed', 409);
    }
    if (selectedSubscriptionIds.length > 0) {
      await this.requireApplicableSelection(context, { ...input, subscriptionIds: selectedSubscriptionIds }, true);
    }
    if (input.action !== 'cancel') await this.requireNoOverlap(tx, input, selectedSubscriptionIds);
    if (!input.previousRevisionId) {
      await tx.leaveRequest.create({ data: { id: input.requestId, vendorId: input.vendorId, householdId: input.householdId, status: input.status } });
    }
    await tx.leaveRequestRevision.create({ data: {
      id: input.revisionId, vendorId: input.vendorId, leaveRequestId: input.requestId, action: input.action,
      startDate: date(input.startDate), endDate: date(input.endDate), source: input.source, createdBy: input.createdBy,
      status: input.status, ...(input.note ? { note: input.note } : {}), ...(input.previousRevisionId ? { previousRevisionId: input.previousRevisionId } : {}),
    } });
    await tx.leaveRevisionSubscription.createMany({ data: input.subscriptions.map(({ subscriptionId, selected }) => ({
      vendorId: input.vendorId, leaveRequestRevisionId: input.revisionId, subscriptionId, selected,
    })) });
    if (input.decisions.length > 0) await tx.leaveOccurrenceDecision.createMany({ data: input.decisions.map((decision) => ({
      id: decision.id, vendorId: input.vendorId, leaveRequestRevisionId: input.revisionId,
      subscriptionId: decision.subscriptionId ?? selectedSubscriptionIds[0] ?? subscriptionIds[0], serviceDate: date(decision.serviceDate), deliverySlotId: decision.deliverySlotId,
      previousEffectiveStatus: decision.previousEffectiveStatus ?? 'scheduled',
      requestedEffectiveStatus: decision.requestedEffectiveStatus ?? requestedEffectiveStatus(input.action),
      status: decision.status,
      ...(decision.status === 'rejected' ? { decidedBy: input.createdBy, decidedAt: new Date(), decisionReason: 'Late leave rejected by vendor policy' } : {}),
    })) });
    await tx.leaveRequest.update({ where: { id: input.requestId }, data: { currentRevisionId: input.revisionId, status: input.status, ...(input.previousRevisionId ? { version: { increment: 1 } } : {}) } });
    return this.getRequest(context, input.vendorId, input.householdId, input.requestId);
  }

  async getRequest(context: TransactionContext, vendorId: string, householdId: string, id: string): Promise<LeaveRequestRecord> {
    const row = await unwrapPrismaTransaction(context).leaveRequest.findFirst({ where: { id, vendorId, householdId }, include: requestInclude });
    if (!row) throw error('LEAVE_REQUEST_NOT_FOUND', 'Leave request was not found', 404);
    return this.request(row);
  }

  async getVendorRequest(context: TransactionContext, vendorId: string, id: string): Promise<LeaveRequestRecord> {
    const row = await unwrapPrismaTransaction(context).leaveRequest.findFirst({ where: { id, vendorId }, include: requestInclude });
    if (!row) throw error('LEAVE_REQUEST_NOT_FOUND', 'Leave request was not found', 404);
    return this.request(row);
  }

  async listRequests(context: TransactionContext, input: LeaveListInput): Promise<LeaveRequestPage> {
    const limit = this.cursors.parseLimit(input.limit); const cursor = input.cursor ? this.cursors.decode(input.cursor) : undefined;
    const rows = await unwrapPrismaTransaction(context).leaveRequest.findMany({
      where: { vendorId: input.vendorId, householdId: input.householdId, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
      include: requestInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
    });
    const items = rows.slice(0, limit).map((row) => this.request(row)); const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode({ createdAt: last.createdAt, id: last.id }) } : {}) };
  }

  async listPendingDecisions(context: TransactionContext, input: LeaveDecisionListInput): Promise<LeaveDecisionPage> {
    const limit = this.cursors.parseLimit(input.limit); const cursor = input.cursor ? this.cursors.decode(input.cursor) : undefined;
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<Array<{
      id: string; vendorId: string; leaveRequestRevisionId: string; subscriptionId: string; serviceDate: Date;
      deliverySlotId: string; status: string; version: number; createdAt: Date;
    }>>(Prisma.sql`
      SELECT d.id,d.vendor_id AS "vendorId",d.leave_request_revision_id AS "leaveRequestRevisionId",
        d.subscription_id AS "subscriptionId",d.service_date AS "serviceDate",d.delivery_slot_id AS "deliverySlotId",
        d.status,d.version,d.created_at AS "createdAt"
      FROM leave_occurrence_decisions d
      JOIN leave_request_revisions r ON r.vendor_id=d.vendor_id AND r.id=d.leave_request_revision_id
      JOIN leave_requests q ON q.vendor_id=r.vendor_id AND q.id=r.leave_request_id AND q.current_revision_id=r.id
      WHERE d.vendor_id=${input.vendorId}::uuid AND d.status='pending'
        ${cursor ? Prisma.sql`AND (d.service_date>${cursor.createdAt}::date OR (d.service_date=${cursor.createdAt}::date AND d.id>${cursor.id}::uuid))` : Prisma.empty}
      ORDER BY d.service_date,d.id LIMIT ${limit + 1}`);
    const items = rows.slice(0, limit).map((row) => ({ ...row, serviceDate: dateString(row.serviceDate), status: row.status as LeaveDecisionRecord['status'] }));
    const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode({ createdAt: date(last.serviceDate), id: last.id }) } : {}) };
  }

  async decide(context: TransactionContext, input: DecideLeaveOccurrence): Promise<LeaveDecisionResult> {
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<Array<{ id: string; leaveRequestRevisionId: string; subscriptionId: string; serviceDate: Date; deliverySlotId: string; version: number; requestId: string; householdId: string; action: string; requestedEffectiveStatus: string }>>(Prisma.sql`
      SELECT d.id,d.leave_request_revision_id AS "leaveRequestRevisionId",d.subscription_id AS "subscriptionId",d.service_date AS "serviceDate",d.delivery_slot_id AS "deliverySlotId",d.version,r.leave_request_id AS "requestId",q.household_id AS "householdId",r.action,d.requested_effective_status AS "requestedEffectiveStatus"
      FROM leave_occurrence_decisions d JOIN leave_request_revisions r ON r.vendor_id=d.vendor_id AND r.id=d.leave_request_revision_id
      JOIN leave_requests q ON q.vendor_id=r.vendor_id AND q.id=r.leave_request_id AND q.current_revision_id=r.id
      WHERE d.vendor_id=${input.vendorId}::uuid AND d.id=${input.id}::uuid FOR UPDATE OF q,d`);
    const locked = rows[0];
    if (!locked) throw error('LEAVE_DECISION_NOT_FOUND', 'Leave decision was not found', 404);
    if (locked.version !== input.expectedVersion) throw error('LEAVE_DECISION_VERSION_CONFLICT', 'Leave decision was changed by another request', 409);
    const deliveries = await tx.$queryRaw<Array<{ id: string; status: string; finalizedAt: Date | null; latestSource: string | null; latestReasonCode: string | null }>>(Prisma.sql`
      SELECT d.id,d.status,d.finalized_at AS "finalizedAt",latest.source AS "latestSource",latest.reason_code AS "latestReasonCode"
      FROM scheduled_deliveries d LEFT JOIN LATERAL (
        SELECT source,reason_code FROM delivery_events e WHERE e.vendor_id=d.vendor_id AND e.scheduled_delivery_id=d.id
        ORDER BY e.created_at DESC,e.id DESC LIMIT 1
      ) latest ON true
      WHERE d.vendor_id=${input.vendorId}::uuid AND d.subscription_id=${locked.subscriptionId}::uuid
        AND d.service_date=${locked.serviceDate}::date AND d.delivery_slot_id=${locked.deliverySlotId}::uuid
      FOR UPDATE OF d`);
    const reversibleLeaveSkip = (row: typeof deliveries[number]) => locked.requestedEffectiveStatus === 'scheduled'
      && row.status === 'skipped_by_customer'
      && (row.latestSource === 'customer' || row.latestSource === 'vendor_admin'
        || (row.latestSource === 'system' && row.latestReasonCode === 'customer_on_leave'));
    if (deliveries.some((row) => !reversibleLeaveSkip(row)
      && (row.finalizedAt || ['delivered', 'skipped_by_customer', 'skipped_by_agent', 'missed'].includes(row.status))))
      throw error('LEAVE_OCCURRENCE_FINALIZED', 'Leave occurrence already has a final delivery outcome', 409);
    const changed = await tx.leaveOccurrenceDecision.updateMany({ where: { id: input.id, vendorId: input.vendorId, status: 'pending', version: input.expectedVersion }, data: {
      status: input.decision, decidedBy: input.decidedBy, decidedAt: input.now, decisionReason: input.reason, version: { increment: 1 },
    } });
    if (changed.count !== 1) throw error('LEAVE_DECISION_STATE_CONFLICT', 'Leave decision is no longer pending', 409);
    const [decisions, selectedSnapshot] = await Promise.all([
      tx.leaveOccurrenceDecision.findMany({ where: { vendorId: input.vendorId, leaveRequestRevisionId: locked.leaveRequestRevisionId },
        select: { id: true, status: true, previousEffectiveStatus: true, requestedEffectiveStatus: true } }),
      this.selectedOccurrenceSnapshot(tx, input.vendorId, locked.leaveRequestRevisionId),
    ]);
    const pending = decisions.filter(({ status }) => status === 'pending').length;
    const effective = Math.max(0, decisions.reduce((count, decision) => {
      const baseline = selectedSnapshot.decisionIds.has(decision.id) ? 'skipped_by_customer' : 'scheduled';
      const resolved = decision.status === 'approved' ? decision.requestedEffectiveStatus : decision.previousEffectiveStatus;
      return count + Number(resolved === 'skipped_by_customer') - Number(baseline === 'skipped_by_customer');
    }, selectedSnapshot.total));
    const status = pending > 0
      ? deriveLeaveStatus({ effective, pending })
      : effective > 0 ? 'accepted' : locked.action === 'cancel' ? 'cancelled' : 'rejected';
    await tx.leaveRequest.update({ where: { id: locked.requestId }, data: { status, version: { increment: 1 } } });
    const decision = await tx.leaveOccurrenceDecision.findFirst({ where: { id: input.id, vendorId: input.vendorId } });
    if (!decision) throw error('LEAVE_DECISION_NOT_FOUND', 'Leave decision was not found', 404);
    return { ...this.decision(decision), request: await this.getRequest(context, input.vendorId, locked.householdId, locked.requestId) };
  }

  async isEffectivelyOnLeave(context: TransactionContext, input: LeaveOccurrenceKey): Promise<boolean> {
    return (await this.effectiveOccurrenceKeys(context, {
      vendorId: input.vendorId,
      candidates: [{ subscriptionId: input.subscriptionId, deliverySlotId: input.deliverySlotId, serviceDate: input.serviceDate }],
    })).has(occurrenceKey(input));
  }

  async effectiveOccurrenceKeys(context: TransactionContext, input: Readonly<{
    vendorId: string;
    candidates: readonly Readonly<{ subscriptionId: string; deliverySlotId: string; serviceDate: string }>[];
  }>): Promise<ReadonlySet<string>> {
    if (input.candidates.length === 0) return new Set();
    const rows = await unwrapPrismaTransaction(context).$queryRaw<Array<{ key: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT DISTINCT c."subscriptionId",c."deliverySlotId",c."serviceDate"
        FROM jsonb_to_recordset(${JSON.stringify(input.candidates)}::jsonb)
          AS c("subscriptionId" uuid,"deliverySlotId" uuid,"serviceDate" date)
      ), ranked AS (
        SELECT c."subscriptionId",c."deliverySlotId",c."serviceDate",r.action,q.status,s.selected,
          c."serviceDate" BETWEEN r.start_date AND r.end_date AS "inRange",
          d.status AS "decisionStatus",d.requested_effective_status AS "requestedStatus",d.previous_effective_status AS "previousStatus",
          row_number() OVER (PARTITION BY c."serviceDate",c."subscriptionId",c."deliverySlotId" ORDER BY r.created_at DESC,r.id DESC) AS precedence
        FROM candidates c
        JOIN leave_revision_subscriptions s ON s.vendor_id=${input.vendorId}::uuid AND s.subscription_id=c."subscriptionId"
        JOIN leave_request_revisions r ON r.vendor_id=s.vendor_id AND r.id=s.leave_request_revision_id
        JOIN leave_requests q ON q.vendor_id=r.vendor_id AND q.id=r.leave_request_id AND q.current_revision_id=r.id
        LEFT JOIN leave_occurrence_decisions d ON d.vendor_id=r.vendor_id AND d.leave_request_revision_id=r.id
          AND d.subscription_id=c."subscriptionId" AND d.service_date=c."serviceDate" AND d.delivery_slot_id=c."deliverySlotId"
      )
      SELECT "serviceDate"::text || ':' || "subscriptionId"::text || ':' || "deliverySlotId"::text AS key
      FROM ranked
      WHERE precedence=1 AND (
        ("decisionStatus"='approved' AND "requestedStatus"='skipped_by_customer')
        OR ("decisionStatus" IN ('pending','rejected') AND "previousStatus"='skipped_by_customer')
        OR ("decisionStatus" IS NULL AND "inRange" AND selected AND action<>'cancel' AND status IN ('accepted','partially_pending'))
      )`);
    return new Set(rows.map(({ key }) => key));
  }

  private async requireApplicableSelection(context: TransactionContext, input: Readonly<{
    vendorId: string; householdId: string; subscriptionIds: readonly string[]; startDate: string; endDate: string;
  }>, lock: boolean) {
    this.requireSelection(input.subscriptionIds);
    const rows = await unwrapPrismaTransaction(context).$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT s.id FROM subscriptions s
      WHERE s.vendor_id=${input.vendorId}::uuid AND s.household_id=${input.householdId}::uuid
        AND s.id=ANY(${[...input.subscriptionIds]}::uuid[]) AND s.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM subscription_revisions r
          WHERE r.vendor_id=s.vendor_id AND r.subscription_id=s.id AND r.superseded_at IS NULL AND r.status='active'
            AND r.effective_from<=${input.endDate}::date AND (r.effective_to IS NULL OR r.effective_to>${input.startDate}::date))
      ORDER BY s.id ${lock ? Prisma.sql`FOR UPDATE OF s` : Prisma.empty}`);
    if (rows.length !== input.subscriptionIds.length)
      throw error('LEAVE_SUBSCRIPTION_NOT_ACTIVE', 'A selected subscription has no active schedule for the leave range', 409);
  }

  private countLateOccurrences(rows: readonly Readonly<{
    subscriptionId: string; deliverySlotId: string; weekdays: number[]; effectiveFrom: string; effectiveTo: string | null; slotStartLocalTime: string;
  }>[], input: LeavePreviewInput) {
    const boundary = DateTime.fromJSDate(input.now, { zone: input.timezone }).plus({ minutes: input.skipCutoffMinutes }).toISODate();
    if (!boundary) throw error('INVALID_CURRENT_TIME', 'Current time or timezone is invalid', 400);
    return rows.reduce((total, row) => {
      const start = row.effectiveFrom > input.startDate ? row.effectiveFrom : input.startDate;
      const endExclusive = row.effectiveTo && row.effectiveTo < dateAfter(input.endDate) ? row.effectiveTo : dateAfter(input.endDate);
      if (start >= endExclusive) return total;
      const end = dateBefore(endExclusive);
      const beforeBoundary = dateBefore(boundary);
      const definitelyLateEnd = end < beforeBoundary ? end : beforeBoundary;
      const weekdays = [...new Set(row.weekdays)];
      const earlier = start <= definitelyLateEnd
        ? weekdays.reduce((count, weekday) => count + countWeekdayOccurrences(start, definitelyLateEnd, weekday), 0)
        : 0;
      const boundaryIsScheduled = boundary >= start && boundary <= end
        && weekdays.includes(DateTime.fromISO(boundary, { zone: 'UTC' }).weekday);
      const boundaryLate = boundaryIsScheduled && classifyLeaveOccurrence({
        timezone: input.timezone, serviceDate: boundary, slotStartLocalTime: row.slotStartLocalTime,
        skipCutoffMinutes: input.skipCutoffMinutes, lateLeavePolicy: input.lateLeavePolicy, now: input.now,
      }).timing === 'late' ? 1 : 0;
      return total + earlier + boundaryLate;
    }, 0);
  }

  private requireSelection(ids: readonly string[]) {
    if (ids.length === 0 || new Set(ids).size !== ids.length) throw error('LEAVE_SUBSCRIPTION_SELECTION', 'Leave selection requires unique subscriptions', 400);
  }

  private async requireNoOverlap(tx: Prisma.TransactionClient, input: Readonly<{
    vendorId: string; householdId: string; startDate: string; endDate: string; requestId?: string; previousRevisionId?: string;
  }>, subscriptionIds: readonly string[]) {
    const rows = await tx.$queryRaw<Array<{ overlap: boolean }>>(Prisma.sql`
      SELECT EXISTS(SELECT 1 FROM leave_requests q JOIN leave_request_revisions r ON r.vendor_id=q.vendor_id AND r.id=q.current_revision_id
        JOIN leave_revision_subscriptions s ON s.vendor_id=r.vendor_id AND s.leave_request_revision_id=r.id
        WHERE q.vendor_id=${input.vendorId}::uuid AND q.household_id=${input.householdId}::uuid
          AND q.status IN ('pending_approval','partially_pending','accepted') AND r.action<>'cancel'
          AND daterange(r.start_date,r.end_date,'[]') && daterange(${input.startDate}::date,${input.endDate}::date,'[]')
          AND s.selected AND s.subscription_id=ANY(${[...subscriptionIds]}::uuid[])
          ${input.previousRevisionId ? Prisma.sql`AND q.id<>${input.requestId}::uuid` : Prisma.empty}) AS overlap`);
    if (rows[0]?.overlap) throw error('LEAVE_OVERLAP', 'Leave overlaps an active request', 409);
  }

  private async selectedOccurrenceSnapshot(tx: Prisma.TransactionClient, vendorId: string, revisionId: string) {
    const rows = await tx.$queryRaw<Array<{ selectedOccurrences: number; selectedDecisionIds: string[] }>>(Prisma.sql`
      WITH selected_plans AS (
        SELECT greatest(r.effective_from,lr.start_date) AS start_date,
          least(coalesce(r.effective_to - 1,lr.end_date),lr.end_date) AS end_date,w.weekday
        FROM leave_request_revisions lr
        JOIN leave_revision_subscriptions s ON s.vendor_id=lr.vendor_id AND s.leave_request_revision_id=lr.id AND s.selected
        JOIN subscription_revisions r ON r.vendor_id=s.vendor_id AND r.subscription_id=s.subscription_id
          AND r.superseded_at IS NULL AND r.status='active'
          AND r.effective_from<=lr.end_date AND (r.effective_to IS NULL OR r.effective_to>lr.start_date)
        JOIN subscription_revision_weekdays w ON w.vendor_id=r.vendor_id AND w.subscription_revision_id=r.id
        WHERE lr.vendor_id=${vendorId}::uuid AND lr.id=${revisionId}::uuid
      ), selected_occurrences AS (
        SELECT coalesce(sum(CASE WHEN start_date + weekday_delta.weekday_offset<=end_date
          THEN ((end_date-(start_date+weekday_delta.weekday_offset))/7)+1 ELSE 0 END),0)::integer AS total
        FROM selected_plans
        CROSS JOIN LATERAL (SELECT (weekday-extract(isodow FROM start_date)::integer+7)%7 AS weekday_offset) weekday_delta
      ), selected_decisions AS (
        SELECT d.id FROM leave_occurrence_decisions d
        JOIN leave_request_revisions lr ON lr.vendor_id=d.vendor_id AND lr.id=d.leave_request_revision_id
        JOIN leave_revision_subscriptions s ON s.vendor_id=d.vendor_id AND s.leave_request_revision_id=d.leave_request_revision_id
          AND s.subscription_id=d.subscription_id AND s.selected
        JOIN subscription_revisions r ON r.vendor_id=d.vendor_id AND r.subscription_id=d.subscription_id
          AND r.delivery_slot_id=d.delivery_slot_id AND r.superseded_at IS NULL AND r.status='active'
          AND r.effective_from<=d.service_date AND (r.effective_to IS NULL OR r.effective_to>d.service_date)
        JOIN subscription_revision_weekdays w ON w.vendor_id=r.vendor_id AND w.subscription_revision_id=r.id
          AND w.weekday=extract(isodow FROM d.service_date)
        WHERE d.vendor_id=${vendorId}::uuid AND d.leave_request_revision_id=${revisionId}::uuid
          AND d.service_date BETWEEN lr.start_date AND lr.end_date
      )
      SELECT o.total AS "selectedOccurrences",
        coalesce(array_agg(DISTINCT d.id) FILTER (WHERE d.id IS NOT NULL),'{}'::uuid[]) AS "selectedDecisionIds"
      FROM selected_occurrences o LEFT JOIN selected_decisions d ON true GROUP BY o.total`);
    const snapshot = rows[0];
    return { total: snapshot?.selectedOccurrences ?? 0, decisionIds: new Set(snapshot?.selectedDecisionIds ?? []) };
  }

  private request(row: RequestRow): LeaveRequestRecord {
    return { id: row.id, vendorId: row.vendorId, householdId: row.householdId, status: row.status as LeaveRequestRecord['status'],
      ...(row.currentRevisionId ? { currentRevisionId: row.currentRevisionId } : {}), version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
      revisions: row.revisions.map((revision) => ({ id: revision.id, action: revision.action as LeaveRequestRecord['revisions'][number]['action'],
        startDate: dateString(revision.startDate), endDate: dateString(revision.endDate), source: revision.source as LeaveRequestRecord['revisions'][number]['source'],
        createdBy: revision.createdBy, status: revision.status as LeaveRequestRecord['status'], ...(revision.note ? { note: revision.note } : {}),
        ...(revision.previousRevisionId ? { previousRevisionId: revision.previousRevisionId } : {}), createdAt: revision.createdAt,
        subscriptions: revision.subscriptions.map(({ subscriptionId, selected }) => ({ subscriptionId, selected })),
        subscriptionIds: revision.subscriptions.filter(({ selected }) => selected).map(({ subscriptionId }) => subscriptionId),
        decisions: revision.subscriptions.flatMap(({ occurrenceDecisions }) => occurrenceDecisions.map((decision) => ({
          id: decision.id, subscriptionId: decision.subscriptionId, serviceDate: dateString(decision.serviceDate), deliverySlotId: decision.deliverySlotId,
          status: decision.status as LeaveDecisionRecord['status'], previousEffectiveStatus: decision.previousEffectiveStatus as 'scheduled' | 'skipped_by_customer',
          requestedEffectiveStatus: decision.requestedEffectiveStatus as 'scheduled' | 'skipped_by_customer',
          ...(decision.decidedBy ? { decidedBy: decision.decidedBy } : {}), ...(decision.decidedAt ? { decidedAt: decision.decidedAt } : {}),
          ...(decision.decisionReason ? { decisionReason: decision.decisionReason } : {}), version: decision.version, createdAt: decision.createdAt,
        }))).sort((left, right) => left.serviceDate.localeCompare(right.serviceDate) || left.id.localeCompare(right.id)),
      })), };
  }

  private decision(row: LeaveOccurrenceDecision): LeaveDecisionRecord {
    return { id: row.id, vendorId: row.vendorId, leaveRequestRevisionId: row.leaveRequestRevisionId, subscriptionId: row.subscriptionId,
      serviceDate: dateString(row.serviceDate), deliverySlotId: row.deliverySlotId, status: row.status as LeaveDecisionRecord['status'], version: row.version, createdAt: row.createdAt };
  }
}

const occurrenceKey = (input: Readonly<{ serviceDate: string; subscriptionId: string; deliverySlotId: string }>) =>
  `${input.serviceDate}:${input.subscriptionId}:${input.deliverySlotId}`;

function dateAfter(value: string) { const result = date(value); result.setUTCDate(result.getUTCDate() + 1); return dateString(result); }
function dateBefore(value: string) { const result = new Date(`${value}T00:00:00.000Z`); result.setUTCDate(result.getUTCDate() - 1); return dateString(result); }
function encodeOccurrenceCursor(value: Readonly<{ serviceDate: string; subscriptionId: string; deliverySlotId: string }>) { return Buffer.from(JSON.stringify([value.serviceDate, value.subscriptionId, value.deliverySlotId])).toString('base64url'); }
function decodeOccurrenceCursor(value: string) {
  try { const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || !Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((part) => typeof part === 'string')) throw new Error();
    return { serviceDate: parsed[0], subscriptionId: parsed[1], deliverySlotId: parsed[2] };
  } catch { throw error('INVALID_CURSOR', 'Cursor is invalid', 400); }
}
