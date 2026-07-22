import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { DefaultDeliveryCorrectionService, DeliveryCorrectionService } from './application/delivery-correction.service.js';
import { DeliveryQueryService } from './application/delivery-query.service.js';
import { DeliveryFoundationModule } from './delivery-foundation.module.js';
import { CustomerDeliveryController } from './http/customer-delivery.controller.js';
import { VendorDeliveryController } from './http/vendor-delivery.controller.js';

@Module({
  imports: [AuditModule, AuthorizationModule, CustomersModule, DeliveryFoundationModule, NotificationsModule, PricingModule],
  controllers: [VendorDeliveryController, CustomerDeliveryController],
  providers: [DeliveryQueryService, DefaultDeliveryCorrectionService, { provide: DeliveryCorrectionService, useExisting: DefaultDeliveryCorrectionService }],
})
export class DeliveryModule {}
