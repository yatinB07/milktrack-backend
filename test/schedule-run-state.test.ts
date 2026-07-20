import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeScheduleRunFailure,
  planScheduleRunFailure,
} from '../src/scheduling/domain/schedule-run-state.js';

void test('retryable failures use bounded persisted backoff until attempts are exhausted', () => {
  const failedAt = new Date('2030-01-01T00:00:00.000Z');

  assert.deepEqual(planScheduleRunFailure(1, 5, true, failedAt), {
    status: 'retry_wait',
    availableAt: new Date('2030-01-01T00:00:05.000Z'),
  });
  assert.deepEqual(planScheduleRunFailure(4, 5, true, failedAt), {
    status: 'retry_wait',
    availableAt: new Date('2030-01-01T00:00:40.000Z'),
  });
  assert.deepEqual(planScheduleRunFailure(5, 5, true, failedAt), {
    status: 'failed',
    finishedAt: failedAt,
  });
  assert.deepEqual(planScheduleRunFailure(1, 5, false, failedAt), {
    status: 'failed',
    finishedAt: failedAt,
  });
});

void test('failure details are trimmed, capped, and never empty', () => {
  assert.deepEqual(normalizeScheduleRunFailure('  ', '  '), {
    code: 'SCHEDULE_GENERATION_FAILED',
    message: 'Schedule generation failed',
  });
  assert.deepEqual(normalizeScheduleRunFailure(`  ${'C'.repeat(140)}  `, `  ${'M'.repeat(520)}  `), {
    code: 'C'.repeat(128),
    message: 'M'.repeat(500),
  });
});
