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
  ]),
  vendor_administrator: new Set([
    'vendor:profile:read',
    'membership:read',
    'membership:manage',
    'audit:read',
    'household:read',
    'household:manage',
  ]),
  delivery_agent: new Set(['delivery:read', 'delivery:record']),
  customer: new Set(['customer:self']),
};

const activeVendorOperations: Readonly<Record<string, VendorPermission>> = {
  'vendor.profile.read': 'vendor:profile:read',
  'membership.list': 'membership:read',
  'membership.create': 'membership:manage',
  'membership.update-role': 'membership:manage',
  'membership.end': 'membership:manage',
  'membership.delete': 'membership:manage',
  'membership.restore': 'membership:manage',
  'audit.list': 'audit:read',
  'household.list': 'household:read',
  'household.get': 'household:read',
  'household.create': 'household:manage',
  'household.update': 'household:manage',
  'household.delete': 'household:manage',
  'household.restore': 'household:manage',
  'household.member-list': 'household:read',
  'household.member-attach': 'household:manage',
  'household.member-end': 'household:manage',
  'household.self-list': 'customer:self',
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
