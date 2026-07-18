import { ApplicationError } from '../../common/errors/application.error.js';

export type VendorStatus =
  | 'pending_approval'
  | 'onboarding'
  | 'trial'
  | 'active'
  | 'suspended'
  | 'closed';

const transitions: Readonly<Record<VendorStatus, readonly VendorStatus[]>> = {
  pending_approval: ['onboarding'],
  onboarding: ['trial', 'active'],
  trial: ['active', 'suspended'],
  active: ['suspended', 'closed'],
  suspended: ['active', 'closed'],
  closed: [],
};

export function requireVendorTransition(
  from: VendorStatus,
  to: VendorStatus,
): void {
  if (!transitions[from].includes(to)) {
    throw new ApplicationError(
      'VENDOR_STATE_CONFLICT',
      `Vendor cannot transition from ${from} to ${to}`,
      409,
    );
  }
}
