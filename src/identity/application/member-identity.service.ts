import type { TransactionContext } from '../../common/application/transaction-context.js';

export type MemberIdentityProfile = Readonly<{
  userId: string;
  displayName: string;
  phone?: string;
  email?: string;
}>;

export type OnboardingIdentity = MemberIdentityProfile &
  Readonly<{ phoneVerified: boolean }>;

export abstract class MemberIdentityService {
  abstract profiles(
    tx: TransactionContext,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, MemberIdentityProfile>>;

  abstract resolvePhoneUser(
    tx: TransactionContext,
    input: Readonly<{ displayName: string; phone: string; userId: string; identityId: string }>,
  ): Promise<OnboardingIdentity>;
}
