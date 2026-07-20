import { DateTime } from 'luxon';

import { ApplicationError } from '../../common/errors/application.error.js';

const error = (code: string, message: string) => new ApplicationError(code, message, 400);
const date = (value: string) => {
  const parsed = DateTime.fromFormat(value, 'yyyy-MM-dd', { zone: 'utc', locale: 'en' });
  if (!parsed.isValid || parsed.toFormat('yyyy-MM-dd') !== value)
    throw error('INVALID_ROUTE_DATE', 'Route date must be a valid ISO calendar date');
  return parsed;
};

export function validateRouteStopDate(value: string) {
  date(value);
  return value;
}

export function normalizeRouteStopReplacement(
  effectiveDate: string,
  householdIds: readonly string[],
  reason: string,
  today: string,
) {
  const effective = date(effectiveDate);
  if (effective < date(today))
    throw error('INVALID_ROUTE_DATE', 'Route date cannot be in the past');
  if (new Set(householdIds).size !== householdIds.length)
    throw error('INVALID_STOP_ORDER', 'A household can appear only once in a route stop plan');
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 3 || normalizedReason.length > 500)
    throw error('INVALID_REASON', 'Reason must be between 3 and 500 characters');
  return { effectiveDate, householdIds: [...householdIds], reason: normalizedReason };
}

export function publicRouteStopPeriod(effectiveFrom: string, effectiveTo?: string) {
  return {
    startDate: effectiveFrom,
    ...(effectiveTo ? { endDate: date(effectiveTo).minus({ days: 1 }).toISODate() ?? effectiveTo } : {}),
  };
}
