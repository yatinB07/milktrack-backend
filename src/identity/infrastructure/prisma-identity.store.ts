import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type {
  Actor,
  ActorMembership,
  VendorRole,
} from '../../common/context/request-context.js';
import { PrismaService } from '../../database/prisma.service.js';
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
type AuthenticationVendorStatus = 'onboarding' | 'trial' | 'active';

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
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
      const eligible = await this.isEligiblePhoneUser(tx, lookupUserId);
      const verifiedIdentity = identity?.verifiedAt && eligible ? identity : null;
      await tx.otpChallenge.create({
        data: {
          id: input.id,
          identityId: verifiedIdentity?.id,
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
        userId: verifiedIdentity?.userId,
        action: 'auth.otp_challenge_issued',
        entityId: input.id,
        correlationId: input.correlationId,
        ipHash: input.ipHash,
      });
      return { kind: 'created' as const, deliver: verifiedIdentity !== null };
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
    return this.prisma.$transaction(async (tx) => {
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
          identity: { select: { userId: true } },
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
      if (!(await this.isEligiblePhoneUser(tx, challenge.identity.userId))) {
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
  }

  async findAdministratorCredential(normalizedEmail: string): Promise<
    | Readonly<{
        userId: string;
        passwordChangedAt: Date;
        password: PasswordHash;
      }>
    | undefined
  > {
    return this.prisma.$transaction(async (tx) => {
      const identity = await tx.userIdentity.findFirst({
        where: {
          type: 'email',
          normalizedValue: normalizedEmail,
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
      const password = await tx.passwordCredential.findUnique({
        where: { userId },
        select: {
          passwordHash: true,
          salt: true,
          parameters: true,
          changedAt: true,
        },
      });
      const platformRole = await tx.platformRoleAssignment.findFirst({
        where: { userId, revokedAt: null },
        select: { id: true },
      });
      const memberships = await this.authenticationMemberships(tx, userId);
      const isAdministrator =
        platformRole !== null ||
        memberships.some(({ role }) =>
          role === 'vendor_owner' || role === 'vendor_administrator',
        );
      if (!identity || !password || !isAdministrator) return undefined;
      return {
        userId,
        passwordChangedAt: password.changedAt,
        password: {
          hash: password.passwordHash,
          salt: password.salt,
          parameters: password.parameters as unknown as PasswordHash['parameters'],
        },
      };
    });
  }

  async createPendingMfa(input: Readonly<{
    id: string;
    userId: string;
    tokenHash: string;
    deviceId: string;
    passwordChangedAt: Date;
    expiresAt: Date;
    ipHash?: string;
    correlationId: string;
  }>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.pendingMfaAuthentication.create({
        data: {
          id: input.id,
          userId: input.userId,
          tokenHash: input.tokenHash,
          deviceId: input.deviceId,
          passwordCredentialChangedAt: input.passwordChangedAt,
          expiresAt: input.expiresAt,
        },
      });
      await this.audit(tx, {
        userId: input.userId,
        action: 'auth.mfa_pending_created',
        entityId: input.id,
        correlationId: input.correlationId,
        ipHash: input.ipHash,
        deviceId: input.deviceId,
      });
    });
  }

  async verifyAdministratorMfa(input: Readonly<{
    tokenHash: string;
    deviceId: string;
    now: Date;
    verifyCode: (encryptedSecret: string) => boolean;
    session: PersistedSession;
    authenticationMethod: 'administrator_mfa';
    correlationId: string;
  }>): Promise<'success' | 'failed'> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM pending_mfa_authentications
        WHERE token_hash = ${input.tokenHash} FOR UPDATE`;
      if (!locked[0]) return 'failed';
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
      await this.sessionUserLock(tx, pending.userId);
      const user = await tx.user.findUnique({
        where: { id: pending.userId },
        select: { status: true, deletedAt: true },
      });
      const password = await tx.passwordCredential.findUnique({
        where: { userId: pending.userId },
        select: { changedAt: true },
      });
      const platformRole = await tx.platformRoleAssignment.findFirst({
        where: { userId: pending.userId, revokedAt: null },
        select: { id: true },
      });
      const factor = await tx.mfaFactor.findFirst({
        where: { userId: pending.userId, type: 'totp', revokedAt: null },
        select: { id: true, encryptedSecret: true },
      });
      const memberships = await this.authenticationMemberships(tx, pending.userId);
      const hasAdministratorAuthority =
        platformRole !== null ||
        memberships.some(({ role }) =>
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
        password.changedAt.getTime() !==
          pending.passwordCredentialChangedAt.getTime() ||
        !hasAdministratorAuthority ||
        !factor
      ) {
        return 'failed';
      }
      if (!input.verifyCode(factor.encryptedSecret)) {
        const attempts = pending.attemptCount + 1;
        await tx.pendingMfaAuthentication.update({
          where: { id: pending.id },
          data: { attemptCount: attempts },
        });
        if (attempts === OtpCodes.policy.maximumAttempts) {
          await this.audit(tx, {
            userId: pending.userId,
            action: 'auth.mfa_locked',
            entityId: pending.id,
            correlationId: input.correlationId,
            deviceId: input.deviceId,
          });
        }
        return 'failed';
      }
      await tx.pendingMfaAuthentication.update({
        where: { id: pending.id },
        data: { consumedAt: input.now },
      });
      await tx.mfaFactor.update({
        where: { id: factor.id },
        data: { lastUsedAt: input.now },
      });
      await this.createSession(
        tx,
        pending.userId,
        input.session,
        input.authenticationMethod,
      );
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
              platformRoles: {
                where: { revokedAt: null },
                select: { role: true },
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
      const activeMemberships = await this.activeMemberships(tx, session.userId);
      const authenticationMemberships = await this.authenticationMemberships(
        tx,
        session.userId,
      );
      const hasPrivilegedMembership = authenticationMemberships.some(({ role }) =>
        role === 'vendor_owner' || role === 'vendor_administrator',
      );
      const methodIsEligible = session.authenticationMethod === 'phone_otp'
        ? activeMemberships.length > 0 &&
          session.user.platformRoles.length === 0 &&
          !hasPrivilegedMembership
        : session.user.platformRoles.length > 0 || hasPrivilegedMembership;
      if (!methodIsEligible) {
        return undefined;
      }
      await tx.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
      return {
        userId: session.userId,
        sessionId: session.id,
        displayName: session.user.displayName,
        authenticationMethod: session.authenticationMethod,
        platformRoles: session.user.platformRoles.map(({ role }) => role),
        memberships: session.authenticationMethod === 'phone_otp'
          ? activeMemberships
          : authenticationMemberships,
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

  private async isEligiblePhoneUser(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<boolean> {
    const user = await tx.user.findFirst({
      where: { id: userId, status: 'active', deletedAt: null },
      select: {
        id: true,
        platformRoles: { where: { revokedAt: null }, select: { id: true }, take: 1 },
      },
    });
    const activeMemberships = await this.activeMemberships(tx, userId);
    const authenticationMemberships = await this.authenticationMemberships(tx, userId);
    return user !== null &&
      user.platformRoles.length === 0 &&
      activeMemberships.length > 0 &&
      activeMemberships.every(({ role }) => role === 'customer' || role === 'delivery_agent') &&
      !authenticationMemberships.some(({ role }) =>
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
        platformRoles: { where: { revokedAt: null }, select: { id: true }, take: 1 },
      },
    });
    if (!user) return false;
    const activeMemberships = await this.activeMemberships(tx, userId);
    const authenticationMemberships = await this.authenticationMemberships(tx, userId);
    const hasPrivilegedMembership = authenticationMemberships.some(({ role }) =>
      role === 'vendor_owner' || role === 'vendor_administrator',
    );
    return authenticationMethod === 'phone_otp'
      ? user.platformRoles.length === 0 &&
          activeMemberships.length > 0 &&
          !hasPrivilegedMembership
      : user.platformRoles.length > 0 || hasPrivilegedMembership;
  }

  private async activeMemberships(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<ActorMembership[]> {
    return this.membershipsForVendorStatuses(tx, userId, ['active']);
  }

  private async authenticationMemberships(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<ActorMembership[]> {
    return this.membershipsForVendorStatuses(tx, userId, [
      'onboarding',
      'trial',
      'active',
    ]);
  }

  private async membershipsForVendorStatuses(
    tx: Prisma.TransactionClient,
    userId: string,
    statuses: readonly AuthenticationVendorStatus[],
  ): Promise<ActorMembership[]> {
    const vendors = await tx.vendor.findMany({
      where: { status: { in: [...statuses] }, deletedAt: null },
      select: { id: true, displayName: true },
    });
    const memberships: ActorMembership[] = [];
    // ponytail: Phase 1 scans vendors through existing RLS; add a reviewed security-definer lookup if profiling shows this auth path is material.
    for (const vendor of vendors) {
      await tx.$queryRaw`SELECT set_config('app.vendor_id', ${vendor.id}, true)`;
      const rows = await tx.$queryRaw<{
        id: string;
        vendor_id: string;
        role: VendorRole;
        status: ActorMembership['status'];
      }[]>`
        SELECT id, vendor_id, role, status FROM vendor_memberships
        WHERE vendor_id = ${vendor.id}::uuid AND user_id = ${userId}::uuid
          AND status = 'active' AND ended_at IS NULL AND deleted_at IS NULL
        `;
      for (const row of rows) {
        memberships.push({
          id: row.id,
          vendorId: row.vendor_id,
          vendorName: vendor.displayName,
          role: row.role,
          status: row.status,
        });
      }
    }
    await tx.$queryRaw`SELECT set_config('app.vendor_id', '', true)`;
    return memberships;
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
