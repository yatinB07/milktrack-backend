import assert from 'node:assert/strict';
import test from 'node:test';

import { validate } from 'class-validator';

import {
  recordLifecycleOf,
  recordLifecycles,
} from '../src/common/application/record-lifecycle.js';
import { LifecycleQueryDto } from '../src/common/http/record-lifecycle.dto.js';

void test('record lifecycle exposes the frozen values and projection', () => {
  assert.deepEqual(recordLifecycles, ['current', 'deleted']);
  assert.equal(recordLifecycleOf(null), 'current');
  assert.equal(recordLifecycleOf(undefined), 'current');
  assert.equal(
    recordLifecycleOf(new Date('2030-01-01T00:00:00Z')),
    'deleted',
  );
});

void test('lifecycle query accepts only omitted, current, or deleted', async () => {
  for (const lifecycle of [undefined, 'current', 'deleted']) {
    const query = Object.assign(new LifecycleQueryDto(), { lifecycle });
    assert.equal((await validate(query)).length, 0);
  }

  for (const lifecycle of ['all', '', true]) {
    const query = Object.assign(new LifecycleQueryDto(), { lifecycle });
    const errors = await validate(query);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.property, 'lifecycle');
  }
});
