import { Module } from '@nestjs/common';

import { validateAuthenticationEnvironment } from '../bootstrap/auth-environment.js';
import { DatabaseModule } from '../database/database.module.js';
import {
  AuthenticationService,
  PrismaAuthenticationService,
} from './application/authentication.service.js';
import { OtpDelivery } from './application/otp-delivery.js';
import { LocalOtpDelivery } from './infrastructure/local-otp.delivery.js';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    PrismaIdentityStore,
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
  ],
  exports: [AuthenticationService],
})
export class IdentityModule {}
