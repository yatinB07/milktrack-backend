import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRouteStopReplacement, publicRouteStopPeriod } from '../src/routing/domain/route-stop-rules.js';

void test('route stop replacement preserves explicit order and canonical dates and reason', () => {
  assert.deepEqual(normalizeRouteStopReplacement('2026-07-20', ['a', 'b'], '  Reorder route  ', '2026-07-20'), {
    effectiveDate: '2026-07-20', householdIds: ['a', 'b'], reason: 'Reorder route',
  });
  assert.deepEqual(publicRouteStopPeriod('2026-07-20', '2026-08-01'), { startDate: '2026-07-20', endDate: '2026-07-31' });
  assert.deepEqual(publicRouteStopPeriod('2026-07-20'), { startDate: '2026-07-20' });
});

void test('route stop replacement rejects invalid or past dates, duplicate households, and invalid reasons', () => {
  for (const value of ['2026-02-30', '20-07-2026'])
    assert.throws(() => normalizeRouteStopReplacement(value, [], 'Valid reason', '2026-07-20'), { code: 'INVALID_ROUTE_DATE' });
  assert.throws(() => normalizeRouteStopReplacement('2026-07-19', [], 'Valid reason', '2026-07-20'), { code: 'INVALID_ROUTE_DATE' });
  assert.throws(() => normalizeRouteStopReplacement('2026-07-20', ['a', 'a'], 'Valid reason', '2026-07-20'), { code: 'INVALID_STOP_ORDER' });
  assert.throws(() => normalizeRouteStopReplacement(
    '2026-07-20',
    ['550e8400-e29b-41d4-a716-446655440000', '550E8400-E29B-41D4-A716-446655440000'],
    'Valid reason',
    '2026-07-20',
  ), { code: 'INVALID_STOP_ORDER' });
  assert.throws(() => normalizeRouteStopReplacement('2026-07-20', [], 'x', '2026-07-20'), { code: 'INVALID_REASON' });
});
