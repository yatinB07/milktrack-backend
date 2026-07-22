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
    include: { subscriptions: { select: { subscriptionId: true }, orderBy: { subscriptionId: 'asc' as const } } },
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

  async createRevision(context: TransactionContext, input: PersistLeaveRevision): Promise<LeaveRequestRecord> {
    const tx = unwrapPrismaTransaction(context);
    await this.requireApplicableSelection(context, input, true);
    if (input.action !== 'cancel') await this.requireNoOverlap(tx, input);
    if (input.previousRevisionId) {
      const current = await tx.$queryRaw<Array<{ id: string; version: number; currentRevisionId: string | null }>>(Prisma.sql`
        SELECT id,version,current_revision_id AS "currentRevisionId" FROM leave_requests
        WHERE vendor_id=${input.vendorId}::uuid AND household_id=${input.householdId}::uuid AND id=${input.requestId}::uuid FOR UPDATE`);
      const row = current[0];
      if (!row) throw error('LEAVE_REQUEST_NOT_FOUND', 'Leave request was not found', 404);
      if (row.version !== input.expectedVersion || row.currentRevisionId !== input.previousRevisionId)
        throw error('LEAVE_REQUEST_VERSION_CONFLICT', 'Leave request was changed by another request', 409);
    } else {
      await tx.leaveRequest.create({ data: { id: input.requestId, vendorId: input.vendorId, householdId: input.householdId, status: input.status } });
    }
    await tx.leaveRequestRevision.create({ data: {
      id: input.revisionId, vendorId: input.vendorId, leaveRequestId: input.requestId, action: input.action,
      startDate: date(input.startDate), endDate: date(input.endDate), source: input.source, createdBy: input.createdBy,
      status: input.status, ...(input.note ? { note: input.note } : {}), ...(input.previousRevisionId ? { previousRevisionId: input.previousRevisionId } : {}),
    } });
    await tx.leaveRevisionSubscription.createMany({ data: input.subscriptionIds.map((subscriptionId) => ({
      vendorId: input.vendorId, leaveRequestRevisionId: input.revisionId, subscriptionId,
    })) });
    if (input.decisions.length > 0) await tx.leaveOccurrenceDecision.createMany({ data: input.decisions.map((decision) => ({
      id: decision.id, vendorId: input.vendorId, leaveRequestRevisionId: input.revisionId,
      subscriptionId: decision.subscriptionId ?? input.subscriptionIds[0], serviceDate: date(decision.serviceDate), deliverySlotId: decision.deliverySlotId,
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
    const rows = await unwrapPrismaTransaction(context).leaveOccurrenceDecision.findMany({
      where: { vendorId: input.vendorId, status: 'pending', ...(cursor ? { OR: [{ serviceDate: { gt: cursor.createdAt } }, { serviceDate: cursor.createdAt, id: { gt: cursor.id } }] } : {}) },
      orderBy: [{ serviceDate: 'asc' }, { id: 'asc' }], take: limit + 1,
    });
    const items = rows.slice(0, limit).map((row) => this.decision(row)); const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode({ createdAt: date(last.serviceDate), id: last.id }) } : {}) };
  }

  async decide(context: TransactionContext, input: DecideLeaveOccurrence): Promise<LeaveDecisionResult> {
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<Array<{ id: string; leaveRequestRevisionId: string; subscriptionId: string; serviceDate: Date; deliverySlotId: string; version: number; requestId: string; householdId: string; requestStatus: string }>>(Prisma.sql`
      SELECT d.id,d.leave_request_revision_id AS "leaveRequestRevisionId",d.subscription_id AS "subscriptionId",d.service_date AS "serviceDate",d.delivery_slot_id AS "deliverySlotId",d.version,r.leave_request_id AS "requestId",q.household_id AS "householdId",q.status AS "requestStatus"
      FROM leave_occurrence_decisions d JOIN leave_request_revisions r ON r.vendor_id=d.vendor_id AND r.id=d.leave_request_revision_id
      JOIN leave_requests q ON q.vendor_id=r.vendor_id AND q.id=r.leave_request_id
      WHERE d.vendor_id=${input.vendorId}::uuid AND d.id=${input.id}::uuid FOR UPDATE OF d`);
    const locked = rows[0];
    if (!locked) throw error('LEAVE_DECISION_NOT_FOUND', 'Leave decision was not found', 404);
    if (locked.version !== input.expectedVersion) throw error('LEAVE_DECISION_VERSION_CONFLICT', 'Leave decision was changed by another request', 409);
    const deliveries = await tx.$queryRaw<Array<{ id: string; status: string; finalizedAt: Date | null }>>(Prisma.sql`
      SELECT id,status,finalized_at AS "finalizedAt" FROM scheduled_deliveries
      WHERE vendor_id=${input.vendorId}::uuid AND subscription_id=${locked.subscriptionId}::uuid
        AND service_date=${locked.serviceDate}::date AND delivery_slot_id=${locked.deliverySlotId}::uuid
      FOR UPDATE`);
    if (deliveries.some(({ status, finalizedAt }) => finalizedAt || ['delivered', 'skipped_by_customer', 'skipped_by_agent', 'missed'].includes(status)))
      throw error('LEAVE_OCCURRENCE_FINALIZED', 'Leave occurrence already has a final delivery outcome', 409);
    const changed = await tx.leaveOccurrenceDecision.updateMany({ where: { id: input.id, vendorId: input.vendorId, status: 'pending', version: input.expectedVersion }, data: {
      status: input.decision, decidedBy: input.decidedBy, decidedAt: input.now, decisionReason: input.reason, version: { increment: 1 },
    } });
    if (changed.count !== 1) throw error('LEAVE_DECISION_STATE_CONFLICT', 'Leave decision is no longer pending', 409);
    const decisions = await tx.leaveOccurrenceDecision.findMany({ where: { vendorId: input.vendorId, leaveRequestRevisionId: locked.leaveRequestRevisionId }, select: { status: true } });
    const baselineEffective = locked.requestStatus === 'accepted' || locked.requestStatus === 'partially_pending';
    const status = deriveLeaveStatus({ effective: Number(baselineEffective || decisions.some(({ status }) => status === 'approved')), pending: decisions.filter(({ status }) => status === 'pending').length });
    await tx.leaveRequest.update({ where: { id: locked.requestId }, data: { status, version: { increment: 1 } } });
    const decision = await tx.leaveOccurrenceDecision.findFirst({ where: { id: input.id, vendorId: input.vendorId } });
    if (!decision) throw error('LEAVE_DECISION_NOT_FOUND', 'Leave decision was not found', 404);
    return { ...this.decision(decision), request: await this.getRequest(context, input.vendorId, locked.householdId, locked.requestId) };
  }

  async isEffectivelyOnLeave(context: TransactionContext, input: LeaveOccurrenceKey): Promise<boolean> {
    const rows = await unwrapPrismaTransaction(context).$queryRaw<Array<{ action: string; status: string; decisionStatus: string | null; requestedStatus: string | null; previousStatus: string | null }>>(Prisma.sql`
      SELECT r.action,q.status,d.status AS "decisionStatus",d.requested_effective_status AS "requestedStatus",d.previous_effective_status AS "previousStatus"
      FROM leave_requests q JOIN leave_request_revisions r ON r.vendor_id=q.vendor_id AND r.id=q.current_revision_id
      JOIN leave_revision_subscriptions s ON s.vendor_id=r.vendor_id AND s.leave_request_revision_id=r.id
      LEFT JOIN leave_occurrence_decisions d ON d.vendor_id=r.vendor_id AND d.leave_request_revision_id=r.id AND d.subscription_id=s.subscription_id
        AND d.service_date=${input.serviceDate}::date AND d.delivery_slot_id=${input.deliverySlotId}::uuid
      WHERE q.vendor_id=${input.vendorId}::uuid AND s.subscription_id=${input.subscriptionId}::uuid
        AND r.start_date<=${input.serviceDate}::date AND r.end_date>=${input.serviceDate}::date
      ORDER BY r.created_at DESC,r.id DESC LIMIT 1`);
    const row = rows[0];
    if (!row || row.status === 'cancelled') return false;
    if (row.decisionStatus === 'approved') return row.requestedStatus === 'skipped_by_customer';
    if (row.decisionStatus === 'pending' || row.decisionStatus === 'rejected') return row.previousStatus === 'skipped_by_customer';
    return row.action === 'create';
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

  private async requireNoOverlap(tx: Prisma.TransactionClient, input: PersistLeaveRevision) {
    const rows = await tx.$queryRaw<Array<{ overlap: boolean }>>(Prisma.sql`
      SELECT EXISTS(SELECT 1 FROM leave_requests q JOIN leave_request_revisions r ON r.vendor_id=q.vendor_id AND r.id=q.current_revision_id
        JOIN leave_revision_subscriptions s ON s.vendor_id=r.vendor_id AND s.leave_request_revision_id=r.id
        WHERE q.vendor_id=${input.vendorId}::uuid AND q.household_id=${input.householdId}::uuid
          AND q.status IN ('pending_approval','partially_pending','accepted') AND r.action<>'cancel'
          AND daterange(r.start_date,r.end_date,'[]') && daterange(${input.startDate}::date,${input.endDate}::date,'[]')
          AND s.subscription_id=ANY(${[...input.subscriptionIds]}::uuid[])
          ${input.previousRevisionId ? Prisma.sql`AND q.id<>${input.requestId}::uuid` : Prisma.empty}) AS overlap`);
    if (rows[0]?.overlap) throw error('LEAVE_OVERLAP', 'Leave overlaps an active request', 409);
  }

  private request(row: RequestRow): LeaveRequestRecord {
    return { id: row.id, vendorId: row.vendorId, householdId: row.householdId, status: row.status as LeaveRequestRecord['status'],
      ...(row.currentRevisionId ? { currentRevisionId: row.currentRevisionId } : {}), version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
      revisions: row.revisions.map((revision) => ({ id: revision.id, action: revision.action as LeaveRequestRecord['revisions'][number]['action'],
        startDate: dateString(revision.startDate), endDate: dateString(revision.endDate), source: revision.source as LeaveRequestRecord['revisions'][number]['source'],
        createdBy: revision.createdBy, status: revision.status as LeaveRequestRecord['status'], ...(revision.note ? { note: revision.note } : {}),
        ...(revision.previousRevisionId ? { previousRevisionId: revision.previousRevisionId } : {}), createdAt: revision.createdAt,
        subscriptionIds: revision.subscriptions.map(({ subscriptionId }) => subscriptionId),
      })), };
  }

  private decision(row: LeaveOccurrenceDecision): LeaveDecisionRecord {
    return { id: row.id, vendorId: row.vendorId, leaveRequestRevisionId: row.leaveRequestRevisionId, subscriptionId: row.subscriptionId,
      serviceDate: dateString(row.serviceDate), deliverySlotId: row.deliverySlotId, status: row.status as LeaveDecisionRecord['status'], version: row.version, createdAt: row.createdAt };
  }
}

function dateAfter(value: string) { const result = date(value); result.setUTCDate(result.getUTCDate() + 1); return dateString(result); }
function dateBefore(value: string) { const result = new Date(`${value}T00:00:00.000Z`); result.setUTCDate(result.getUTCDate() - 1); return dateString(result); }
function encodeOccurrenceCursor(value: Readonly<{ serviceDate: string; subscriptionId: string; deliverySlotId: string }>) { return Buffer.from(JSON.stringify([value.serviceDate, value.subscriptionId, value.deliverySlotId])).toString('base64url'); }
function decodeOccurrenceCursor(value: string) {
  try { const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || !Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((part) => typeof part === 'string')) throw new Error();
    return { serviceDate: parsed[0], subscriptionId: parsed[1], deliverySlotId: parsed[2] };
  } catch { throw error('INVALID_CURSOR', 'Cursor is invalid', 400); }
}
