import { DateTime } from 'luxon';

export const scheduleHorizon = (today: string): string[] => {
  const start = DateTime.fromISO(today, { zone: 'utc' });
  return Array.from({ length: 7 }, (_, offset) => start.plus({ days: offset }).toISODate()!);
};

export const affectedScheduleDates = (
  today: string,
  effectiveFrom: string,
  effectiveTo?: string,
  weekdays?: readonly number[],
): string[] => scheduleHorizon(today).filter((serviceDate) => {
  if (serviceDate < effectiveFrom || (effectiveTo && serviceDate >= effectiveTo)) return false;
  if (!weekdays) return true;
  return weekdays.includes(DateTime.fromISO(serviceDate, { zone: 'utc' }).weekday);
});
