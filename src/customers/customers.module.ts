import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AuthorizationModule } from "../authorization/authorization.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import {
  HouseholdService,
  PrismaHouseholdService,
} from "./application/household.service.js";
import {
  CustomerHouseholdController,
  HouseholdController,
} from "./http/household.controller.js";
import { PrismaHouseholdStore } from "./infrastructure/prisma-household.store.js";
@Module({
  imports: [
    AuditModule,
    AuthorizationModule,
    DatabaseModule,
    IdentityModule,
    MembershipsModule,
  ],
  controllers: [HouseholdController, CustomerHouseholdController],
  providers: [
    PrismaHouseholdStore,
    PrismaHouseholdService,
    { provide: HouseholdService, useExisting: PrismaHouseholdService },
  ],
})
export class CustomersModule {}
