import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuthenticationAuthorityPort } from '../../authorization/application/identity-authorization.port.js';
import type { Actor } from '../../common/context/request-context.js';
import { PrismaService } from '../../database/infrastructure/prisma.service.js';
import { wrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { OtpCodes } from '../domain/otp.js';
import type { PasswordHash } from '../domain/password.js';

type PersistedSession = Readonly<{
  id: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  deviceId: string;
  deviceName?: string;
  ipHash?: string;
  accessExpiresAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
}>;

type AuthenticationMethod = 'phone_otp' | 'administrator_mfa';

class PhoneEligibilityLostError extends Error {}

const NIL_USER_ID = '00000000-0000-0000-0000-000000000000';

type AuditInput = Readonly<{
  userId?: string;
  action: string;
  entityId: string;
  correlationId: string;
  ipHash?: string;
  deviceId?: string;
}>;

@Injectable()
export class PrismaIdentityStore {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthenticationAuthorityPort)
    private readonly authority: AuthenticationAuthorityPort,
  ) {}

  async createOtpChallenge(input: Readonly<{
    id: string;
    tokenHash: string;
    destinationHash: string;
    normalizedPhone: string;
    codeHash: string;
    purpose: 'sign_in';
    ipHash?: string;
    now: Date;
    expiresAt: Date;
    correlationId: string;
  }>): Promise<
    | Readonly<{ kind: 'created'; deliver: boolean }>
    | Readonly<{ kind: 'rate_limited'; retryAfterSeconds: number }>
  > {
    return this.prisma.$transaction(async (tx) => {
      await this.rateLimitLock(tx, input.destinationHash, input.ipHash);
      const recent = await tx.otpChallenge.findMany({
        where: {
          createdAt: { gt: new Date(input.now.getTime() - OtpCodes.policy.requestWindowSeconds * 1_000) },
          OR: [
            { destinationHash: input.destinationHash },
            ...(input.ipHash === undefined ? [] : [{ requestIpHash: input.ipHash }]),
          ],
        },
        select: { destinationHash: true, requestIpHash: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      const destinationRequests = recent.filter(
        (challenge) => challenge.destinationHash === input.destinationHash,
      );
      const ipRequests =
        input.ipHash === undefined
          ? []
          : recent.filter((challenge) => challenge.requestIpHash === input.ipHash);
      const latest = destinationRequests[0];
      const resendUntil = latest
        ? latest.createdAt.getTime() + OtpCodes.policy.resendWindowSeconds * 1_000
        : 0;
      if (
        resendUntil > input.now.getTime() ||
        destinationRequests.length >= OtpCodes.policy.maximumRequestsPerWindow ||
        ipRequests.length >= OtpCodes.policy.maximumRequestsPerWindow
      ) {
        const retryCandidates = [
          resendUntil,
          ...(destinationRequests.length < OtpCodes.policy.maximumRequestsPerWindow
            ? []
            : [
                destinationRequests[OtpCodes.policy.maximumRequestsPerWindow - 1]
                  .createdAt.getTime() + OtpCodes.policy.requestWindowSeconds * 1_000,
              ]),
          ...(ipRequests.length < OtpCodes.policy.maximumRequestsPerWindow
            ? []
            : [
                ipRequests[OtpCodes.policy.maximumRequestsPerWindow - 1]
                  .createdAt.getTime() + OtpCodes.policy.requestWindowSeconds * 1_000,
              ]),
        ];
        const retryAt = Math.max(...retryCandidates);
        return {
          kind: 'rate_limited' as const,
          retryAfterSeconds: Math.max(1, Math.ceil((retryAt - input.now.getTime()) / 1_000)),
        };
      }

      const identity = await tx.userIdentity.findUnique({
        where: {
          type_normalizedValue: { type: 'phone', normalizedValue: input.normalizedPhone },
        },
        select: { id: true, userId: true, verifiedAt: true },
      });
      const lookupUserId = identity?.userId ?? NIL_USER_ID;
      const eligible = await this.isEligiblePhoneUser(
        tx,
        lookupUserId,
        identity?.verifiedAt ? ['active'] : ['invited'],
      );
      const eligibleIdentity = identity && eligible ? identity : null;
      await tx.otpChallenge.create({
        data: {
          id: input.id,
          identityId: eligibleIdentity?.id,
          tokenHash: input.tokenHash,
          destinationHash: input.destinationHash,
          purpose: input.purpose,
          codeHash: input.codeHash,
          expiresAt: input.expiresAt,
          requestIpHash: input.ipHash,
          createdAt: input.now,
        },
      });
      await this.audit(tx, {
        userId: eligibleIdentity?.userId,
        action: 'auth.otp_challenge_issued',
        entityId: input.id,
        correlationId: input.correlationId,
        ipHash: input.ipHash,
      });
      return { kind: 'created' as const, deliver: eligibleIdentity !== null };
    });
  }

  async verifyPhoneOtp(input: Readonly<{
    tokenHash: string;
    verifyCode: (expectedHash: string) => boolean;
    now: Date;
    session: PersistedSession;
    authenticationMethod: 'phone_otp';
    correlationId: string;
  }>): Promise<'success' | 'failed'> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM otp_challenges WHERE token_hash = ${input.tokenHash} FOR UPDATE`;
        if (!locked[0]) return 'failed';
        const challenge = await tx.otpChallenge.findUnique({
          where: { id: locked[0].id },
          select: {
            id: true,
            identityId: true,
            codeHash: true,
            expiresAt: true,
            attemptCount: true,
            consumedAt: true,
            identity: { select: { id: true, userId: true, verifiedAt: true } },
          },
        });
        if (
          !challenge ||
          challenge.consumedAt ||
          challenge.expiresAt <= input.now ||
          challenge.attemptCount >= OtpCodes.policy.maximumAttempts
        ) {
          return 'failed';
        }
        if (!input.verifyCode(challenge.codeHash)) {
          const attempts = challenge.attemptCount + 1;
          await tx.otpChallenge.update({
            where: { id: challenge.id },
            data: { attemptCount: attempts },
          });
          if (attempts === OtpCodes.policy.maximumAttempts && challenge.identity) {
            await this.audit(tx, {
              userId: challenge.identity.userId,
              action: 'auth.otp_locked',
              entityId: challenge.id,
              correlationId: input.correlationId,
              deviceId: input.session.deviceId,
            });
          }
          return 'failed';
        }
        if (!challenge.identity) {
          await tx.otpChallenge.update({
            where: { id: challenge.id },
            data: { consumedAt: input.now },
          });
          return 'failed';
        }
        await this.sessionUserLock(tx, challenge.identity.userId);
        if (!(await this.isEligiblePhoneUser(
          tx,
          challenge.identity.userId,
          challenge.identity.verifiedAt ? ['active'] : ['invited'],
        ))) {
          await tx.otpChallenge.update({
            where: { id: challenge.id },
            data: { consumedAt: input.now },
          });
          return 'failed';
        }
        await tx.otpChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: input.now },
        });
        if (!challenge.identity.verifiedAt) {
          await tx.userIdentity.update({
            where: { id: challenge.identity.id },
            data: { verifiedAt: input.now },
          });
          await this.audit(tx, {
            userId: challenge.identity.userId,
            action: 'auth.phone_identity_verified',
            entityId: challenge.identity.id,
            correlationId: input.correlationId,
            ipHash: input.session.ipHash,
            deviceId: input.session.deviceId,
          });
        }
        await this.authority.activateInvitedPhoneMemberships(wrapPrismaTransaction(tx), {
          userId: challenge.identity.userId,
          at: input.now,
          correlationId: input.correlationId,
          ipHash: input.session.ipHash,
          deviceId: input.session.deviceId,
        });
        if (!(await this.isEligiblePhoneUser(tx, challenge.identity.userId))) {
          throw new PhoneEligibilityLostError();
        }
        await this.createSession(
          tx,
          challenge.identity.userId,
          input.session,
          input.authenticationMethod,
        );
        await this.audit(tx, {
          userId: challenge.identity.userId,
          action: 'auth.session_created',
          entityId: input.session.id,
          correlationId: input.correlationId,
          ipHash: input.session.ipHash,
          deviceId: input.session.deviceId,
        });
        return 'success';
      });
    } catch (error) {
      if (error instanceof PhoneEligibilityLostError) return 'failed';
      throw error;
    }
  }

  async startAdministratorSignIn(input: Readonly<{
    id: string;
    accountKey: string;
    normalizedEmail: string;
    tokenHash: string;
    deviceId: string;
    verifyPassword: (credential: PasswordHash | undefined) => Promise<boolean>;
    now: Date;
    expiresAt: Date;
    ipHash?: string;
    correlationId: string;
  }>): Promise<
    | Readonly<{ kind: 'success' }>
    | Readonly<{ kind: 'failed' }>
    | Readonly<{ kind: 'rate_limited'; retryAfterSeconds: number }>
  > {
    return this.prisma.$transaction(async (tx) => {
      await this.authenticationAttemptLock(tx, input.accountKey, input.ipHash);
      const cutoff = new Date(
        input.now.getTime() - OtpCodes.policy.requestWindowSeconds * 1_000,
      );
      const recentPasswordAttempts = await tx.administratorAuthenticationAttempt.findMany({
        where: {
          stage: 'password',
          succeeded: false,
          createdAt: { gt: cutoff },
          OR: [
            { accountKey: input.accountKey },
            ...(input.ipHash === undefined ? [] : [{ ipHash: input.ipHash }]),
          ],
        },
        select: { accountKey: true, ipHash: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      const ipFailures = input.ipHash === undefined
        ? []
        : recentPasswordAttempts.filter(({ ipHash }) => ipHash === input.ipHash);
      const accountFailures = recentPasswordAttempts.filter(
        ({ accountKey }) => accountKey === input.accountKey,
      );
      if (
        accountFailures.length >= OtpCodes.policy.maximumRequestsPerWindow ||
        ipFailures.length >= OtpCodes.policy.maximumRequestsPerWindow
      ) {
        return this.rateLimited(
          input.now,
          accountFailures,
          ipFailures,
        );
      }

      const identity = await tx.userIdentity.findFirst({
        where: {
          type: 'email',
          normalizedValue: input.normalizedEmail,
          verifiedAt: { not: null },
          user: {
            status: 'active',
            deletedAt: null,
            mfaFactors: { some: { type: 'totp', revokedAt: null } },
            password: { isNot: null },
          },
        },
        select: { userId: true },
      });
      const userId = identity?.userId ?? NIL_USER_ID;
      if (identity) {
        await tx.$queryRaw`
          SELECT user_id FROM password_credentials WHERE user_id = ${userId}::uuid FOR UPDATE
        `;
      }
      const password = await tx.passwordCredential.findUnique({
        where: { userId },
        select: {
          passwordHash: true,
          salt: true,
          parameters: true,
          changedAt: true,
          failedAttempts: true,
          lockedUntil: true,
        },
      });
      const authority = await this.authority.snapshot(
        wrapPrismaTransaction(tx),
        userId,
        ['onboarding', 'trial', 'active'],
      );
      const isAdministrator =
        authority.platformRoles.length > 0 ||
        authority.memberships.some(({ role }) =>
          role === 'vendor_owner' || role === 'vendor_administrator',
        );
      const credential = password
        ? {
          hash: password.passwordHash,
          salt: password.salt,
          parameters: password.parameters as unknown as PasswordHash['parameters'],
        }
        : undefined;
      const eligible = identity !== null && password !== null && isAdministrator;
      const passwordValid = await input.verifyPassword(eligible ? credential : undefined);
      const accountLocked = password?.lockedUntil && password.lockedUntil > input.now;
      if (!eligible || !passwordValid || accountLocked) {
        await tx.administratorAuthenticationAttempt.create({
          data: {
            id: randomUUID(),
            accountKey: input.accountKey,
            ipHash: input.ipHash,
            stage: 'password',
            succeeded: false,
            createdAt: input.now,
          },
        });
        if (eligible && !accountLocked) {
          const previousFailures =
            password.lockedUntil !== null && password.lockedUntil <= input.now
              ? 0
              : password.failedAttempts;
          const failedAttempts = Math.min(
            previousFailures + 1,
            OtpCodes.policy.maximumAttempts,
          );
          const lockedUntil = failedAttempts === OtpCodes.policy.maximumAttempts
            ? new Date(input.now.getTime() + OtpCodes.policy.requestWindowSeconds * 1_000)
            : null;
          await tx.passwordCredential.update({
            where: { userId },
            data: { failedAttempts, lockedUntil },
          });
          await this.audit(tx, {
            userId,
            action: 'auth.password_failed',
            entityId: userId,
            correlationId: input.correlationId,
            ipHash: input.ipHash,
            deviceId: input.deviceId,
          });
          if (lockedUntil) {
            await this.audit(tx, {
              userId,
              action: 'auth.password_locked',
              entityId: userId,
              correlationId: input.correlationId,
              ipHash: input.ipHash,
              deviceId: input.deviceId,
            });
          }
        } else {
          await this.audit(tx, {
            userId: eligible ? userId : undefined,
            action: 'auth.password_failed',
            entityId: eligible ? userId : NIL_USER_ID,
            correlationId: input.correlationId,
            ipHash: input.ipHash,
            deviceId: input.deviceId,
          });
        }
        return { kind: 'failed' as const };
      }

      const recentPending = await tx.administratorAuthenticationAttempt.findMany({
        where: {
          stage: 'pending_mfa',
          succeeded: true,
          createdAt: { gt: cutoff },
          OR: [
            { accountKey: input.accountKey },
            ...(input.ipHash === undefined ? [] : [{ ipHash: input.ipHash }]),
          ],
        },
        select: { accountKey: true, ipHash: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      const accountPending = recentPending.filter(
        ({ accountKey }) => accountKey === input.accountKey,
      );
      const ipPending = input.ipHash === undefined
        ? []
        : recentPending.filter(({ ipHash }) => ipHash === input.ipHash);
      if (
        accountPending.length >= OtpCodes.policy.maximumRequestsPerWindow ||
        ipPending.length >= OtpCodes.policy.maximumRequestsPerWindow
      ) {
        return this.rateLimited(
          input.now,
          accountPending,
          ipPending,
        );
      }

      await tx.passwordCredential.update({
        where: { userId },
        data: { failedAttempts: 0, lockedUntil: null },
      });
      await tx.pendingMfaAuthentication.create({
        data: {
          id: input.id,
          userId,
          tokenHash: input.tokenHash,
          deviceId: input.deviceId,
          passwordCredentialChangedAt: password.changedAt,
          expiresAt: input.expiresAt,
          requestIpHash: input.ipHash,
          createdAt: input.now,
        },
      });
      await tx.administratorAuthenticationAttempt.create({
        data: {
          id: randomUUID(),
          accountKey: input.accountKey,
          ipHash: input.ipHash,
          stage: 'pending_mfa',
          succeeded: true,
          createdAt: input.now,
        },
      });
      await this.audit(tx, {
        userId,
        action: 'auth.password_succeeded',
        entityId: userId,
        correlationId: input.correlationId,
        ipHash: input.ipHash,
        deviceId: input.deviceId,
      });
      await this.audit(tx, {
        userId,
        action: 'auth.mfa_pending_created',
        entityId: input.id,
        correlationId: input.correlationId,
        ipHash: input.ipHash,
        deviceId: input.deviceId,
      });
      return { kind: 'success' as const };
    });
  }

  async verifyAdministratorMfa(input: Readonly<{
    tokenHash: string;
    deviceId: string;
    now: Date;
    verifyCode: (encryptedSecret: string) => number | undefined;
    session: PersistedSession;
    authenticationMethod: 'administrator_mfa';
    correlationId: string;
    ipHash?: string;
  }>): Promise<'success' | 'failed'> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM pending_mfa_authentications
        WHERE token_hash = ${input.tokenHash} FOR UPDATE`;
      if (!locked[0]) {
        await this.audit(tx, {
          action: 'auth.mfa_failed',
          entityId: NIL_USER_ID,
          correlationId: input.correlationId,
          ipHash: input.ipHash,
          deviceId: input.deviceId,
        });
        return 'failed';
      }
      const pending = await tx.pendingMfaAuthentication.findUnique({
        where: { id: locked[0].id },
        select: {
          id: true,
          userId: true,
          deviceId: true,
          passwordCredentialChangedAt: true,
          expiresAt: true,
          attemptCount: true,
          consumedAt: true,
        },
      });
      if (!pending) return 'failed';
      const user = await tx.user.findUnique({
        where: { id: pending.userId },
        select: { status: true, deletedAt: true },
      });
      const password = await tx.passwordCredential.findUnique({
        where: { userId: pending.userId },
        select: { changedAt: true, lockedUntil: true },
      });
      const lockedFactor = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM mfa_factors
        WHERE user_id = ${pending.userId}::uuid AND type = 'totp' AND revoked_at IS NULL
        ORDER BY enabled_at, id LIMIT 1 FOR UPDATE
      `;
      await this.sessionUserLock(tx, pending.userId);
      const factor = await tx.mfaFactor.findUnique({
        where: { id: lockedFactor[0]?.id ?? NIL_USER_ID },
        select: { id: true, encryptedSecret: true, lastUsedCounter: true },
      });
      const authority = await this.authority.snapshot(
        wrapPrismaTransaction(tx),
        pending.userId,
        ['onboarding', 'trial', 'active'],
      );
      const hasAdministratorAuthority =
        authority.platformRoles.length > 0 ||
        authority.memberships.some(({ role }) =>
          role === 'vendor_owner' || role === 'vendor_administrator',
        );
      if (
        pending.consumedAt ||
        pending.expiresAt <= input.now ||
        pending.attemptCount >= OtpCodes.policy.maximumAttempts ||
        pending.deviceId !== input.deviceId ||
        !user ||
        user.status !== 'active' ||
        user.deletedAt ||
        !password ||
        (password.lockedUntil !== null && password.lockedUntil > input.now) ||
        password.changedAt.getTime() !==
          pending.passwordCredentialChangedAt.getTime() ||
        !hasAdministratorAuthority ||
        !factor
      ) {
        await this.audit(tx, {
          userId: pending.userId,
          action: 'auth.mfa_failed',
          entityId: pending.id,
          correlationId: input.correlationId,
          ipHash: input.ipHash,
          deviceId: input.deviceId,
        });
        return 'failed';
      }
      const recentFailures = await tx.pendingMfaAuthentication.aggregate({
        where: {
          userId: pending.userId,
          createdAt: {
            gt: new Date(
              input.now.getTime() - OtpCodes.policy.requestWindowSeconds * 1_000,
            ),
          },
        },
        _sum: { attemptCount: true },
      });
      const aggregateAttempts = recentFailures._sum.attemptCount ?? 0;
      if (aggregateAttempts >= OtpCodes.policy.maximumAttempts) {
        await this.audit(tx, {
          userId: pending.userId,
          action: 'auth.mfa_failed',
          entityId: pending.id,
          correlationId: input.correlationId,
          ipHash: input.ipHash,
          deviceId: input.deviceId,
        });
        return 'failed';
      }
      const counter = input.verifyCode(factor.encryptedSecret);
      if (counter === undefined) {
        await this.recordAdministratorMfaFailure(tx, pending, aggregateAttempts, input);
        return 'failed';
      }
      if (
        factor.lastUsedCounter !== null &&
        BigInt(counter) <= factor.lastUsedCounter
      ) {
        await this.recordAdministratorMfaFailure(tx, pending, aggregateAttempts, input);
        return 'failed';
      }
      await tx.pendingMfaAuthentication.update({
        where: { id: pending.id },
        data: { consumedAt: input.now },
      });
      await tx.mfaFactor.update({
        where: { id: factor.id },
        data: { lastUsedAt: input.now, lastUsedCounter: BigInt(counter) },
      });
      await this.createSession(
        tx,
        pending.userId,
        input.session,
        input.authenticationMethod,
      );
      await this.audit(tx, {
        userId: pending.userId,
        action: 'auth.mfa_succeeded',
        entityId: pending.id,
        correlationId: input.correlationId,
        ipHash: input.ipHash,
        deviceId: input.deviceId,
      });
      await this.audit(tx, {
        userId: pending.userId,
        action: 'auth.session_created',
        entityId: input.session.id,
        correlationId: input.correlationId,
        ipHash: input.session.ipHash,
        deviceId: input.session.deviceId,
      });
      return 'success';
    });
  }

  async rotateSession(input: Readonly<{
    refreshTokenHash: string;
    deviceId: string;
    now: Date;
    successor: PersistedSession;
    correlationId: string;
  }>): Promise<'success' | 'failed'> {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.session.findUnique({
        where: { refreshTokenHash: input.refreshTokenHash },
        select: { userId: true },
      });
      if (!candidate) return 'failed';
      await this.sessionUserLock(tx, candidate.userId);
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM sessions WHERE refresh_token_hash = ${input.refreshTokenHash} FOR UPDATE`;
      if (!locked[0]) return 'failed';
      const session = await tx.session.findUnique({
        where: { id: locked[0].id },
        select: {
          id: true,
          userId: true,
          deviceId: true,
          expiresAt: true,
          revokedAt: true,
          authenticationMethod: true,
          user: { select: { status: true, deletedAt: true } },
        },
      });
      if (!session) return 'failed';
      const successorExists =
        (await tx.session.count({ where: { predecessorId: session.id } })) > 0;
      if (session.revokedAt || successorExists) {
        await tx.session.updateMany({
          where: { userId: session.userId, revokedAt: null },
          data: { revokedAt: input.now },
        });
        await this.audit(tx, {
          userId: session.userId,
          action: 'auth.session_replay_detected',
          entityId: session.id,
          correlationId: input.correlationId,
          deviceId: input.deviceId,
        });
        return 'failed';
      }
      if (session.deviceId !== input.deviceId || session.expiresAt <= input.now) {
        return 'failed';
      }
      if (
        session.user.status !== 'active' ||
        session.user.deletedAt ||
        !(await this.isAuthenticationMethodEligible(
          tx,
          session.userId,
          session.authenticationMethod,
        ))
      ) {
        return 'failed';
      }
      await this.createSession(
        tx,
        session.userId,
        input.successor,
        session.authenticationMethod,
        session.id,
      );
      await tx.session.update({
        where: { id: session.id },
        data: { revokedAt: input.now },
      });
      await this.audit(tx, {
        userId: session.userId,
        action: 'auth.session_rotated',
        entityId: input.successor.id,
        correlationId: input.correlationId,
        deviceId: input.deviceId,
      });
      return 'success';
    });
  }

  async authenticate(accessTokenHash: string, now: Date): Promise<Actor | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { accessTokenHash },
        select: {
          id: true,
          userId: true,
          accessExpiresAt: true,
          expiresAt: true,
          revokedAt: true,
          authenticationMethod: true,
          user: {
            select: {
              displayName: true,
              status: true,
              deletedAt: true,
              mfaFactors: {
                where: { type: 'totp', revokedAt: null },
                select: { id: true },
                take: 1,
              },
            },
          },
        },
      });
      if (
        !session ||
        session.revokedAt ||
        session.accessExpiresAt <= now ||
        session.expiresAt <= now ||
        session.user.status !== 'active' ||
        session.user.deletedAt
      ) {
        return undefined;
      }
      const activeAuthority = await this.authority.snapshot(
        wrapPrismaTransaction(tx),
        session.userId,
        ['active'],
      );
      const authenticationAuthority = await this.authority.snapshot(
        wrapPrismaTransaction(tx),
        session.userId,
        ['onboarding', 'trial', 'active'],
      );
      const hasPrivilegedMembership = authenticationAuthority.memberships.some(({ role }) =>
        role === 'vendor_owner' || role === 'vendor_administrator',
      );
      const methodIsEligible = session.authenticationMethod === 'phone_otp'
        ? activeAuthority.memberships.length > 0 &&
          authenticationAuthority.platformRoles.length === 0 &&
          !hasPrivilegedMembership
        : session.user.mfaFactors.length > 0 &&
          (authenticationAuthority.platformRoles.length > 0 || hasPrivilegedMembership);
      if (!methodIsEligible) {
        return undefined;
      }
      const touched = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { lastSeenAt: now },
      });
      if (touched.count !== 1) return undefined;
      return {
        userId: session.userId,
        sessionId: session.id,
        displayName: session.user.displayName,
        authenticationMethod: session.authenticationMethod,
        platformRoles: authenticationAuthority.platformRoles,
        memberships: session.authenticationMethod === 'phone_otp'
          ? activeAuthority.memberships
          : authenticationAuthority.memberships,
      };
    });
  }

  async logout(
    accessTokenHash: string,
    now: Date,
    correlationId: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.session.findUnique({
        where: { accessTokenHash },
        select: { userId: true },
      });
      if (!candidate) return false;
      await this.sessionUserLock(tx, candidate.userId);
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM sessions WHERE access_token_hash = ${accessTokenHash} FOR UPDATE`;
      if (!locked[0]) return false;
      const session = await tx.session.findUnique({
        where: { id: locked[0].id },
        select: { id: true, userId: true, deviceId: true, revokedAt: true },
      });
      if (!session || session.revokedAt) return false;
      await tx.session.update({ where: { id: session.id }, data: { revokedAt: now } });
      await this.audit(tx, {
        userId: session.userId,
        action: 'auth.session_revoked',
        entityId: session.id,
        correlationId,
        deviceId: session.deviceId,
      });
      return true;
    });
  }

  async logoutAll(
    accessTokenHash: string,
    now: Date,
    correlationId: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.session.findUnique({
        where: { accessTokenHash },
        select: { userId: true },
      });
      if (!candidate) return false;
      await this.sessionUserLock(tx, candidate.userId);
      const session = await tx.session.findUnique({
        where: { accessTokenHash },
        select: { id: true, userId: true, deviceId: true, revokedAt: true },
      });
      if (!session || session.revokedAt) return false;
      await tx.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit(tx, {
        userId: session.userId,
        action: 'auth.all_sessions_revoked',
        entityId: session.id,
        correlationId,
        deviceId: session.deviceId,
      });
      return true;
    });
  }

  private async recordAdministratorMfaFailure(
    tx: Prisma.TransactionClient,
    pending: Readonly<{ id: string; userId: string; attemptCount: number }>,
    aggregateAttempts: number,
    input: Readonly<{
      now: Date;
      correlationId: string;
      deviceId: string;
      ipHash?: string;
    }>,
  ): Promise<void> {
    await tx.pendingMfaAuthentication.update({
      where: { id: pending.id },
      data: { attemptCount: pending.attemptCount + 1 },
    });
    await this.audit(tx, {
      userId: pending.userId,
      action: 'auth.mfa_failed',
      entityId: pending.id,
      correlationId: input.correlationId,
      ipHash: input.ipHash,
      deviceId: input.deviceId,
    });
    if (aggregateAttempts + 1 !== OtpCodes.policy.maximumAttempts) return;
    await tx.passwordCredential.update({
      where: { userId: pending.userId },
      data: {
        failedAttempts: OtpCodes.policy.maximumAttempts,
        lockedUntil: new Date(
          input.now.getTime() + OtpCodes.policy.requestWindowSeconds * 1_000,
        ),
      },
    });
    await this.audit(tx, {
      userId: pending.userId,
      action: 'auth.mfa_locked',
      entityId: pending.id,
      correlationId: input.correlationId,
      ipHash: input.ipHash,
      deviceId: input.deviceId,
    });
  }

  private async rateLimitLock(
    tx: Prisma.TransactionClient,
    destinationHash: string,
    ipHash?: string,
  ): Promise<void> {
    const keys = [destinationHash, ...(ipHash === undefined ? [] : [ipHash])].sort();
    for (const key of keys) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
    }
  }

  private async authenticationAttemptLock(
    tx: Prisma.TransactionClient,
    accountKey: string,
    ipHash?: string,
  ): Promise<void> {
    const keys = [
      `admin-account:${accountKey}`,
      ...(ipHash === undefined ? [] : [`admin-ip:${ipHash}`]),
    ].sort();
    for (const key of keys) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
    }
  }

  private rateLimited(
    now: Date,
    ...attemptBuckets: readonly (readonly Readonly<{ createdAt: Date }>[])[]
  ): Readonly<{ kind: 'rate_limited'; retryAfterSeconds: number }> {
    const retryAt = Math.max(
      ...attemptBuckets
        .filter(({ length }) => length >= OtpCodes.policy.maximumRequestsPerWindow)
        .map((attempts) =>
          attempts[OtpCodes.policy.maximumRequestsPerWindow - 1].createdAt.getTime() +
            OtpCodes.policy.requestWindowSeconds * 1_000,
        ),
    );
    return {
      kind: 'rate_limited',
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now.getTime()) / 1_000)),
    };
  }

  private async isEligiblePhoneUser(
    tx: Prisma.TransactionClient,
    userId: string,
    statuses: readonly ('active' | 'invited')[] = ['active'],
  ): Promise<boolean> {
    const user = await tx.user.findFirst({
      where: { id: userId, status: 'active', deletedAt: null },
      select: { id: true },
    });
    const hasPhoneMembership = await this.authority.hasPhoneMembership(
      wrapPrismaTransaction(tx),
      userId,
      statuses,
    );
    const authenticationAuthority = await this.authority.snapshot(
      wrapPrismaTransaction(tx),
      userId,
      ['onboarding', 'trial', 'active'],
    );
    return user !== null &&
      authenticationAuthority.platformRoles.length === 0 &&
      hasPhoneMembership &&
      !authenticationAuthority.memberships.some(({ role }) =>
        role === 'vendor_owner' || role === 'vendor_administrator',
      );
  }

  private async isAuthenticationMethodEligible(
    tx: Prisma.TransactionClient,
    userId: string,
    authenticationMethod: AuthenticationMethod,
  ): Promise<boolean> {
    const user = await tx.user.findFirst({
      where: { id: userId, status: 'active', deletedAt: null },
      select: {
        id: true,
        mfaFactors: {
          where: { type: 'totp', revokedAt: null },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!user) return false;
    const activeAuthority = await this.authority.snapshot(
      wrapPrismaTransaction(tx),
      userId,
      ['active'],
    );
    const authenticationAuthority = await this.authority.snapshot(
      wrapPrismaTransaction(tx),
      userId,
      ['onboarding', 'trial', 'active'],
    );
    const hasPrivilegedMembership = authenticationAuthority.memberships.some(({ role }) =>
      role === 'vendor_owner' || role === 'vendor_administrator',
    );
    return authenticationMethod === 'phone_otp'
      ? authenticationAuthority.platformRoles.length === 0 &&
          activeAuthority.memberships.length > 0 &&
          !hasPrivilegedMembership
      : user.mfaFactors.length > 0 &&
        (authenticationAuthority.platformRoles.length > 0 || hasPrivilegedMembership);
  }

  private createSession(
    tx: Prisma.TransactionClient,
    userId: string,
    session: PersistedSession,
    authenticationMethod: AuthenticationMethod,
    predecessorId?: string,
  ): Promise<unknown> {
    return this.createSessionWithLock(tx, userId, session, authenticationMethod, predecessorId);
  }

  private async createSessionWithLock(
    tx: Prisma.TransactionClient,
    userId: string,
    session: PersistedSession,
    authenticationMethod: AuthenticationMethod,
    predecessorId?: string,
  ): Promise<unknown> {
    await this.sessionUserLock(tx, userId);
    return tx.session.create({
      data: {
        id: session.id,
        userId,
        accessTokenHash: session.accessTokenHash,
        refreshTokenHash: session.refreshTokenHash,
        predecessorId,
        authenticationMethod,
        deviceId: session.deviceId,
        deviceName: session.deviceName,
        ipHash: session.ipHash,
        accessExpiresAt: session.accessExpiresAt,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
      },
    });
  }

  private async sessionUserLock(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${'session-user:' + userId}, 0))::text
    `;
  }

  private async audit(tx: Prisma.TransactionClient, input: AuditInput): Promise<void> {
    // Global authentication audits are insert-only under RLS and cannot be read back by RETURNING.
    await tx.$executeRaw`
      INSERT INTO audit_events
        (id, actor_user_id, action, entity_type, entity_id, correlation_id,
         ip_hash, device_id)
      VALUES
        (${randomUUID()}::uuid, ${input.userId ?? null}::uuid, ${input.action},
         'authentication', ${input.entityId}::uuid, ${input.correlationId}::uuid,
         ${input.ipHash ?? null}, ${input.deviceId ?? null})
    `;
  }
}
