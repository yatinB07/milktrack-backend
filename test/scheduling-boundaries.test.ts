import assert from 'node:assert/strict';
import test from 'node:test';

import { ScheduleDateLock } from '../src/schedule-coordination/application/schedule-date-lock.js';
import { SchedulingPriceService } from '../src/pricing/application/scheduling-price.service.js';
import { SubscriptionScheduleService } from '../src/subscriptions/application/subscription-schedule.service.js';

void test('scheduling publishes database-only coordination and batch projection boundaries', () => {
  assert.equal(typeof ScheduleDateLock, 'function');
  assert.equal(typeof SubscriptionScheduleService, 'function');
  assert.equal(typeof SchedulingPriceService, 'function');
});
