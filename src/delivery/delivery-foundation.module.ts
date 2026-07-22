import { Module } from '@nestjs/common';

import { DefaultDeliveryLeaveProjection, DeliveryLeaveProjection } from './application/delivery-leave.projection.js';
import { DeliveryStore } from './application/delivery.store.js';
import { PrismaDeliveryStore } from './infrastructure/prisma-delivery.store.js';

@Module({
  providers: [
    PrismaDeliveryStore,
    { provide: DeliveryStore, useExisting: PrismaDeliveryStore },
    DefaultDeliveryLeaveProjection,
    { provide: DeliveryLeaveProjection, useExisting: DefaultDeliveryLeaveProjection },
  ],
  exports: [DeliveryStore, DeliveryLeaveProjection],
})
export class DeliveryFoundationModule {}
