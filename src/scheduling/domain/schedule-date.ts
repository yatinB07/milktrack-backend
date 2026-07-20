import { DateTime } from 'luxon';
import { ApplicationError } from '../../common/errors/application.error.js';

export const validateScheduleDate = (value: string): string => {
  const parsed = DateTime.fromFormat(value, 'yyyy-MM-dd', { zone: 'utc', locale: 'en' });
  if (!parsed.isValid || parsed.toFormat('yyyy-MM-dd') !== value) {
    throw new ApplicationError('INVALID_SCHEDULE_DATE', 'Schedule date must be a valid ISO calendar date', 400);
  }
  return value;
};
