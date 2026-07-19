import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { hasPlatformPermission } from '../../authorization/application/authorization.policy.js';
import {
  type Actor,
  requestContextStore,
} from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { normalizeEmail } from '../../identity/domain/identity-normalization.js';
import { TokenSecrets } from '../../identity/domain/token-hash.js';
import { OwnerEnrollmentDelivery } from './owner-enrollment.delivery.js';

export type EstablishVendorOwnerCommand = Readonly<{
  vendorId: string;
  email: string;
  displayName: string;
  reason: string;
}>;

export type VendorOwnerOnboardingResult = Readonly<{
  vendorId: string;
  userId: string;
  membershipId: string;
  enrollmentId: string;
  email: string;
  createdUser: boolean;
  expiresAt: Date;
  deliveryStatus: 'delivered';
}>;

export type RetryOwnerEnrollmentCommand = Readonly<{
  vendorId: string;
  enrollmentId: string;
  reason: string;
}>;

export type OwnerOnboardingState =
  | 'not_started'
  | 'invited'
  | 'setup_started'
  | 'completed'
  | 'expired'
  | 'retired'
  | 'delivery_failed';

export type VendorOwnerOnboardingStatusResult = Readonly<{
  vendorId: string;
  state: OwnerOnboardingState;
  enrollmentId?: string;
  membershipId?: string;
  ownerDisplayName?: string;
  ownerEmail?: string;
  expiresAt?: Date;
}>;

export type OwnerOnboardingStatusRecord = Readonly<{
  enrollmentId: string;
  membershipId: string;
  ownerDisplayName: string;
  ownerEmail: string;
  expiresAt: Date;
  startedAt: Date | null;
  consumedAt: Date | null;
  retiredAt: Date | null;
  deliveryState: string;
}>;

export type OwnerOnboardingUser = Readonly<{
  id: string;
  identityId: string;
  verifiedAt: Date | null;
  status: 'active' | 'suspended' | 'deactivated';
  deletedAt: Date | null;
  ownedByRetiredInvitation: boolean;
}>;

export interface OwnerOnboardingUnitOfWork {
  lockVendor(): Promise<
    'pending_approval' | 'onboarding' | 'trial' | 'active' | 'suspended' | 'closed' | null
  >;
  countEffectiveOwners(): Promise<number>;
  retireExpiredEnrollment(input: Readonly<{
    at: Date;
    actorUserId: string;
    correlationId: string;
  }>): Promise<void>;
  findUserByEmail(email: string): Promise<OwnerOnboardingUser | null>;
  createUser(input: Readonly<{
    id: string;
    emailIdentityId: string;
    email: string;
    displayName: string;
  }>): Promise<void>;
  createOwnerMembership(input: Readonly<{
    id: string;
    vendorId: string;
    userId: string;
  }>): Promise<void>;
  createEnrollment(input: Readonly<{
    id: string;
    vendorId: string;
    membershipId: string;
    userId: string;
    identityId: string;
    setupTokenHash: string;
    expiresAt: Date;
  }>): Promise<void>;
  appendAudit(input: Readonly<{
    id: string;
    vendorId: string;
    actorUserId: string;
    membershipId: string;
    userId: string;
    createdUser: boolean;
    reason: string;
    correlationId: string;
    ipHash?: string;
    deviceId?: string;
  }>): Promise<void>;
}

export abstract class VendorOwnerOnboardingStore {
  abstract status(vendorId: string): Promise<OwnerOnboardingStatusRecord | null>;
  abstract run<T>(
    vendorId: string,
    operation: (unit: OwnerOnboardingUnitOfWork) => Promise<T>,
  ): Promise<T>;
  abstract markDelivery(
    vendorId: string,
    enrollmentId: string,
    state: 'delivered' | 'failed',
  ): Promise<void>;
  abstract rotateDelivery(input: Readonly<{
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
  }>>;
}

export abstract class VendorOwnerOnboardingService {
  /** Returns a platform-safe enrollment projection; only administrators receive owner email. */
  abstract status(
    actor: Actor,
    vendorId: string,
  ): Promise<VendorOwnerOnboardingStatusResult>;
  abstract establish(
    actor: Actor,
    command: EstablishVendorOwnerCommand,
  ): Promise<VendorOwnerOnboardingResult>;
  abstract retry(
    actor: Actor,
    command: RetryOwnerEnrollmentCommand,
  ): Promise<Readonly<{
    enrollmentId: string;
    membershipId: string;
    expiresAt: Date;
    deliveryStatus: 'delivered';
  }>>;
}

export type OwnerOnboardingConfiguration = Readonly<{ authHmacKey: Buffer }>;

const eligibleStatuses = new Set(['onboarding', 'trial', 'active', 'suspended']);
const ENROLLMENT_LIFETIME_MS = 30 * 60_000;

function reasonValue(reason: string): string {
  const value = reason.trim();
  if (value.length < 3 || value.length > 500) {
    throw new ApplicationError(
      'INVALID_REASON',
      'Reason must be between 3 and 500 characters',
      400,
    );
  }
  return value;
}

@Injectable()
export class DefaultVendorOwnerOnboardingService extends VendorOwnerOnboardingService {
  private readonly tokens: TokenSecrets;

  constructor(
    @Inject(VendorOwnerOnboardingStore)
    private readonly store: VendorOwnerOnboardingStore,
    @Inject(OwnerEnrollmentDelivery)
    private readonly delivery: OwnerEnrollmentDelivery,
    configuration: OwnerOnboardingConfiguration,
  ) {
    super();
    this.tokens = new TokenSecrets(configuration.authHmacKey);
  }

  async establish(
    actor: Actor,
    command: EstablishVendorOwnerCommand,
  ): Promise<VendorOwnerOnboardingResult> {
    if (
      actor.authenticationMethod !== 'administrator_mfa' ||
      !actor.platformRoles.some((role) =>
        hasPlatformPermission(role, 'user:manage'),
      )
    ) {
      throw new ApplicationError(
        'FORBIDDEN',
        'You are not allowed to perform this action',
        403,
      );
    }
    const email = normalizeEmail(command.email);
    const displayName = command.displayName.trim();
    if (displayName.length < 2 || displayName.length > 120) {
      throw new ApplicationError(
        'INVALID_DISPLAY_NAME',
        'Display name must be between 2 and 120 characters',
        400,
      );
    }
    const reason = reasonValue(command.reason);
    const setupToken = this.tokens.issue();
    const expiresAt = new Date(Date.now() + ENROLLMENT_LIFETIME_MS);

    const result = await this.store.run(command.vendorId, async (unit) => {
      const status = await unit.lockVendor();
      if (!status) {
        throw new ApplicationError('VENDOR_NOT_FOUND', 'Vendor was not found', 404);
      }
      if (!eligibleStatuses.has(status)) {
        throw new ApplicationError(
          'VENDOR_OWNER_ONBOARDING_UNAVAILABLE',
          'Owner onboarding is unavailable for this vendor state',
          409,
        );
      }
      const context = requestContextStore.require();
      await unit.retireExpiredEnrollment({
        at: new Date(),
        actorUserId: actor.userId,
        correlationId: context.correlationId,
      });
      if ((await unit.countEffectiveOwners()) > 0) {
        throw new ApplicationError(
          'VENDOR_OWNER_EXISTS',
          'The vendor already has an active owner',
          409,
        );
      }

      let user = await unit.findUserByEmail(email);
      const createdUser = user === null;
      if (user && (
        user.deletedAt || user.status !== 'active' ||
        (user.verifiedAt === null && !user.ownedByRetiredInvitation)
      )) {
        throw new ApplicationError(
          'OWNER_USER_UNAVAILABLE',
          'The existing user cannot be assigned as an owner',
          409,
        );
      }
      if (!user) {
        user = {
          id: randomUUID(),
          identityId: randomUUID(),
          verifiedAt: null,
          status: 'active',
          deletedAt: null,
          ownedByRetiredInvitation: false,
        };
        await unit.createUser({
          id: user.id,
          emailIdentityId: user.identityId,
          email,
          displayName,
        });
      }

      const membershipId = randomUUID();
      await unit.createOwnerMembership({
        id: membershipId,
        vendorId: command.vendorId,
        userId: user.id,
      });
      const enrollmentId = randomUUID();
      await unit.createEnrollment({
        id: enrollmentId,
        vendorId: command.vendorId,
        membershipId,
        userId: user.id,
        identityId: user.identityId,
        setupTokenHash: this.tokens.hash(setupToken),
        expiresAt,
      });
      await unit.appendAudit({
        id: randomUUID(),
        vendorId: command.vendorId,
        actorUserId: actor.userId,
        membershipId,
        userId: user.id,
        createdUser,
        reason,
        correlationId: context.correlationId,
        ...(context.ipHash ? { ipHash: context.ipHash } : {}),
        ...(context.deviceId ? { deviceId: context.deviceId } : {}),
      });
      return {
        vendorId: command.vendorId,
        userId: user.id,
        membershipId,
        enrollmentId,
        email,
        createdUser,
        expiresAt,
      };
    });

    await this.deliverOrThrow(
      command.vendorId,
      result.enrollmentId,
      result.email,
      setupToken,
    );
    return { ...result, deliveryStatus: 'delivered' };
  }

  async status(
    actor: Actor,
    vendorId: string,
  ): Promise<VendorOwnerOnboardingStatusResult> {
    if (
      actor.authenticationMethod !== 'administrator_mfa' ||
      !actor.platformRoles.some((role) => hasPlatformPermission(role, 'vendor:read'))
    ) {
      throw new ApplicationError(
        'FORBIDDEN',
        'You are not allowed to perform this action',
        403,
      );
    }
    const enrollment = await this.store.status(vendorId);
    if (!enrollment) return { vendorId, state: 'not_started' };

    const state: OwnerOnboardingState = enrollment.consumedAt
      ? 'completed'
      : enrollment.retiredAt
        ? 'retired'
        : enrollment.expiresAt <= new Date()
          ? 'expired'
          : enrollment.startedAt
            ? 'setup_started'
            : enrollment.deliveryState === 'failed'
              ? 'delivery_failed'
              : 'invited';
    return {
      vendorId,
      state,
      enrollmentId: enrollment.enrollmentId,
      membershipId: enrollment.membershipId,
      ownerDisplayName: enrollment.ownerDisplayName,
      ...(actor.platformRoles.includes('platform_administrator')
        ? { ownerEmail: enrollment.ownerEmail }
        : {}),
      expiresAt: enrollment.expiresAt,
    };
  }

  async retry(
    actor: Actor,
    command: RetryOwnerEnrollmentCommand,
  ): Promise<Readonly<{
    enrollmentId: string;
    membershipId: string;
    expiresAt: Date;
    deliveryStatus: 'delivered';
  }>> {
    this.requireManager(actor);
    const setupToken = this.tokens.issue();
    const expiresAt = new Date(Date.now() + ENROLLMENT_LIFETIME_MS);
    const context = requestContextStore.require();
    const rotated = await this.store.rotateDelivery({
      vendorId: command.vendorId,
      enrollmentId: command.enrollmentId,
      setupTokenHash: this.tokens.hash(setupToken),
      expiresAt,
      actorUserId: actor.userId,
      reason: reasonValue(command.reason),
      correlationId: context.correlationId,
    });
    await this.deliverOrThrow(
      command.vendorId,
      command.enrollmentId,
      rotated.email,
      setupToken,
    );
    return {
      enrollmentId: command.enrollmentId,
      membershipId: rotated.membershipId,
      expiresAt: rotated.expiresAt,
      deliveryStatus: 'delivered',
    };
  }

  private requireManager(actor: Actor): void {
    if (
      actor.authenticationMethod !== 'administrator_mfa' ||
      !actor.platformRoles.some((role) => hasPlatformPermission(role, 'user:manage'))
    ) {
      throw new ApplicationError(
        'FORBIDDEN',
        'You are not allowed to perform this action',
        403,
      );
    }
  }

  private async deliverOrThrow(
    vendorId: string,
    enrollmentId: string,
    email: string,
    setupToken: string,
  ): Promise<void> {
    let delivered = false;
    for (let attempt = 0; attempt < 2 && !delivered; attempt += 1) {
      try {
        await this.delivery.send(email, setupToken);
        delivered = true;
      } catch {
        // The persisted pending delivery is retried once synchronously; a
        // failed state remains recoverable by the delivery outbox worker.
      }
    }
    try {
      await this.store.markDelivery(
        vendorId,
        enrollmentId,
        delivered ? 'delivered' : 'failed',
      );
    } catch {
      throw new ApplicationError(
        'OWNER_ENROLLMENT_DELIVERY_PENDING',
        'Owner enrollment delivery is pending and can be retried',
        503,
        true,
      );
    }
    if (!delivered) {
      throw new ApplicationError(
        'OWNER_ENROLLMENT_DELIVERY_PENDING',
        'Owner enrollment delivery is pending and can be retried',
        503,
        true,
      );
    }
  }
}
