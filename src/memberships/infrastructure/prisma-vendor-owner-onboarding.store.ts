import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import {
  PrismaTenantTransactionRunner,
  type TenantTransactionRunner,
} from '../../database/tenant-transaction.runner.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  type OwnerOnboardingUnitOfWork,
  VendorOwnerOnboardingStore,
} from '../application/vendor-owner-onboarding.service.js';

function prismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

@Injectable()
export class PrismaVendorOwnerOnboardingStore extends VendorOwnerOnboardingStore {
  constructor(
    @Inject(PrismaTenantTransactionRunner)
    private readonly transactions: TenantTransactionRunner,
    @Inject(AuditWriter) private readonly audits: AuditWriter,
  ) {
    super();
  }

  run<T>(
    vendorId: string,
    operation: (unit: OwnerOnboardingUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return this.transactions.run(vendorId, (tx) => operation(this.unit(tx)));
  }

  markDelivery(
    vendorId: string,
    enrollmentId: string,
    state: 'delivered' | 'failed',
  ): Promise<void> {
    return this.transactions.run(vendorId, async (tx) => {
      const enrollment = await tx.ownerEnrollment.findFirst({
        where: { id: enrollmentId, vendorId, retiredAt: null, consumedAt: null },
        select: { id: true, membershipId: true },
      });
      if (!enrollment) return;
      await tx.ownerEnrollment.update({
        where: { id: enrollment.id },
        data: { deliveryState: state },
      });
      // Invite and retry/rotation operations carry the durable audit event.
      // Keeping this acknowledgement to the outbox row avoids taking a vendor
      // foreign-key lock while a concurrent invitation is resolving.
    });
  }

  rotateDelivery(input: Readonly<{
    vendorId: string;
    enrollmentId: string;
    setupTokenHash: string;
    expiresAt: Date;
    actorUserId: string;
    reason: string;
    correlationId: string;
  }>): Promise<Readonly<{
    email: string;
    membershipId: string;
    expiresAt: Date;
  }>> {
    return this.transactions.run(input.vendorId, async (tx) => {
      const vendors = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text FROM vendors
        WHERE id = ${input.vendorId}::uuid AND deleted_at IS NULL
        FOR UPDATE`;
      if (
        !vendors[0] ||
        !['onboarding', 'trial', 'active', 'suspended'].includes(vendors[0].status)
      ) {
        throw new ApplicationError(
          'OWNER_ENROLLMENT_RETRY_UNAVAILABLE',
          'Owner enrollment cannot be retried',
          409,
        );
      }
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM owner_enrollments
        WHERE id = ${input.enrollmentId}::uuid FOR UPDATE`;
      if (!locked[0]) {
        throw new ApplicationError(
          'OWNER_ENROLLMENT_RETRY_UNAVAILABLE',
          'Owner enrollment cannot be retried',
          409,
        );
      }
      const enrollment = await tx.ownerEnrollment.findFirst({
        where: {
          id: input.enrollmentId,
          vendorId: input.vendorId,
          startedAt: null,
          consumedAt: null,
          retiredAt: null,
          deliveryState: { in: ['pending', 'failed'] },
          membership: { status: 'invited', endedAt: null, deletedAt: null },
          user: { status: 'active', deletedAt: null },
        },
        select: {
          id: true,
          membershipId: true,
          identity: { select: { normalizedValue: true } },
        },
      });
      if (!enrollment) {
        throw new ApplicationError(
          'OWNER_ENROLLMENT_RETRY_UNAVAILABLE',
          'Owner enrollment cannot be retried',
          409,
        );
      }
      await tx.ownerEnrollment.update({
        where: { id: enrollment.id },
        data: {
          setupTokenHash: input.setupTokenHash,
          expiresAt: input.expiresAt,
          deliveryState: 'pending',
          attemptCount: 0,
          lockedAt: null,
        },
      });
      await this.audits.append(tx, {
        id: randomUUID(),
        vendorId: input.vendorId,
        actorUserId: input.actorUserId,
        action: 'vendor.owner_enrollment_delivery_rotated',
        entityType: 'vendor_membership',
        entityId: enrollment.membershipId,
        newValue: { deliveryState: 'pending', deliveryHandleChanged: true },
        reason: input.reason,
        correlationId: input.correlationId,
      });
      return {
        email: enrollment.identity.normalizedValue,
        membershipId: enrollment.membershipId,
        expiresAt: input.expiresAt,
      };
    });
  }

  private unit(tx: Prisma.TransactionClient): OwnerOnboardingUnitOfWork {
    return {
      lockVendor: async () => {
        const rows = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status::text FROM vendors
          WHERE id = current_setting('app.vendor_id')::uuid
            AND deleted_at IS NULL FOR UPDATE`;
        return (rows[0]?.status ?? null) as Awaited<
          ReturnType<OwnerOnboardingUnitOfWork['lockVendor']>
        >;
      },
      countEffectiveOwners: async () => {
        const rows = await tx.$queryRaw<{ count: bigint }[]>`
          SELECT count(*) AS count
          FROM vendor_memberships vm
          JOIN users u ON u.id = vm.user_id
          WHERE vm.role = 'vendor_owner' AND vm.status = 'active'
            AND vm.ended_at IS NULL AND vm.deleted_at IS NULL
            AND u.status = 'active' AND u.deleted_at IS NULL`;
        return Number(rows[0]?.count ?? 0);
      },
      retireExpiredEnrollment: async (input) => {
        const expired = await tx.ownerEnrollment.findMany({
          where: {
            consumedAt: null,
            retiredAt: null,
            expiresAt: { lte: input.at },
          },
          select: { id: true, membershipId: true },
        });
        for (const enrollment of expired) {
          await tx.ownerEnrollment.update({
            where: { id: enrollment.id },
            data: {
              retiredAt: input.at,
              retirementReason: 'expired',
              completionTokenHash: null,
              startedAt: null,
              passwordHash: null,
              passwordSalt: null,
              passwordParameters: Prisma.DbNull,
              encryptedMfaSecret: null,
            },
          });
          await tx.vendorMembership.updateMany({
            where: { id: enrollment.membershipId, status: 'invited' },
            data: { status: 'ended', endedAt: input.at },
          });
          await this.audits.append(tx, {
            id: randomUUID(),
            vendorId: (await tx.ownerEnrollment.findUniqueOrThrow({
              where: { id: enrollment.id },
              select: { vendorId: true },
            })).vendorId,
            actorUserId: input.actorUserId,
            action: 'vendor.owner_enrollment_retired',
            entityType: 'vendor_membership',
            entityId: enrollment.membershipId,
            newValue: { status: 'ended', retirementReason: 'expired' },
            correlationId: input.correlationId,
          });
        }
      },
      findUserByEmail: (email) =>
        tx.userIdentity
          .findUnique({
            where: {
              type_normalizedValue: { type: 'email', normalizedValue: email },
            },
            select: {
              id: true,
              verifiedAt: true,
              ownerEnrollments: {
                where: { retiredAt: { not: null } },
                select: { id: true },
                take: 1,
              },
              user: { select: { id: true, status: true, deletedAt: true } },
            },
          })
          .then((identity) =>
            identity
              ? {
                  id: identity.user.id,
                  identityId: identity.id,
                  verifiedAt: identity.verifiedAt,
                  status: identity.user.status,
                  deletedAt: identity.user.deletedAt,
                  ownedByRetiredInvitation: identity.ownerEnrollments.length > 0,
                }
              : null,
          ),
      createUser: async (input) => {
        try {
          await tx.user.create({
            data: {
              id: input.id,
              displayName: input.displayName,
              status: 'active',
              identities: {
                create: {
                  id: input.emailIdentityId,
                  type: 'email',
                  normalizedValue: input.email,
                  isPrimary: true,
                },
              },
            },
          });
        } catch (error) {
          if (prismaCode(error, 'P2002')) {
            throw new ApplicationError(
              'USER_IDENTITY_CONFLICT',
              'The email identity is already in use',
              409,
            );
          }
          throw error;
        }
      },
      createOwnerMembership: async (input) => {
        try {
          await tx.vendorMembership.create({
            data: {
              id: input.id,
              vendorId: input.vendorId,
              userId: input.userId,
              role: 'vendor_owner',
              status: 'invited',
            },
          });
        } catch (error) {
          if (prismaCode(error, 'P2002')) {
            throw new ApplicationError(
              'OWNER_ENROLLMENT_CONFLICT',
              'An owner enrollment already exists for this user',
              409,
            );
          }
          throw error;
        }
      },
      createEnrollment: async (input) => {
        try {
          await tx.ownerEnrollment.create({ data: input });
        } catch (error) {
          if (prismaCode(error, 'P2002')) {
            throw new ApplicationError(
              'OWNER_ENROLLMENT_CONFLICT',
              'An owner enrollment already exists',
              409,
            );
          }
          throw error;
        }
      },
      appendAudit: (input) =>
        this.audits.append(tx, {
          id: input.id,
          vendorId: input.vendorId,
          actorUserId: input.actorUserId,
          action: 'vendor.owner_enrollment_invited',
          entityType: 'vendor_membership',
          entityId: input.membershipId,
          newValue: {
            userId: input.userId,
            role: 'vendor_owner',
            status: 'invited',
            createdUser: input.createdUser,
          },
          reason: input.reason,
          correlationId: input.correlationId,
          ...(input.ipHash ? { ipHash: input.ipHash } : {}),
          ...(input.deviceId ? { deviceId: input.deviceId } : {}),
        }),
    };
  }
}
