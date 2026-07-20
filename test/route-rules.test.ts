import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRouteCode, normalizeRouteName, normalizeRouteReason } from '../src/routing/domain/route-rules.js';

void test('route fields normalize to their approved canonical values', () => {
  assert.equal(normalizeRouteCode(' am-route_1 '), 'AM-ROUTE_1');
  assert.equal(normalizeRouteName(' Morning Route '), 'Morning Route');
  assert.equal(normalizeRouteReason('  Seasonal closure  '), 'Seasonal closure');
});

void test('route fields reject invalid codes, names, and lifecycle reasons', () => {
  for (const code of ['A', 'bad code', 'abcdefghijklmnopqrstuvwxyz1234567'])
    assert.throws(() => normalizeRouteCode(code), (cause: unknown) => hasCode(cause, 'INVALID_ROUTE_CODE'));
  for (const name of ['', ' '.repeat(2), 'x'.repeat(101)])
    assert.throws(() => normalizeRouteName(name), (cause: unknown) => hasCode(cause, 'INVALID_ROUTE_NAME'));
  for (const reason of ['', ' x ', 'x'.repeat(501)])
    assert.throws(() => normalizeRouteReason(reason), (cause: unknown) => hasCode(cause, 'INVALID_REASON'));
});

const hasCode = (cause: unknown, code: string) => typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === code;
