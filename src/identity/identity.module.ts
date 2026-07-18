import { Module } from '@nestjs/common';

import { ActorGuard } from '../authorization/http/actor.guard.js';
import { validateAuthenticationEnvironment } from '../bootstrap/auth-environment.js';
import {
  RequestContextStore,
  requestContextStore,
} from '../common/context/request-context.js';
import { DatabaseModule } from '../database/database.module.js';
import {
  AuthenticationService,
  PrismaAuthenticationService,
} from './application/authentication.service.js';
import { OtpDelivery } from './application/otp-delivery.js';
import {
  DefaultUserLifecycleService,
  UserLifecycleService,
  UserLifecycleStore,
} from './application/user-lifecycle.service.js';
import { LocalOtpDelivery } from './infrastructure/local-otp.delivery.js';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store.js';
import { PrismaUserLifecycleStore } from './infrastructure/prisma-user-lifecycle.store.js';
import { AuthController } from './http/auth.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [
    { provide: RequestContextStore, useValue: requestContextStore },
    PrismaIdentityStore,
    PrismaUserLifecycleStore,
    { provide: UserLifecycleStore, useExisting: PrismaUserLifecycleStore },
    DefaultUserLifecycleService,
    {
      provide: UserLifecycleService,
      useExisting: DefaultUserLifecycleService,
    },
    {
      provide: OtpDelivery,
      useFactory: () =>
        new LocalOtpDelivery({
          appEnv: process.env.APP_ENV,
          provider: process.env.OTP_PROVIDER,
        }),
    },
    {
      provide: AuthenticationService,
      inject: [PrismaIdentityStore, OtpDelivery],
      useFactory: (store: PrismaIdentityStore, delivery: OtpDelivery) => {
        const keys = validateAuthenticationEnvironment(process.env);
        return new PrismaAuthenticationService(store, delivery, {
          ...keys,
          sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS),
        });
      },
    },
    ActorGuard,
  ],
  exports: [AuthenticationService, UserLifecycleService],
})
export class IdentityModule {}
