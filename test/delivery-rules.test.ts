import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/common/errors/application.error.js';
import {
  requireAgentOutcomeQuantity,
  requireAgentOutcomeTransition,
  requireCorrectionReason,
  requireCorrectionTransition,
} from '../src/delivery/domain/delivery-rules.js';

void test('agent cannot replace an existing final outcome', () => {
  for (const current of [
    'delivered',
    'skipped_by_customer',
    'skipped_by_agent',
    'missed',
  ] as const) {
    assert.throws(
      () => requireAgentOutcomeTransition(current, 'delivered'),
      (error: unknown) => error instanceof ApplicationError
        && error.code === 'DELIVERY_ALREADY_FINALIZED',
    );
  }
});

void test('only delivered replacements accept positive quantity', () => {
  assert.doesNotThrow(() => requireCorrectionTransition('missed', 'delivered', '1.25'));
  assert.throws(() => requireCorrectionTransition('missed', 'delivered', '0'));
  assert.throws(() => requireCorrectionTransition('delivered', 'missed', '1'));
});

void test('agent skip and missed outcomes reject supplied quantity', () => {
  for (const outcome of ['skipped_by_agent', 'missed'] as const) {
    assert.throws(
      () => requireAgentOutcomeQuantity(outcome, '1'),
      (error: unknown) => error instanceof ApplicationError
        && error.code === 'INVALID_DELIVERY_QUANTITY',
    );
  }
});

void test('correction rationale is trimmed and bounded', () => {
  assert.doesNotThrow(() => requireCorrectionReason('Corrected after vendor review'));
  for (const reason of ['x', ' padded ', 'x'.repeat(501)]) {
    assert.throws(
      () => requireCorrectionReason(reason),
      (error: unknown) => error instanceof ApplicationError
        && error.code === 'INVALID_CORRECTION_REASON',
    );
  }
});
