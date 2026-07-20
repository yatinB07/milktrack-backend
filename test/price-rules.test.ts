import assert from 'node:assert/strict';
import test from 'node:test';

import { isEffectiveAt, parseAmountMinor, parseEffectivePeriod } from '../src/pricing/domain/price-rules.js';

function rejectsWithCode(work: () => unknown, code: string) {
  assert.throws(work, (cause: unknown) => {
    assert(cause && typeof cause === 'object' && 'code' in cause);
    assert.equal(cause.code, code);
    return true;
  });
}

void test('amount minor accepts only non-negative signed-bigint decimal strings', () => {
  assert.equal(parseAmountMinor('0'), 0n);
  assert.equal(parseAmountMinor('9223372036854775807'), 9223372036854775807n);
  for (const value of ['', '-1', '+1', '01', '1.0', ' 1 ', '9223372036854775808'])
    rejectsWithCode(() => parseAmountMinor(value), 'INVALID_AMOUNT_MINOR');
  for (const value of [1, 1n])
    rejectsWithCode(() => parseAmountMinor(value as never), 'INVALID_AMOUNT_MINOR');
});

void test('effective periods require offset-bearing RFC3339 instants and increasing bounds', () => {
  assert.deepEqual(parseEffectivePeriod('2026-07-20T06:00:00+05:30', '2026-08-01T00:00:00Z'), {
    effectiveFrom: new Date('2026-07-20T00:30:00.000Z'),
    effectiveTo: new Date('2026-08-01T00:00:00.000Z'),
  });
  assert.deepEqual(parseEffectivePeriod('2026-07-20T00:00:00Z'), {
    effectiveFrom: new Date('2026-07-20T00:00:00.000Z'),
  });
  for (const [from, to] of [
    ['2026-07-20', undefined],
    ['2026-07-20T00:00:00', undefined],
    ['2026-02-30T00:00:00Z', undefined],
    ['2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z'],
    ['2026-07-20T00:00:00Z', '2026-07-19T23:59:59Z'],
  ] as const) rejectsWithCode(() => parseEffectivePeriod(from, to), 'INVALID_EFFECTIVE_PERIOD');
});

void test('effective periods use inclusive starts and exclusive ends', () => {
  const from = new Date('2026-07-20T00:00:00Z'); const to = new Date('2026-08-01T00:00:00Z');
  assert.equal(isEffectiveAt(from, to, new Date('2026-07-20T00:00:00Z')), true);
  assert.equal(isEffectiveAt(from, to, new Date('2026-08-01T00:00:00Z')), false);
  assert.equal(isEffectiveAt(from, undefined, new Date('2126-01-01T00:00:00Z')), true);
});
