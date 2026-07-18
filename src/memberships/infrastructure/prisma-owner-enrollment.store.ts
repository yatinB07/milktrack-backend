import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  PrismaTenantTransactionRunner,
  type TenantTransactionRunner,
} from '../../database/tenant-transaction.runner.js';
import { Prisma, type OwnerEnrollment } from '../../generated/prisma/client.js';
import {
  type OwnerEnrollmentResult,
  OwnerEnrollmentStore,
} from '../application/owner-enrollment.service.js';

type HandlePhase = 'setup' | 'completion';

@Injectable()
export class PrismaOwnerEnrollmentStore extends OwnerEnrollmentStore {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PrismaTenantTransactionRunner)
    private readonly transactions: TenantTransactionRunner,
    @Inject(AuditWriter) private readonly audits: AuditWriter,
  ) {
    super();
  }

  async start(input: Readonly<{
    setupTokenHash: string;
    completionTokenHash: string;
    now: Date;
    password: Readonly<{
      hash: string;
      salt: string;
      parameters: Readonly<{ N: number; r: number; p: number; keyLength: number }>;
    }>;
    encryptedMfaSecret: string;
    correlationId: string;
    ipHash?: string;
    deviceId?: string;
  }>): Promise<'success' | 'invalid'> {
    const resolved = await this.resolve(input.setupTokenHash, 'setup');
    if (!resolved) return 'invalid';
    return this.transactions.run(resolved.vendorId, async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${'session-user:' + resolved.userId}, 0))::text`;
      const vendor = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text FROM vendors
        WHERE id = ${resolved.vendorId}::uuid AND deleted_at IS NULL
        FOR UPDATE`;
      if (
        !vendor[0] ||
        !['onboarding', 'trial', 'active', 'suspended'].includes(vendor[0].status)
      ) return 'invalid';
      const enrollment = await this.lockEnrollment(tx, resolved.enrollmentId);
      if (!this.canStart(enrollment, input.setupTokenHash, input.now)) return 'invalid';
      if (enrollment.userId !== resolved.userId) return 'invalid';
      const lockedMembership = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM vendor_memberships
        WHERE id = ${enrollment.membershipId}::uuid FOR UPDATE`;
      if (!lockedMembership[0]) return 'invalid';
      const membership = await tx.vendorMembership.findFirst({
        where: {
          id: enrollment.membershipId,
          userId: enrollment.userId,
          role: 'vendor_owner',
          status: 'invited',
          endedAt: null,
          deletedAt: null,
        },
        select: { id: true },
      });
      const user = await tx.user.findFirst({
        where: { id: enrollment.userId, status: 'active', deletedAt: null },
        select: { id: true },
      });
      if (!membership || !user) return 'invalid';
      await tx.ownerEnrollment.update({
        where: { id: enrollment.id },
        data: {
          completionTokenHash: input.completionTokenHash,
          passwordHash: input.password.hash,
          passwordSalt: input.password.salt,
          passwordParameters: input.password.parameters,
          encryptedMfaSecret: input.encryptedMfaSecret,
          startedAt: input.now,
        },
      });
      await this.audit(tx, enrollment, input, 'vendor.owner_enrollment_started');
      return 'success';
    });
  }

  async complete(input: Readonly<{
    completionTokenHash: string;
    now: Date;
    verifyCode: (encryptedMfaSecret: string) => boolean;
    mfaFactorId: string;
    correlationId: string;
    ipHash?: string;
    deviceId?: string;
  }>): Promise<OwnerEnrollmentResult | 'invalid' | 'owner_exists'> {
    const resolved = await this.resolve(input.completionTokenHash, 'completion');
    if (!resolved) return 'invalid';
    return this.transactions.run(resolved.vendorId, async (tx) => {
      const enrollment = await this.lockEnrollment(tx, resolved.enrollmentId);
      if (!this.canComplete(enrollment, input.completionTokenHash, input.now)) {
        return 'invalid';
      }
      if (!input.verifyCode(enrollment.encryptedMfaSecret!)) {
        const attemptCount = Math.min(enrollment.attemptCount + 1, 5);
        const locked = attemptCount === 5;
        await tx.ownerEnrollment.update({
          where: { id: enrollment.id },
          data: { attemptCount, ...(locked ? { lockedAt: input.now } : {}) },
        });
        await this.audit(
          tx,
          enrollment,
          input,
          locked
            ? 'vendor.owner_enrollment_locked'
            : 'vendor.owner_enrollment_totp_failed',
          { attemptCount },
        );
        return 'invalid';
      }

      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${'session-user:' + enrollment.userId}, 0))::text`;
      const vendor = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text FROM vendors
        WHERE id = ${enrollment.vendorId}::uuid AND deleted_at IS NULL
        FOR UPDATE`;
      if (
        !vendor[0] ||
        !['onboarding', 'trial', 'active', 'suspended'].includes(vendor[0].status)
      ) return 'invalid';
      const effectiveOwners = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count
        FROM vendor_memberships vm
        JOIN users u ON u.id = vm.user_id
        WHERE vm.role = 'vendor_owner' AND vm.status = 'active'
          AND vm.ended_at IS NULL AND vm.deleted_at IS NULL
          AND u.status = 'active' AND u.deleted_at IS NULL`;
      if (Number(effectiveOwners[0]?.count ?? 0) > 0) return 'owner_exists';

      const lockedMembership = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM vendor_memberships
        WHERE id = ${enrollment.membershipId}::uuid FOR UPDATE`;
      if (!lockedMembership[0]) return 'invalid';
      const membership = await tx.vendorMembership.findFirst({
        where: {
          id: enrollment.membershipId,
          userId: enrollment.userId,
          role: 'vendor_owner',
          status: 'invited',
          endedAt: null,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!membership) return 'invalid';

      const user = await tx.user.findFirst({
        where: { id: enrollment.userId, status: 'active', deletedAt: null },
        select: { id: true },
      });
      const identity = await tx.userIdentity.findFirst({
        where: { id: enrollment.identityId, userId: enrollment.userId, type: 'email' },
        select: { id: true },
      });
      if (!user || !identity) return 'invalid';

      await tx.passwordCredential.upsert({
        where: { userId: enrollment.userId },
        create: {
          userId: enrollment.userId,
          passwordHash: enrollment.passwordHash!,
          salt: enrollment.passwordSalt!,
          algorithm: 'scrypt',
          parameters: enrollment.passwordParameters!,
          changedAt: input.now,
        },
        update: {
          passwordHash: enrollment.passwordHash!,
          salt: enrollment.passwordSalt!,
          algorithm: 'scrypt',
          parameters: enrollment.passwordParameters!,
          changedAt: input.now,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
      await tx.mfaFactor.updateMany({
        where: { userId: enrollment.userId, type: 'totp', revokedAt: null },
        data: { revokedAt: input.now },
      });
      await tx.mfaFactor.create({
        data: {
          id: input.mfaFactorId,
          userId: enrollment.userId,
          type: 'totp',
          encryptedSecret: enrollment.encryptedMfaSecret!,
          enabledAt: input.now,
        },
      });
      await tx.userIdentity.update({
        where: { id: enrollment.identityId },
        data: { verifiedAt: input.now },
      });
      await tx.vendorMembership.update({
        where: { id: enrollment.membershipId },
        data: { status: 'active', joinedAt: input.now },
      });
      await tx.ownerEnrollment.update({
        where: { id: enrollment.id },
        data: {
          consumedAt: input.now,
          completionTokenHash: null,
          startedAt: null,
          passwordHash: null,
          passwordSalt: null,
          passwordParameters: Prisma.DbNull,
          encryptedMfaSecret: null,
        },
      });
      await tx.session.updateMany({
        where: { userId: enrollment.userId, revokedAt: null },
        data: { revokedAt: input.now },
      });
      await this.audit(
        tx,
        enrollment,
        input,
        'vendor.owner_enrollment_completed',
        { status: 'active', role: 'vendor_owner' },
      );
      return {
        vendorId: enrollment.vendorId,
        userId: enrollment.userId,
        membershipId: enrollment.membershipId,
      };
    });
  }

  private async resolve(tokenHash: string, phase: HandlePhase) {
    const rows = await this.prisma.$queryRaw<
      Array<{ enrollment_id: string; vendor_id: string; user_id: string }>
    >`SELECT * FROM resolve_owner_enrollment_handle(${tokenHash}, ${phase})`;
    const row = rows[0];
    return row
      ? {
          enrollmentId: row.enrollment_id,
          vendorId: row.vendor_id,
          userId: row.user_id,
        }
      : null;
  }

  private async lockEnrollment(tx: Prisma.TransactionClient, enrollmentId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM owner_enrollments WHERE id = ${enrollmentId}::uuid FOR UPDATE`;
    if (!rows[0]) return null;
    return tx.ownerEnrollment.findUnique({ where: { id: enrollmentId } });
  }

  private canStart(
    enrollment: OwnerEnrollment | null,
    setupTokenHash: string,
    now: Date,
  ): enrollment is OwnerEnrollment {
    return Boolean(
      enrollment && enrollment.setupTokenHash === setupTokenHash &&
      !enrollment.startedAt && !enrollment.consumedAt && !enrollment.retiredAt &&
      !enrollment.lockedAt && enrollment.expiresAt > now,
    );
  }

  private canComplete(
    enrollment: OwnerEnrollment | null,
    completionTokenHash: string,
    now: Date,
  ): enrollment is OwnerEnrollment {
    return Boolean(
      enrollment && enrollment.completionTokenHash === completionTokenHash &&
      enrollment.startedAt && !enrollment.consumedAt && !enrollment.retiredAt &&
      !enrollment.lockedAt && enrollment.expiresAt > now &&
      enrollment.passwordHash && enrollment.passwordSalt &&
      enrollment.passwordParameters && enrollment.encryptedMfaSecret,
    );
  }

  private audit(
    tx: Prisma.TransactionClient,
    enrollment: OwnerEnrollment,
    context: Readonly<{
      correlationId: string;
      ipHash?: string;
      deviceId?: string;
    }>,
    action: string,
    newValue?: unknown,
  ): Promise<void> {
    return this.audits.append(tx, {
      id: randomUUID(),
      vendorId: enrollment.vendorId,
      actorUserId: enrollment.userId,
      action,
      entityType: 'vendor_membership',
      entityId: enrollment.membershipId,
      ...(newValue !== undefined ? { newValue } : {}),
      correlationId: context.correlationId,
      ...(context.ipHash ? { ipHash: context.ipHash } : {}),
      ...(context.deviceId ? { deviceId: context.deviceId } : {}),
    });
  }
}
