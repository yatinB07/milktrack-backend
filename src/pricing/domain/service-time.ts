import { DateTime, IANAZone } from 'luxon';
import { ApplicationError } from '../../common/errors/application.error.js';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function resolveServiceInstant(timezone: string, serviceDate: string, localTime: string): Date {
  const date = DateTime.fromISO(serviceDate, { zone: 'UTC' });
  if (!datePattern.test(serviceDate) || !date.isValid || date.toISODate() !== serviceDate)
    throw new ApplicationError('INVALID_SERVICE_DATE', 'Service date must be a valid calendar date', 400);
  if (!timePattern.test(localTime) || !IANAZone.isValidZone(timezone))
    throw new ApplicationError('INVALID_SERVICE_TIME', 'Service time or vendor timezone is invalid', 400);

  const local = DateTime.fromISO(`${serviceDate}T${localTime}`, { zone: timezone });
  // Luxon normalizes nonexistent wall times across DST gaps, so require an exact local round trip.
  if (!local.isValid || local.toFormat("yyyy-MM-dd'T'HH:mm") !== `${serviceDate}T${localTime}`)
    throw new ApplicationError('INVALID_SERVICE_TIME', 'Service time does not exist in the vendor timezone', 400);
  const instant = local.getPossibleOffsets().reduce((earliest, candidate) =>
    candidate.toMillis() < earliest.toMillis() ? candidate : earliest,
  );
  return instant.toUTC().toJSDate();
}
