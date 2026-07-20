import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRouteAssignmentMutation } from '../src/routing/domain/route-assignment-rules.js';

void test('assignment mutations use strict non-past vendor-local dates and normalized reasons', () => {
  assert.deepEqual(normalizeRouteAssignmentMutation('2026-07-20', '  Cover route  ', '2026-07-20'), {
    serviceDate: '2026-07-20', reason: 'Cover route',
  });
  for (const value of ['2026-02-30', '20-07-2026', '2026-07-19'])
    assert.throws(() => normalizeRouteAssignmentMutation(value, 'Valid reason', '2026-07-20'), { code: 'INVALID_ROUTE_DATE' });
  assert.throws(() => normalizeRouteAssignmentMutation('2026-07-20', 'x', '2026-07-20'), { code: 'INVALID_REASON' });
});
