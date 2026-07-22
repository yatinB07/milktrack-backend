import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DeliveryQueryService } from './application/delivery-query.service.js';
import { DeliveryFoundationModule } from './delivery-foundation.module.js';
import { CustomerDeliveryController } from './http/customer-delivery.controller.js';
import { VendorDeliveryController } from './http/vendor-delivery.controller.js';

@Module({
  imports: [AuthorizationModule, CustomersModule, DeliveryFoundationModule],
  controllers: [VendorDeliveryController, CustomerDeliveryController],
  providers: [DeliveryQueryService],
})
export class DeliveryModule {}
