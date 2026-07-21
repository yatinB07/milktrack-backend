import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { RecordLifecycle } from '../../common/application/record-lifecycle.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import {
  MemberIdentityService,
  type MemberIdentityProfile,
  type OnboardingIdentity,
} from '../application/member-identity.service.js';

function profile(user: {
  id: string;
  displayName: string;
  identities: readonly { type: 'phone' | 'email'; normalizedValue: string }[];
}): MemberIdentityProfile {
  const phone = user.identities.find((identity) => identity.type === 'phone')?.normalizedValue;
  const email = user.identities.find((identity) => identity.type === 'email')?.normalizedValue;
  return {
    userId: user.id,
    displayName: user.displayName,
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
  };
}

@Injectable()
export class PrismaMemberIdentityService extends MemberIdentityService {
  async profiles(
    context: TransactionContext,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, MemberIdentityProfile>> {
    if (userIds.length === 0) return new Map();
    const users = await unwrapPrismaTransaction(context).user.findMany({
      where: { id: { in: [...new Set(userIds)] }, deletedAt: null },
      select: {
        id: true,
        displayName: true,
        identities: {
          where: { isPrimary: true },
          select: { type: true, normalizedValue: true },
        },
      },
    });
    return new Map(users.map((user) => [user.id, profile(user)]));
  }

  async discoveryProfiles(
    context: TransactionContext,
    userIds: readonly string[],
    lifecycle: RecordLifecycle,
  ): Promise<ReadonlyMap<string, MemberIdentityProfile>> {
    if (userIds.length === 0) return new Map();
    const users = await unwrapPrismaTransaction(context).user.findMany({
      where: {
        id: { in: [...new Set(userIds)] },
        ...(lifecycle === 'current' ? { deletedAt: null } : {}),
      },
      select: {
        id: true,
        displayName: true,
        deletedAt: true,
        identities: {
          where: { isPrimary: true },
          select: { type: true, normalizedValue: true },
        },
      },
    });
    return new Map(users.map((user) => [
      user.id,
      user.deletedAt
        ? { userId: user.id, displayName: user.displayName }
        : profile(user),
    ]));
  }

  async resolvePhoneUser(
    context: TransactionContext,
    input: Readonly<{ displayName: string; phone: string; userId: string; identityId: string }>,
  ): Promise<OnboardingIdentity> {
    const tx = unwrapPrismaTransaction(context);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`phone:${input.phone}`}, 0))::text`;
    const existing = await tx.userIdentity.findUnique({
      where: { type_normalizedValue: { type: 'phone', normalizedValue: input.phone } },
      select: {
        verifiedAt: true,
        user: {
          select: {
            id: true,
            displayName: true,
            status: true,
            deletedAt: true,
            identities: {
              where: { isPrimary: true },
              select: { type: true, normalizedValue: true },
            },
          },
        },
      },
    });
    if (existing) {
      if (existing.user.status !== 'active' || existing.user.deletedAt) {
        throw new ApplicationError('MEMBER_IDENTITY_UNAVAILABLE', 'Member identity is unavailable', 409);
      }
      return { ...profile(existing.user), phoneVerified: Boolean(existing.verifiedAt) };
    }
    const user = await tx.user.create({
      data: {
        id: input.userId,
        displayName: input.displayName,
        status: 'active',
        identities: {
          create: {
            id: input.identityId,
            type: 'phone',
            normalizedValue: input.phone,
            isPrimary: true,
          },
        },
      },
      select: {
        id: true,
        displayName: true,
        identities: {
          where: { isPrimary: true },
          select: { type: true, normalizedValue: true },
        },
      },
    });
    return { ...profile(user), phoneVerified: false };
  }
}
