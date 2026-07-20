import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveServiceInstant } from '../src/pricing/domain/service-time.js';

function rejectsWithCode(work: () => unknown, code: string) {
  assert.throws(work, (cause: unknown) => {
    assert(cause && typeof cause === 'object' && 'code' in cause);
    assert.equal(cause.code, code);
    return true;
  });
}

void test('service time uses the vendor zone and can roll into the previous UTC date', () => {
  assert.equal(
    resolveServiceInstant('Asia/Kolkata', '2026-07-20', '00:15').toISOString(),
    '2026-07-19T18:45:00.000Z',
  );
});

void test('service time rejects invalid calendar dates and DST gaps', () => {
  rejectsWithCode(() => resolveServiceInstant('Asia/Kolkata', '2026-02-30', '06:00'), 'INVALID_SERVICE_DATE');
  rejectsWithCode(() => resolveServiceInstant('America/New_York', '2026-03-08', '02:30'), 'INVALID_SERVICE_TIME');
});

void test('service time chooses the earlier UTC instant during a fall-back ambiguity', () => {
  assert.equal(
    resolveServiceInstant('America/New_York', '2026-11-01', '01:30').toISOString(),
    '2026-11-01T05:30:00.000Z',
  );
});

void test('service time rejects malformed local time and unknown IANA zones', () => {
  rejectsWithCode(() => resolveServiceInstant('Asia/Kolkata', '2026-07-20', '6:00'), 'INVALID_SERVICE_TIME');
  rejectsWithCode(() => resolveServiceInstant('Not/A_Zone', '2026-07-20', '06:00'), 'INVALID_SERVICE_TIME');
});
