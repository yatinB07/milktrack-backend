import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveSubscriptionStatus,
  normalizeSubscriptionWeekdays,
  parseSubscriptionPeriod,
  parseSubscriptionQuantity,
  periodContainsServiceDay,
} from '../src/subscriptions/domain/subscription-rules.js';

function rejectsWithCode(work: () => unknown, code: string) {
  assert.throws(work, (cause: unknown) => {
    assert(cause && typeof cause === 'object' && 'code' in cause);
    assert.equal(cause.code, code);
    return true;
  });
}

void test('subscription quantities are canonical strings constrained by NUMERIC(18,3) and unit scale', () => {
  assert.equal(parseSubscriptionQuantity('00012.300', 3), '12.3');
  assert.equal(parseSubscriptionQuantity('0.250', 3), '0.25');
  assert.equal(parseSubscriptionQuantity('15', 0), '15');
  assert.equal(parseSubscriptionQuantity('999999999999999.999', 3), '999999999999999.999');
  for (const [quantity, scale] of [
    ['', 3], ['0', 3], ['0.000', 3], ['-1', 3], ['+1', 3], ['1e2', 3], [' 1 ', 3],
    ['1.2345', 3], ['1.1', 0], ['1000000000000000', 3], ['1', -1], ['1', 4],
  ] as const) rejectsWithCode(() => parseSubscriptionQuantity(quantity, scale), 'INVALID_SUBSCRIPTION_QUANTITY');
  rejectsWithCode(() => parseSubscriptionQuantity(1 as never, 3), 'INVALID_SUBSCRIPTION_QUANTITY');
});

void test('subscription periods accept strict calendar dates and convert inclusive end to exclusive storage', () => {
  assert.deepEqual(parseSubscriptionPeriod('2026-07-20', '2026-07-31'), {
    effectiveFrom: '2026-07-20', effectiveTo: '2026-08-01',
  });
  assert.deepEqual(parseSubscriptionPeriod('2026-12-31'), { effectiveFrom: '2026-12-31' });
  assert.deepEqual(parseSubscriptionPeriod('2028-02-29', '2028-02-29'), {
    effectiveFrom: '2028-02-29', effectiveTo: '2028-03-01',
  });
  for (const [from, to] of [
    ['2026-2-01', undefined], ['2026-02-30', undefined], ['2026-07-20T00:00:00Z', undefined],
    ['2026-07-20', '2026-07-19'], ['2026-07-20', 'not-a-date'],
    ['9999-12-31', '9999-12-31'],
  ] as const) rejectsWithCode(() => parseSubscriptionPeriod(from, to), 'INVALID_SUBSCRIPTION_DATE');
});

void test('subscription weekdays are non-empty unique sorted ISO values and finite periods contain service', () => {
  assert.deepEqual(normalizeSubscriptionWeekdays([7, 1, 4]), [1, 4, 7]);
  for (const weekdays of [[], [1, 1], [0], [8], [1.5]])
    rejectsWithCode(() => normalizeSubscriptionWeekdays(weekdays), 'INVALID_SUBSCRIPTION_WEEKDAYS');
  assert.equal(periodContainsServiceDay('2026-07-20', '2026-07-21', [1]), true);
  assert.equal(periodContainsServiceDay('2026-07-20', '2026-07-21', [2]), false);
  assert.equal(periodContainsServiceDay('2026-07-20', undefined, [7]), true);
  for (const weekdays of [[], [0], [1, 1]])
    rejectsWithCode(() => periodContainsServiceDay('2026-07-20', undefined, weekdays), 'INVALID_SUBSCRIPTION_WEEKDAYS');
});

void test('public status is derived from the unsuperseded plan without a timer', () => {
  const revision = (status: 'active' | 'paused' | 'cancelled', from: string, to?: string) => ({
    status, effectiveFrom: from, ...(to ? { effectiveTo: to } : {}),
  });
  assert.equal(deriveSubscriptionStatus([], '2026-07-20'), 'completed');
  assert.equal(deriveSubscriptionStatus([revision('active', '2026-08-01')], '2026-07-20'), 'future');
  assert.equal(deriveSubscriptionStatus([revision('active', '2026-07-01')], '2026-07-20'), 'active');
  assert.equal(deriveSubscriptionStatus([revision('paused', '2026-07-20')], '2026-07-20'), 'paused');
  assert.equal(deriveSubscriptionStatus([revision('cancelled', '2026-07-20')], '2026-07-20'), 'cancelled');
  assert.equal(deriveSubscriptionStatus([revision('active', '2026-07-01', '2026-07-20')], '2026-07-20'), 'completed');
  assert.equal(deriveSubscriptionStatus([
    revision('active', '2026-07-01', '2026-07-10'), revision('paused', '2026-08-01'),
  ], '2026-07-20'), 'future');
});
