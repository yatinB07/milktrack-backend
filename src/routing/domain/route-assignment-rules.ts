import { DateTime } from 'luxon';

import { ApplicationError } from '../../common/errors/application.error.js';

const invalid = (code: string, message: string) => new ApplicationError(code, message, 400);

export function normalizeRouteAssignmentMutation(serviceDate: string, reason: string, today: string) {
  const parsed = DateTime.fromFormat(serviceDate, 'yyyy-MM-dd', { zone: 'utc', locale: 'en' });
  const current = DateTime.fromFormat(today, 'yyyy-MM-dd', { zone: 'utc', locale: 'en' });
  if (!parsed.isValid || parsed.toFormat('yyyy-MM-dd') !== serviceDate || parsed < current)
    throw invalid('INVALID_ROUTE_DATE', 'Route assignment date must be a valid non-past ISO calendar date');
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 3 || normalizedReason.length > 500)
    throw invalid('INVALID_REASON', 'Reason must be between 3 and 500 characters');
  return { serviceDate, reason: normalizedReason };
}

export function validateRouteAssignmentDate(serviceDate: string) {
  const parsed = DateTime.fromFormat(serviceDate, 'yyyy-MM-dd', { zone: 'utc', locale: 'en' });
  if (!parsed.isValid || parsed.toFormat('yyyy-MM-dd') !== serviceDate)
    throw invalid('INVALID_ROUTE_DATE', 'Route assignment date must be a valid ISO calendar date');
  return serviceDate;
}
