import { DateTime } from 'luxon';
import { ApplicationError } from '../../common/errors/application.error.js';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const quantityPattern = /^\d+(?:\.\d{1,3})?$/;

export type SubscriptionOperationalStatus = 'active' | 'paused' | 'cancelled';
export type SubscriptionPublicStatus = 'future' | SubscriptionOperationalStatus | 'completed';

export interface SubscriptionPlanPeriod {
  readonly status: SubscriptionOperationalStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
}

function invalid(code: string, message: string): never {
  throw new ApplicationError(code, message, 400);
}

function calendarDate(value: string): DateTime {
  const parsed = DateTime.fromISO(value, { zone: 'UTC' });
  if (!datePattern.test(value) || !parsed.isValid || parsed.toISODate() !== value)
    invalid('INVALID_SUBSCRIPTION_DATE', 'Subscription date must be a valid YYYY-MM-DD calendar date');
  return parsed;
}

export function parseSubscriptionQuantity(value: string, unitDecimalScale: number): string {
  if (typeof value !== 'string' || !Number.isInteger(unitDecimalScale) || unitDecimalScale < 0 || unitDecimalScale > 3 || !quantityPattern.test(value))
    invalid('INVALID_SUBSCRIPTION_QUANTITY', 'Subscription quantity is invalid');
  const [rawInteger = '', rawFraction = ''] = value.split('.');
  const integer = rawInteger.replace(/^0+(?=\d)/, '');
  if (integer.length > 15 || rawFraction.length > unitDecimalScale || !/[1-9]/.test(`${integer}${rawFraction}`))
    invalid('INVALID_SUBSCRIPTION_QUANTITY', 'Subscription quantity is invalid');
  const fraction = rawFraction.replace(/0+$/, '');
  return fraction.length > 0 ? `${integer}.${fraction}` : integer;
}

export function parseSubscriptionPeriod(startDate: string, endDate?: string): Readonly<{
  effectiveFrom: string;
  effectiveTo?: string;
}> {
  const from = calendarDate(startDate);
  if (endDate === undefined) return { effectiveFrom: startDate };
  const inclusiveTo = calendarDate(endDate);
  if (inclusiveTo < from) invalid('INVALID_SUBSCRIPTION_DATE', 'Subscription end date precedes its start date');
  const effectiveTo = inclusiveTo.plus({ days: 1 }).toISODate();
  if (!effectiveTo || !datePattern.test(effectiveTo))
    invalid('INVALID_SUBSCRIPTION_DATE', 'Subscription end date exceeds the supported calendar range');
  return { effectiveFrom: startDate, effectiveTo };
}

export function normalizeSubscriptionWeekdays(values: readonly number[]): readonly number[] {
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value < 1 || value > 7))
    invalid('INVALID_SUBSCRIPTION_WEEKDAYS', 'Subscription weekdays must contain ISO weekday values 1 through 7');
  const weekdays = [...values].sort((left, right) => left - right);
  if (weekdays.some((value, index) => index > 0 && value === weekdays[index - 1]))
    invalid('INVALID_SUBSCRIPTION_WEEKDAYS', 'Subscription weekdays must be unique');
  return weekdays;
}

export function periodContainsServiceDay(
  effectiveFrom: string,
  effectiveTo: string | undefined,
  weekdays: readonly number[],
): boolean {
  const from = calendarDate(effectiveFrom);
  const selected = new Set(normalizeSubscriptionWeekdays(weekdays));
  if (effectiveTo === undefined) return true;
  const to = calendarDate(effectiveTo);
  if (to <= from) invalid('INVALID_SUBSCRIPTION_DATE', 'Subscription period is empty');
  for (let date = from; date < to && date.diff(from, 'days').days < 7; date = date.plus({ days: 1 }))
    if (selected.has(date.weekday)) return true;
  return false;
}

export function deriveSubscriptionStatus(
  plan: readonly SubscriptionPlanPeriod[],
  today: string,
): SubscriptionPublicStatus {
  calendarDate(today);
  const ordered = [...plan].sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
  const applicable = ordered.find(({ effectiveFrom, effectiveTo }) =>
    effectiveFrom <= today && (effectiveTo === undefined || today < effectiveTo),
  );
  if (applicable) return applicable.status;
  return ordered.some(({ effectiveFrom }) => effectiveFrom > today) ? 'future' : 'completed';
}
