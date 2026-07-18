import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { hasPlatformPermission } from '../../authorization/application/authorization.policy.js';
import {
  type Actor,
  requestContextStore,
} from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';

export type UserResult = Readonly<{
  id: string;
  displayName: string;
  status: 'active' | 'suspended' | 'deactivated';
  locale: string;
  deactivatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}>;

export type UserLifecycleRecord = Readonly<{
  id: string;
  displayName: string;
  status: 'active' | 'suspended' | 'deactivated';
  locale: string;
  deactivatedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export interface UserLifecycleUnitOfWork {
  lockSessionUser(userId: string): Promise<void>;
  lockManagedVendors(): Promise<readonly string[]>;
  ownerCounts(
    vendorIds: readonly string[],
    userId: string,
  ): Promise<
    readonly Readonly<{ vendorId: string; targetIsOwner: boolean; count: number }>[]
  >;
  lockActivePlatformAdministrators(): Promise<readonly string[]>;
  lockUser(userId: string): Promise<UserLifecycleRecord | null>;
  softDelete(
    userId: string,
    actorId: string,
    reason: string,
    at: Date,
  ): Promise<void>;
  deactivate(userId: string, at: Date): Promise<UserLifecycleRecord>;
  restore(userId: string): Promise<UserLifecycleRecord>;
  revokeSessions(userId: string, at: Date): Promise<void>;
  appendAudit(input: Readonly<{
    id: string;
    actorUserId: string;
    userId: string;
    action: string;
    reason: string;
    correlationId: string;
    ipHash?: string;
    deviceId?: string;
  }>): Promise<void>;
}

export abstract class UserLifecycleStore {
  abstract run<T>(
    operation: (unit: UserLifecycleUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export abstract class UserLifecycleService {
  abstract softDelete(actor: Actor, userId: string, reason: string): Promise<void>;
  abstract restore(actor: Actor, userId: string, reason: string): Promise<UserResult>;
  abstract deactivate(actor: Actor, userId: string, reason: string): Promise<UserResult>;
}

function result(record: UserLifecycleRecord): UserResult {
  return {
    id: record.id,
    displayName: record.displayName,
    status: record.status,
    locale: record.locale,
    ...(record.deactivatedAt ? { deactivatedAt: record.deactivatedAt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizedReason(reason: string): string {
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

function requireUserManager(actor: Actor): void {
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

@Injectable()
export class DefaultUserLifecycleService extends UserLifecycleService {
  constructor(
    @Inject(UserLifecycleStore) private readonly store: UserLifecycleStore,
  ) {
    super();
  }

  async softDelete(actor: Actor, userId: string, reason: string): Promise<void> {
    requireUserManager(actor);
    if (actor.userId === userId) {
      throw new ApplicationError(
        'SELF_DELETE_FORBIDDEN',
        'You cannot delete your own user account',
        409,
      );
    }
    const reasonValue = normalizedReason(reason);
    await this.store.run(async (unit) => {
      await unit.lockSessionUser(userId);
      await this.protectAdministratorsAndOwners(unit, userId);
      const user = await unit.lockUser(userId);
      if (!user || user.deletedAt) {
        throw new ApplicationError('USER_NOT_FOUND', 'User was not found', 404);
      }
      const at = new Date();
      await unit.softDelete(userId, actor.userId, reasonValue, at);
      await unit.revokeSessions(userId, at);
      await this.audit(unit, actor, userId, 'user.deleted', reasonValue);
    });
  }

  async restore(
    actor: Actor,
    userId: string,
    reason: string,
  ): Promise<UserResult> {
    requireUserManager(actor);
    const reasonValue = normalizedReason(reason);
    return this.store.run(async (unit) => {
      await unit.lockSessionUser(userId);
      const user = await unit.lockUser(userId);
      if (!user) {
        throw new ApplicationError('USER_NOT_FOUND', 'User was not found', 404);
      }
      if (!user.deletedAt) {
        throw new ApplicationError(
          'USER_STATE_CONFLICT',
          'User is not deleted',
          409,
        );
      }
      const restored = await unit.restore(userId);
      const at = new Date();
      await unit.revokeSessions(userId, at);
      await this.audit(unit, actor, userId, 'user.restored', reasonValue);
      return result(restored);
    });
  }

  async deactivate(
    actor: Actor,
    userId: string,
    reason: string,
  ): Promise<UserResult> {
    requireUserManager(actor);
    if (actor.userId === userId) {
      throw new ApplicationError(
        'SELF_DEACTIVATION_FORBIDDEN',
        'You cannot deactivate your own user account',
        409,
      );
    }
    const reasonValue = normalizedReason(reason);
    return this.store.run(async (unit) => {
      await unit.lockSessionUser(userId);
      await this.protectAdministratorsAndOwners(unit, userId);
      const user = await unit.lockUser(userId);
      if (!user || user.deletedAt) {
        throw new ApplicationError('USER_NOT_FOUND', 'User was not found', 404);
      }
      if (user.status === 'deactivated') {
        throw new ApplicationError(
          'USER_STATE_CONFLICT',
          'User is already deactivated',
          409,
        );
      }
      const at = new Date();
      const deactivated = await unit.deactivate(userId, at);
      await unit.revokeSessions(userId, at);
      await this.audit(unit, actor, userId, 'user.deactivated', reasonValue);
      return result(deactivated);
    });
  }

  private async protectAdministratorsAndOwners(
    unit: UserLifecycleUnitOfWork,
    userId: string,
  ): Promise<void> {
    const administrators = await unit.lockActivePlatformAdministrators();
    if (administrators.includes(userId) && administrators.length === 1) {
      throw new ApplicationError(
        'LAST_PLATFORM_ADMINISTRATOR',
        'The last active Platform Administrator cannot be changed',
        409,
      );
    }
    const vendorIds = await unit.lockManagedVendors();
    const orphaned = (await unit.ownerCounts(vendorIds, userId)).find(
      ({ targetIsOwner, count }) => targetIsOwner && count === 1,
    );
    if (orphaned) {
      throw new ApplicationError(
        'LAST_VENDOR_OWNER',
        'The last active Vendor Owner cannot be removed',
        409,
      );
    }
  }

  private async audit(
    unit: UserLifecycleUnitOfWork,
    actor: Actor,
    userId: string,
    action: string,
    reason: string,
  ): Promise<void> {
    const context = requestContextStore.get();
    await unit.appendAudit({
      id: randomUUID(),
      actorUserId: actor.userId,
      userId,
      action,
      reason,
      correlationId: context?.correlationId ?? randomUUID(),
      ...(context?.ipHash ? { ipHash: context.ipHash } : {}),
      ...(context?.deviceId ? { deviceId: context.deviceId } : {}),
    });
  }
}
