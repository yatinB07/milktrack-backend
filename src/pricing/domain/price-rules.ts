import { DateTime } from 'luxon';
import { ApplicationError } from '../../common/errors/application.error.js';

const maxBigInt = 9223372036854775807n;
const amountPattern = /^(?:0|[1-9]\d*)$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseAmountMinor(value: string): bigint {
  if (typeof value !== 'string' || !amountPattern.test(value))
    throw new ApplicationError('INVALID_AMOUNT_MINOR', 'Amount must be a non-negative decimal integer string', 400);
  const amount = BigInt(value);
  if (amount > maxBigInt)
    throw new ApplicationError('INVALID_AMOUNT_MINOR', 'Amount exceeds the supported signed bigint range', 400);
  return amount;
}

function instant(value: string): Date | undefined {
  if (!instantPattern.test(value)) return undefined;
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed.toUTC().toJSDate() : undefined;
}

export function parseEffectivePeriod(effectiveFrom: string, effectiveTo?: string): Readonly<{
  effectiveFrom: Date; effectiveTo?: Date;
}> {
  const from = instant(effectiveFrom); const to = effectiveTo === undefined ? undefined : instant(effectiveTo);
  if (!from || (effectiveTo !== undefined && !to) || (to && to <= from))
    throw new ApplicationError('INVALID_EFFECTIVE_PERIOD', 'Effective period is invalid', 400);
  return { effectiveFrom: from, ...(to ? { effectiveTo: to } : {}) };
}

export function isEffectiveAt(effectiveFrom: Date, effectiveTo: Date | undefined, at: Date): boolean {
  return effectiveFrom <= at && (effectiveTo === undefined || at < effectiveTo);
}
