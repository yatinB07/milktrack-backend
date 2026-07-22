import { ApplicationError } from '../../common/errors/application.error.js';

export const DELIVERY_CURRENT_STATUSES = [
  'scheduled',
  'cancelled',
  'delivered',
  'skipped_by_customer',
  'skipped_by_agent',
  'missed',
] as const;

export type DeliveryCurrentStatus = (typeof DELIVERY_CURRENT_STATUSES)[number];

export const AGENT_SKIP_REASONS = [
  'customer_on_leave',
  'customer_unavailable',
  'customer_requested_skip_at_door',
  'other',
] as const;

export type AgentSkipReason = (typeof AGENT_SKIP_REASONS)[number];

export const MISSED_REASONS = [
  'address_not_found',
  'access_blocked',
  'product_unavailable',
  'vehicle_or_route_issue',
  'safety_issue',
  'other',
] as const;

export type MissedReason = (typeof MISSED_REASONS)[number];

export type AgentOutcomeStatus = 'delivered' | 'skipped_by_agent' | 'missed';
export type CorrectionStatus = AgentOutcomeStatus;

const final = new Set<DeliveryCurrentStatus>([
  'delivered',
  'skipped_by_customer',
  'skipped_by_agent',
  'missed',
]);

export function requireAgentOutcomeTransition(
  current: DeliveryCurrentStatus,
  replacement: AgentOutcomeStatus,
): void {
  void replacement;
  if (current === 'scheduled') return;
  if (final.has(current)) {
    throw new ApplicationError('DELIVERY_ALREADY_FINALIZED', 'Delivery is already finalized', 409);
  }
  throw new ApplicationError('DELIVERY_NOT_SCHEDULED', `Delivery cannot transition from ${current}`, 409);
}

export function requireCorrectionTransition(
  current: DeliveryCurrentStatus,
  replacement: CorrectionStatus,
  actualQuantity: string | undefined,
): void {
  if (!final.has(current)) {
    throw new ApplicationError('DELIVERY_NOT_FINALIZED', 'Delivery is not finalized', 409);
  }
  if (replacement === 'delivered') {
    requirePositiveQuantity(actualQuantity);
  } else if (actualQuantity !== undefined) {
    throw new ApplicationError('INVALID_DELIVERY_QUANTITY', 'Only delivered outcomes may have quantity', 400);
  }
}

export function canonicalizePositiveQuantity(value: string | undefined): string {
  requirePositiveQuantity(value);
  const [integer, fraction = ''] = value.split('.');
  const whole = integer.replace(/^0+(?=\d)/u, '');
  const decimal = fraction.replace(/0+$/u, '');
  return decimal ? `${whole}.${decimal}` : whole;
}

export function requireOutcomeReason(
  outcome: Exclude<AgentOutcomeStatus, 'delivered'>,
  reason: string | undefined,
  note: string | undefined,
): void {
  const allowed = outcome === 'skipped_by_agent' ? AGENT_SKIP_REASONS : MISSED_REASONS;
  if (!reason || !allowed.includes(reason as never)) {
    throw new ApplicationError('INVALID_DELIVERY_REASON', 'Delivery reason is invalid', 400);
  }
  if (reason === 'other' && (!note || note !== note.trim() || note.length > 500)) {
    throw new ApplicationError('INVALID_DELIVERY_NOTE', 'Other reasons require a trimmed note', 400);
  }
  if (note !== undefined && (note !== note.trim() || note.length < 1 || note.length > 500)) {
    throw new ApplicationError('INVALID_DELIVERY_NOTE', 'Delivery note is invalid', 400);
  }
}

function requirePositiveQuantity(value: string | undefined): asserts value is string {
  if (!value || !/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) {
    throw new ApplicationError('INVALID_DELIVERY_QUANTITY', 'Delivery quantity must be positive', 400);
  }
}
