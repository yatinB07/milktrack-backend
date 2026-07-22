import { DateTime } from 'luxon';

import { ApplicationError } from '../../common/errors/application.error.js';
import { resolveServiceInstant } from '../../pricing/domain/service-time.js';
import type { LateLeavePolicy } from '../../vendors/domain/delivery-policy.js';

export type LeaveRequestStatus = 'pending_approval' | 'partially_pending' | 'accepted' | 'rejected' | 'cancelled';
export type LeaveAction = 'create' | 'amend' | 'cancel';
export type EffectiveDeliveryStatus = 'scheduled' | 'skipped_by_customer';

export type LeaveOccurrenceClassification = Readonly<{
  subscriptionId: string;
  deliverySlotId: string;
  serviceDate: string;
  cutoffAt: Date;
  timing: 'on_time' | 'late';
  proposedBehavior: 'accept' | 'pending_approval' | 'reject';
}>;

export type LeaveOccurrencePlan = Readonly<{
  subscriptionId: string;
  deliverySlotId: string;
  weekdays: readonly number[];
  effectiveFrom?: string;
  effectiveTo?: string;
}>;

export type LeaveOccurrenceCursor = Readonly<{
  serviceDate: string;
  subscriptionId: string;
  deliverySlotId: string;
}>;

export function validateLeaveRange(startDate: string, endDate: string, today: string) {
  const start = parseDate(startDate, 'INVALID_LEAVE_DATE');
  const end = parseDate(endDate, 'INVALID_LEAVE_DATE');
  const current = parseDate(today, 'INVALID_LEAVE_DATE');
  if (start > end) throw error('INVALID_LEAVE_RANGE', 'Leave start date must not be after end date');
  if (start <= current) throw error('LEAVE_IN_PAST', 'Leave dates must be after the current service date');
  return { startDate, endDate } as const;
}

export function countWeekdayOccurrences(startDate: string, endDate: string, weekday: number): number {
  const start = parseDate(startDate, 'INVALID_LEAVE_DATE');
  const end = parseDate(endDate, 'INVALID_LEAVE_DATE');
  if (start > end) throw error('INVALID_LEAVE_RANGE', 'Leave start date must not be after end date');
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw error('INVALID_WEEKDAY', 'Weekday must be between 1 and 7');
  const offset = (weekday - start.weekday + 7) % 7;
  const first = start.plus({ days: offset });
  return first > end ? 0 : Math.floor(end.diff(first, 'days').days / 7) + 1;
}

/** Derives only the requested cursor page from compact weekday plans. */
export function deriveLeaveOccurrences(input: Readonly<{
  startDate: string;
  endDate: string;
  subscriptions: readonly LeaveOccurrencePlan[];
  limit?: number;
  cursor?: LeaveOccurrenceCursor;
}>): Readonly<{ items: readonly LeaveOccurrenceCursor[]; nextCursor?: LeaveOccurrenceCursor }> {
  const start = parseDate(input.startDate, 'INVALID_LEAVE_DATE');
  const end = parseDate(input.endDate, 'INVALID_LEAVE_DATE');
  if (start > end) throw error('INVALID_LEAVE_RANGE', 'Leave start date must not be after end date');
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error('INVALID_PAGINATION', 'Limit must be between 1 and 100');
  const after = input.cursor && toOccurrence(input.cursor);
  const floor = after ? DateTime.max(start, toDate(after.serviceDate)) : start;
  const candidates = input.subscriptions.map((plan) => {
    const occurrence = nextOccurrence(plan, floor, end, after);
    return occurrence ? { plan, occurrence } : undefined;
  }).filter(isPresent);
  const rows: LeaveOccurrenceCursor[] = [];
  while (candidates.length > 0 && rows.length <= limit) {
    candidates.sort((left, right) => compareOccurrence(left.occurrence, right.occurrence));
    const candidate = candidates.shift();
    if (!candidate) break;
    const { occurrence, plan } = candidate;
    rows.push(occurrence);
    const next = nextOccurrence(plan, toDate(occurrence.serviceDate).plus({ days: 1 }), end, after);
    if (next) candidates.push({ plan, occurrence: next });
  }
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, ...(rows.length > limit && last ? { nextCursor: last } : {}) };
}

export function classifyLeaveOccurrence(input: Readonly<{
  timezone: string;
  serviceDate: string;
  slotStartLocalTime: string;
  skipCutoffMinutes: number;
  lateLeavePolicy: LateLeavePolicy;
  now: Date;
}>): Pick<LeaveOccurrenceClassification, 'cutoffAt' | 'timing' | 'proposedBehavior'> {
  if (!Number.isInteger(input.skipCutoffMinutes) || input.skipCutoffMinutes < 0)
    throw error('INVALID_SKIP_CUTOFF', 'Skip cutoff minutes must be a non-negative integer');
  if (Number.isNaN(input.now.getTime())) throw error('INVALID_CURRENT_TIME', 'Current time is invalid');
  const cutoffAt = new Date(resolveServiceInstant(input.timezone, input.serviceDate, input.slotStartLocalTime).getTime() - input.skipCutoffMinutes * 60_000);
  const timing = input.now <= cutoffAt ? 'on_time' : 'late';
  return {
    cutoffAt,
    timing,
    proposedBehavior: timing === 'on_time' ? 'accept' : input.lateLeavePolicy === 'approval' ? 'pending_approval' : 'reject',
  };
}

export function requestedEffectiveStatus(action: LeaveAction): EffectiveDeliveryStatus {
  return action === 'create' ? 'skipped_by_customer' : 'scheduled';
}

export function deriveLeaveStatus(input: Readonly<{ effective: number; pending: number; cancelled?: boolean }>): LeaveRequestStatus {
  if (input.cancelled) return 'cancelled';
  if (input.pending > 0) return input.effective > 0 ? 'partially_pending' : 'pending_approval';
  return input.effective > 0 ? 'accepted' : 'rejected';
}

function nextOccurrence(plan: LeaveOccurrencePlan, floor: DateTime, end: DateTime, after?: LeaveOccurrenceCursor): LeaveOccurrenceCursor | undefined {
  const from = DateTime.max(floor, plan.effectiveFrom ? toDate(plan.effectiveFrom) : floor);
  const until = DateTime.min(end, plan.effectiveTo ? toDate(plan.effectiveTo).minus({ days: 1 }) : end);
  if (from > until) return undefined;
  const weekdays = [...new Set(plan.weekdays)].sort((left, right) => left - right);
  if (weekdays.length === 0) throw error('INVALID_WEEKDAY', 'At least one weekday is required');
  if (weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)) throw error('INVALID_WEEKDAY', 'Weekday must be between 1 and 7');
  for (let date = from; date <= until; date = date.plus({ days: 1 })) {
    if (!weekdays.includes(date.weekday)) continue;
    const occurrence = { serviceDate: date.toISODate()!, subscriptionId: plan.subscriptionId, deliverySlotId: plan.deliverySlotId };
    if (!after || compareOccurrence(occurrence, after) > 0) return occurrence;
  }
  return undefined;
}

function parseDate(value: string, code: string): DateTime {
  const date = DateTime.fromISO(value, { zone: 'UTC' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !date.isValid || date.toISODate() !== value)
    throw error(code, 'Leave date must be a valid calendar date');
  return date.startOf('day');
}

function toDate(value: string) { return parseDate(value, 'INVALID_LEAVE_DATE'); }
function toOccurrence(value: LeaveOccurrenceCursor) { return { ...value, serviceDate: toDate(value.serviceDate).toISODate()! }; }
function compareOccurrence(left: LeaveOccurrenceCursor, right: LeaveOccurrenceCursor) {
  return left.serviceDate.localeCompare(right.serviceDate)
    || left.subscriptionId.localeCompare(right.subscriptionId)
    || left.deliverySlotId.localeCompare(right.deliverySlotId);
}
function isPresent<T>(value: T | undefined): value is T { return value !== undefined; }
function error(code: string, message: string) { return new ApplicationError(code, message, 400); }
