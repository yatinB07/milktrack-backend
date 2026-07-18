import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

import { ApplicationError } from '../errors/application.error.js';

export type PlatformRole =
  | 'product_owner'
  | 'platform_administrator'
  | 'support_operations';

export type VendorRole =
  | 'vendor_owner'
  | 'vendor_administrator'
  | 'delivery_agent'
  | 'customer';

export type ActorMembership = Readonly<{
  id: string;
  vendorId: string;
  vendorName: string;
  role: VendorRole;
  status: 'invited' | 'active' | 'ended';
}>;

export type Actor = Readonly<{
  userId: string;
  sessionId: string;
  displayName: string;
  authenticationMethod: 'phone_otp' | 'administrator_mfa';
  platformRoles: readonly PlatformRole[];
  memberships: readonly ActorMembership[];
}>;

export type RequestContext = Readonly<{
  correlationId: string;
  actor?: Actor;
  deviceId?: string;
  ipHash?: string;
}>;

type RequestContextCell = { current: RequestContext };

@Injectable()
export class RequestContextStore {
  private readonly storage = new AsyncLocalStorage<RequestContextCell>();

  run<T>(context: RequestContext, callback: () => T): T {
    return this.storage.run({ current: context }, callback);
  }

  get(): RequestContext | undefined {
    return this.storage.getStore()?.current;
  }

  replaceActor(actor: Actor): void {
    const cell = this.storage.getStore();
    if (!cell) throw new Error('Request context is unavailable');
    cell.current = { ...cell.current, actor };
  }

  require(): RequestContext {
    const context = this.get();
    if (!context) throw new Error('Request context is unavailable');
    return context;
  }

  requireActor(): Actor {
    const actor = this.require().actor;
    if (!actor) {
      throw new ApplicationError(
        'UNAUTHENTICATED',
        'Authentication is required',
        401,
      );
    }
    return actor;
  }
}

export const requestContextStore = new RequestContextStore();
