import type { TransactionContext } from '../../common/application/transaction-context.js';
import type {
  ActorMembership,
  PlatformRole,
} from '../../common/context/request-context.js';

export type AuthenticationVendorStatus = 'onboarding' | 'trial' | 'active';

export type IdentityAuthoritySnapshot = Readonly<{
  platformRoles: readonly PlatformRole[];
  memberships: readonly ActorMembership[];
}>;

export abstract class AuthenticationAuthorityPort {
  abstract snapshot(
    context: TransactionContext,
    userId: string,
    vendorStatuses: readonly AuthenticationVendorStatus[],
  ): Promise<IdentityAuthoritySnapshot>;
}

export abstract class UserLifecycleAuthorizationPort {
  abstract lockManagedVendors(
    context: TransactionContext,
  ): Promise<readonly string[]>;

  abstract ownerCounts(
    context: TransactionContext,
    vendorIds: readonly string[],
    userId: string,
  ): Promise<
    readonly Readonly<{
      vendorId: string;
      targetIsOwner: boolean;
      count: number;
    }>[]
  >;

  abstract lockActivePlatformAdministrators(
    context: TransactionContext,
  ): Promise<readonly string[]>;
}
