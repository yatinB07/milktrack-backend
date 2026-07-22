import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { DeliveryQueryService } from '../application/delivery-query.service.js';
import { CustomerDeliveryDetailResponseDto, DeliveryListResponseDto, DeliveryPageQueryDto, toCustomerDeliveryDetailResponse, toDeliverySummaryResponse } from './delivery.dto.js';

@ApiTags('Customer deliveries') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@Controller('customer/vendors/:vendorId/households/:householdId/deliveries')
export class CustomerDeliveryController {
  constructor(@Inject(DeliveryQueryService) private readonly deliveries: DeliveryQueryService) {}

  @Get() @ApiResponse({ status: 200, type: DeliveryListResponseDto }) async list(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('householdId', new ParseUUIDPipe({ version: '4' })) householdId: string, @Query() query: DeliveryPageQueryDto) {
    const page = await this.deliveries.listCustomer(requestContextStore.requireActor(), vendorId, householdId, query);
    return { items: page.items.map(toDeliverySummaryResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  @Get(':deliveryId') @ApiResponse({ status: 200, type: CustomerDeliveryDetailResponseDto }) get(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('householdId', new ParseUUIDPipe({ version: '4' })) householdId: string, @Param('deliveryId', new ParseUUIDPipe({ version: '4' })) deliveryId: string) {
    return this.deliveries.getCustomerDetail(requestContextStore.requireActor(), vendorId, householdId, deliveryId).then(toCustomerDeliveryDetailResponse);
  }
}

for (const status of [400, 401, 403, 404, 409, 503]) ApiResponse({ status, type: ApiErrorResponseDto })(CustomerDeliveryController);
Reflect.defineMetadata('design:paramtypes', [String, String, DeliveryPageQueryDto], CustomerDeliveryController.prototype, 'list');
Reflect.defineMetadata('design:paramtypes', [String, String, String], CustomerDeliveryController.prototype, 'get');
