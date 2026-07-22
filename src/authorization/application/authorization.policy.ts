import type { Actor, PlatformRole, VendorRole } from '../../common/context/request-context.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';

export type PlatformPermission =
  | 'vendor:read'
  | 'vendor:create'
  | 'vendor:transition'
  | 'platform-role:manage'
  | 'user:manage';

export type VendorPermission =
  | 'vendor:profile:read'
  | 'membership:read'
  | 'membership:manage'
  | 'household:read'
  | 'household:manage'
  | 'catalog:read'
  | 'catalog:manage'
  | 'pricing:read'
  | 'pricing:manage'
  | 'subscription:read'
  | 'subscription:manage'
  | 'route:read'
  | 'route:manage'
  | 'route:self'
  | 'schedule:read'
  | 'schedule:manage'
  | 'audit:read'
  | 'delivery:read'
  | 'delivery:record'
  | 'customer:self';

const platformPermissions: Readonly<Record<PlatformRole, ReadonlySet<PlatformPermission>>> = {
  product_owner: new Set(['vendor:read']),
  platform_administrator: new Set([
    'vendor:read',
    'vendor:create',
    'vendor:transition',
    'platform-role:manage',
    'user:manage',
  ]),
  support_operations: new Set(),
};

const vendorPermissions: Readonly<Record<VendorRole, ReadonlySet<VendorPermission>>> = {
  vendor_owner: new Set([
    'vendor:profile:read',
    'membership:read',
    'membership:manage',
    'audit:read',
    'household:read',
    'household:manage',
    'catalog:read',
    'catalog:manage',
    'pricing:read',
    'pricing:manage',
    'subscription:read',
    'subscription:manage',
    'route:read',
    'route:manage',
    'schedule:read',
    'schedule:manage',
  ]),
  vendor_administrator: new Set([
    'vendor:profile:read',
    'membership:read',
    'membership:manage',
    'audit:read',
    'household:read',
    'household:manage',
    'catalog:read',
    'catalog:manage',
    'pricing:read',
    'pricing:manage',
    'subscription:read',
    'subscription:manage',
    'route:read',
    'route:manage',
    'schedule:read',
    'schedule:manage',
  ]),
  delivery_agent: new Set(['delivery:read', 'delivery:record', 'route:self']),
  customer: new Set(['customer:self']),
};

const activeVendorOperations: Readonly<Record<string, VendorPermission>> = {
  'vendor.profile.read': 'vendor:profile:read',
  'membership.list': 'membership:read',
  'membership.get': 'membership:read',
  'membership.deleted-list': 'membership:manage',
  'membership.deleted-get': 'membership:manage',
  'membership.create': 'membership:manage',
  'membership.onboard': 'membership:manage',
  'membership.update-role': 'membership:manage',
  'membership.end': 'membership:manage',
  'membership.delete': 'membership:manage',
  'membership.restore': 'membership:manage',
  'audit.list': 'audit:read',
  'household.list': 'household:read',
  'household.get': 'household:read',
  'household.deleted-list': 'household:manage',
  'household.deleted-get': 'household:manage',
  'household.create': 'household:manage',
  'household.update': 'household:manage',
  'household.delete': 'household:manage',
  'household.restore': 'household:manage',
  'household.member-list': 'household:read',
  'household.member-attach': 'household:manage',
  'household.member-end': 'household:manage',
  'household.self-list': 'customer:self',
  'catalog.unit-list': 'catalog:read',
  'catalog.unit-get': 'catalog:read',
  'catalog.unit-create': 'catalog:manage',
  'catalog.unit-rename': 'catalog:manage',
  'catalog.unit-deactivate': 'catalog:manage',
  'catalog.unit-reactivate': 'catalog:manage',
  'catalog.product-list': 'catalog:read',
  'catalog.product-get': 'catalog:read',
  'catalog.product-deleted-list': 'catalog:manage',
  'catalog.product-deleted-get': 'catalog:manage',
  'catalog.product-create': 'catalog:manage',
  'catalog.product-update': 'catalog:manage',
  'catalog.product-delete': 'catalog:manage',
  'catalog.product-restore': 'catalog:manage',
  'catalog.delivery-slot-list': 'catalog:read',
  'catalog.delivery-slot-get': 'catalog:read',
  'catalog.delivery-slot-create': 'catalog:manage',
  'catalog.delivery-slot-rename': 'catalog:manage',
  'catalog.delivery-slot-deactivate': 'catalog:manage',
  'catalog.delivery-slot-reactivate': 'catalog:manage',
  'pricing.global-list': 'pricing:read',
  'pricing.global-get': 'pricing:read',
  'pricing.global-create': 'pricing:manage',
  'pricing.global-close': 'pricing:manage',
  'pricing.override-list': 'pricing:read',
  'pricing.override-get': 'pricing:read',
  'pricing.override-create': 'pricing:manage',
  'pricing.override-close': 'pricing:manage',
  'pricing.resolve': 'pricing:read',
  'pricing.self-resolve': 'customer:self',
  'subscription.list': 'subscription:read',
  'subscription.get': 'subscription:read',
  'subscription.deleted-list': 'subscription:manage',
  'subscription.deleted-get': 'subscription:manage',
  'subscription.history': 'subscription:read',
  'subscription.create': 'subscription:manage',
  'subscription.modify': 'subscription:manage',
  'subscription.pause': 'subscription:manage',
  'subscription.resume': 'subscription:manage',
  'subscription.cancel': 'subscription:manage',
  'subscription.delete': 'subscription:manage',
  'subscription.restore': 'subscription:manage',
  'subscription.self-list': 'customer:self',
  'subscription.self-get': 'customer:self',
  'subscription.self-history': 'customer:self',
  'route.list': 'route:read',
  'route.get': 'route:read',
  'route.deleted-list': 'route:manage',
  'route.deleted-get': 'route:manage',
  'route.create': 'route:manage',
  'route.rename': 'route:manage',
  'route.deactivate': 'route:manage',
  'route.reactivate': 'route:manage',
  'route.delete': 'route:manage',
  'route.restore': 'route:manage',
  'route.stops-list': 'route:read',
  'route.stops-replace': 'route:manage',
  'route.assignments-list': 'route:read',
  'route.assignment-put': 'route:manage',
  'route.assignment-cancel': 'route:manage',
  'route.assignments-self': 'route:self',
  'schedule.self-list': 'delivery:read',
  'schedule.run-list': 'schedule:read',
  'schedule.manual-generate': 'schedule:manage',
  'vendor.delivery-policy.update': 'schedule:manage',
  'leave.decision-list': 'schedule:read',
  'leave.vendor-get': 'schedule:read',
  'leave.decision': 'schedule:manage',
  'leave.preview': 'customer:self',
  'leave.create': 'customer:self',
  'leave.list': 'customer:self',
  'leave.get': 'customer:self',
  'leave.amend': 'customer:self',
  'leave.cancel': 'customer:self',
  'notification.self-list': 'customer:self',
};

export const hasPlatformPermission = (
  role: PlatformRole,
  permission: PlatformPermission,
): boolean => platformPermissions[role].has(permission);

export const hasVendorPermission = (
  role: VendorRole,
  permission: VendorPermission,
): boolean => vendorPermissions[role].has(permission);

export function forbid(): never {
  throw new ApplicationError(
    'FORBIDDEN',
    'You are not allowed to perform this action',
    403,
  );
}

export function requirePlatformPermission(
  role: PlatformRole,
  permission: PlatformPermission,
): void {
  if (!hasPlatformPermission(role, permission)) forbid();
}

export function requireVendorPermission(
  role: VendorRole,
  permission: VendorPermission,
): void {
  if (!hasVendorPermission(role, permission)) forbid();
}

export function requireVendorOperation(
  operation: string,
  permission: VendorPermission,
): void {
  if (activeVendorOperations[operation] !== permission) forbid();
}

export abstract class AuthorizationPolicy {
  abstract requirePlatform(actor: Actor, permission: PlatformPermission): void;

  abstract requireVendor(
    tx: TransactionContext,
    actor: Actor,
    vendorId: string,
    permission: VendorPermission,
    operation: string,
  ): Promise<void>;

  abstract requireSupport(
    tx: TransactionContext,
    actor: Actor,
    vendorId: string,
    scope: string,
    at: Date,
  ): Promise<void>;
}
