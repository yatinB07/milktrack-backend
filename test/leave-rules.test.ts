import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyLeaveOccurrence,
  countWeekdayOccurrences,
  deriveLeaveOccurrences,
  deriveLeaveOccurrenceTransitions,
  deriveLeaveStatus,
  requestedEffectiveStatus,
  validateLeaveRange,
} from '../src/leave/domain/leave-rules.js';

function rejectsWithCode(work: () => unknown, code: string) {
  assert.throws(work, (cause: unknown) => {
    assert(cause && typeof cause === 'object' && 'code' in cause);
    assert.equal(cause.code, code);
    return true;
  });
}

void test('leave ranges require valid future inclusive dates', () => {
  assert.deepEqual(validateLeaveRange('2030-01-01', '2030-01-01', '2029-12-31'), {
    startDate: '2030-01-01', endDate: '2030-01-01',
  });
  rejectsWithCode(() => validateLeaveRange('2030-02-30', '2030-03-01', '2030-01-01'), 'INVALID_LEAVE_DATE');
  rejectsWithCode(() => validateLeaveRange('2030-01-02', '2030-01-01', '2029-12-31'), 'INVALID_LEAVE_RANGE');
  rejectsWithCode(() => validateLeaveRange('2030-01-01', '2030-01-01', '2030-01-01'), 'LEAVE_IN_PAST');
});

void test('weekday counts and cursor pages retain compact inclusive ranges', () => {
  assert.equal(countWeekdayOccurrences('2030-01-01', '2030-01-07', 2), 1);
  assert.equal(countWeekdayOccurrences('2030-01-01', '2030-01-07', 7), 1);
  assert.equal(countWeekdayOccurrences('2030-01-01', '2030-01-14', 2), 2);
  const result = deriveLeaveOccurrences({
    startDate: '2030-01-01', endDate: '2030-01-31', limit: 2,
    subscriptions: [
      { subscriptionId: 'a', deliverySlotId: 'slot-a', weekdays: [2] },
      { subscriptionId: 'b', deliverySlotId: 'slot-b', weekdays: [3] },
    ],
  });
  assert.deepEqual(result.items.map(({ serviceDate, subscriptionId }) => [serviceDate, subscriptionId]), [
    ['2030-01-01', 'a'], ['2030-01-02', 'b'],
  ]);
  assert.deepEqual(result.nextCursor, { serviceDate: '2030-01-02', subscriptionId: 'b', deliverySlotId: 'slot-b' });
});

void test('cursor paging retains a later plan sharing a subscription and slot and includes same-date ties', () => {
  const first = deriveLeaveOccurrences({
    startDate: '1900-01-01', endDate: '2100-01-31', limit: 1,
    subscriptions: [
      { subscriptionId: 'a', deliverySlotId: 'slot', weekdays: [2], effectiveFrom: '2030-01-01', effectiveTo: '2030-01-08' },
      { subscriptionId: 'a', deliverySlotId: 'slot', weekdays: [2], effectiveFrom: '2030-01-08', effectiveTo: '2030-01-22' },
      { subscriptionId: 'b', deliverySlotId: 'slot', weekdays: [2], effectiveFrom: '2030-01-08', effectiveTo: '2030-01-09' },
    ],
  });
  assert.deepEqual(first.items, [{ serviceDate: '2030-01-01', subscriptionId: 'a', deliverySlotId: 'slot' }]);
  const second = deriveLeaveOccurrences({
    startDate: '1900-01-01', endDate: '2100-01-31', limit: 3, cursor: first.nextCursor,
    subscriptions: [
      { subscriptionId: 'a', deliverySlotId: 'slot', weekdays: [2], effectiveFrom: '2030-01-01', effectiveTo: '2030-01-08' },
      { subscriptionId: 'a', deliverySlotId: 'slot', weekdays: [2], effectiveFrom: '2030-01-08', effectiveTo: '2030-01-22' },
      { subscriptionId: 'b', deliverySlotId: 'slot', weekdays: [2], effectiveFrom: '2030-01-08', effectiveTo: '2030-01-09' },
    ],
  });
  assert.deepEqual(second.items, [
    { serviceDate: '2030-01-08', subscriptionId: 'a', deliverySlotId: 'slot' },
    { serviceDate: '2030-01-08', subscriptionId: 'b', deliverySlotId: 'slot' },
    { serviceDate: '2030-01-15', subscriptionId: 'a', deliverySlotId: 'slot' },
  ]);
});

void test('exact cutoff is on time and one millisecond later is late', () => {
  const input = {
    timezone: 'Asia/Kolkata', serviceDate: '2030-01-01', slotStartLocalTime: '06:00',
    skipCutoffMinutes: 60, lateLeavePolicy: 'approval' as const,
  };
  assert.equal(classifyLeaveOccurrence({ ...input, now: new Date('2029-12-31T23:30:00.000Z') }).timing, 'on_time');
  assert.equal(classifyLeaveOccurrence({ ...input, now: new Date('2029-12-31T23:30:00.001Z') }).timing, 'late');
});

void test('late policy either rejects or queues approval and preserves DST rules', () => {
  const input = {
    timezone: 'Asia/Kolkata', serviceDate: '2030-01-01', slotStartLocalTime: '06:00',
    skipCutoffMinutes: 60, now: new Date('2029-12-31T23:30:00.001Z'),
  };
  assert.equal(classifyLeaveOccurrence({ ...input, lateLeavePolicy: 'reject' }).proposedBehavior, 'reject');
  assert.equal(classifyLeaveOccurrence({ ...input, lateLeavePolicy: 'approval' }).proposedBehavior, 'pending_approval');
  rejectsWithCode(() => classifyLeaveOccurrence({
    ...input, timezone: 'America/New_York', serviceDate: '2030-03-10', slotStartLocalTime: '02:30',
    lateLeavePolicy: 'approval',
  }), 'INVALID_SERVICE_TIME');
});

void test('cutoffs choose the earliest instant during a DST overlap', () => {
  assert.equal(classifyLeaveOccurrence({
    timezone: 'America/New_York', serviceDate: '2030-11-03', slotStartLocalTime: '01:30',
    skipCutoffMinutes: 0, lateLeavePolicy: 'approval', now: new Date('2030-11-03T05:29:59.999Z'),
  }).cutoffAt.toISOString(), '2030-11-03T05:30:00.000Z');
});

void test('create and amendment request leave while cancellation reverses it', () => {
  assert.equal(requestedEffectiveStatus('create'), 'skipped_by_customer');
  assert.equal(requestedEffectiveStatus('amend'), 'skipped_by_customer');
  assert.equal(requestedEffectiveStatus('cancel'), 'scheduled');
});

void test('leave occurrence counts derive aggregate request status', () => {
  assert.equal(deriveLeaveStatus({ effective: 0, pending: 2 }), 'pending_approval');
  assert.equal(deriveLeaveStatus({ effective: 1, pending: 1 }), 'partially_pending');
  assert.equal(deriveLeaveStatus({ effective: 1, pending: 0 }), 'accepted');
  assert.equal(deriveLeaveStatus({ effective: 0, pending: 0 }), 'rejected');
  assert.equal(deriveLeaveStatus({ effective: 0, pending: 0, cancelled: true }), 'cancelled');
});

void test('leave transitions compare compact old and requested occurrence coverage', () => {
  const late = {
    cutoffAt: new Date('2030-01-01T05:00:00.000Z'), timing: 'late' as const, proposedBehavior: 'pending_approval' as const,
  };
  const onTime = {
    cutoffAt: new Date('2030-01-08T05:00:00.000Z'), timing: 'on_time' as const, proposedBehavior: 'accept' as const,
  };
  const unchanged = { subscriptionId: 'same', deliverySlotId: 'slot', serviceDate: '2030-01-08', ...onTime };
  const removed = { subscriptionId: 'removed', deliverySlotId: 'slot', serviceDate: '2030-01-01', ...late };
  const added = { subscriptionId: 'added', deliverySlotId: 'slot', serviceDate: '2030-01-01', ...late };

  assert.deepEqual(deriveLeaveOccurrenceTransitions([], [added]), [{
    subscriptionId: 'added', deliverySlotId: 'slot', serviceDate: '2030-01-01',
    cutoffAt: late.cutoffAt,
    previousEffectiveStatus: 'scheduled', requestedEffectiveStatus: 'skipped_by_customer',
    timing: 'late', proposedBehavior: 'pending_approval',
  }]);
  assert.deepEqual(deriveLeaveOccurrenceTransitions([removed, unchanged], [added, unchanged]), [
    {
      subscriptionId: 'added', deliverySlotId: 'slot', serviceDate: '2030-01-01',
      cutoffAt: late.cutoffAt,
      previousEffectiveStatus: 'scheduled', requestedEffectiveStatus: 'skipped_by_customer',
      timing: 'late', proposedBehavior: 'pending_approval',
    },
    {
      subscriptionId: 'removed', deliverySlotId: 'slot', serviceDate: '2030-01-01',
      cutoffAt: late.cutoffAt,
      previousEffectiveStatus: 'skipped_by_customer', requestedEffectiveStatus: 'scheduled',
      timing: 'late', proposedBehavior: 'pending_approval',
    },
  ]);
  assert.deepEqual(deriveLeaveOccurrenceTransitions([removed], []), [{
    subscriptionId: 'removed', deliverySlotId: 'slot', serviceDate: '2030-01-01',
    cutoffAt: late.cutoffAt,
    previousEffectiveStatus: 'skipped_by_customer', requestedEffectiveStatus: 'scheduled',
    timing: 'late', proposedBehavior: 'pending_approval',
  }]);
});
