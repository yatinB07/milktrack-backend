import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { validateAuthenticationEnvironment } from '../bootstrap/auth-environment.js';
import {
  MembershipService,
  PrismaMembershipService,
} from './application/membership.service.js';
import { PrismaMembershipStore } from './infrastructure/prisma-membership.store.js';
import {
  DefaultOwnerEnrollmentService,
  OwnerEnrollmentService,
  OwnerEnrollmentStore,
} from './application/owner-enrollment.service.js';
import { OwnerEnrollmentDelivery } from './application/owner-enrollment.delivery.js';
import {
  DefaultVendorOwnerOnboardingService,
  VendorOwnerOnboardingService,
  VendorOwnerOnboardingStore,
} from './application/vendor-owner-onboarding.service.js';
import { PrismaVendorOwnerOnboardingStore } from './infrastructure/prisma-vendor-owner-onboarding.store.js';
import { PrismaOwnerEnrollmentStore } from './infrastructure/prisma-owner-enrollment.store.js';
import { LocalOwnerEnrollmentDelivery } from './infrastructure/local-owner-enrollment.delivery.js';
import {
  MembershipController,
  OwnerEnrollmentController,
  UserLifecycleController,
  VendorOwnerOnboardingController,
} from './http/membership.controller.js';

@Module({
  imports: [AuditModule, AuthorizationModule, DatabaseModule, IdentityModule],
  controllers: [
    MembershipController,
    OwnerEnrollmentController,
    UserLifecycleController,
    VendorOwnerOnboardingController,
  ],
  providers: [
    PrismaMembershipStore,
    PrismaOwnerEnrollmentStore,
    { provide: OwnerEnrollmentStore, useExisting: PrismaOwnerEnrollmentStore },
    {
      provide: LocalOwnerEnrollmentDelivery,
      useFactory: () =>
        new LocalOwnerEnrollmentDelivery(process.env.APP_ENV, process.env.OTP_PROVIDER),
    },
    {
      provide: OwnerEnrollmentDelivery,
      useExisting: LocalOwnerEnrollmentDelivery,
    },
    {
      provide: DefaultOwnerEnrollmentService,
      inject: [PrismaOwnerEnrollmentStore],
      useFactory: (store: PrismaOwnerEnrollmentStore) => {
        const keys = validateAuthenticationEnvironment(process.env);
        return new DefaultOwnerEnrollmentService(store, keys);
      },
    },
    {
      provide: OwnerEnrollmentService,
      useExisting: DefaultOwnerEnrollmentService,
    },
    PrismaVendorOwnerOnboardingStore,
    {
      provide: VendorOwnerOnboardingStore,
      useExisting: PrismaVendorOwnerOnboardingStore,
    },
    {
      provide: DefaultVendorOwnerOnboardingService,
      inject: [PrismaVendorOwnerOnboardingStore, OwnerEnrollmentDelivery],
      useFactory: (
        store: PrismaVendorOwnerOnboardingStore,
        delivery: OwnerEnrollmentDelivery,
      ) => {
        const keys = validateAuthenticationEnvironment(process.env);
        return new DefaultVendorOwnerOnboardingService(store, delivery, keys);
      },
    },
    { provide: VendorOwnerOnboardingService, useExisting: DefaultVendorOwnerOnboardingService },
    PrismaMembershipService,
    { provide: MembershipService, useExisting: PrismaMembershipService },
  ],
})
export class MembershipsModule {}
