import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { DeliveryQueryService } from '../application/delivery-query.service.js';
import { DeliveryCorrectionService } from '../application/delivery-correction.service.js';
import { CorrectScheduledDeliveryRequestDto, DeliveryListResponseDto, VendorDeliveryDetailResponseDto, VendorDeliveryPageQueryDto, toDeliverySummaryResponse, toVendorDeliveryDetailResponse } from './delivery.dto.js';

@ApiTags('Vendor deliveries') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@Controller('vendors/:vendorId/deliveries')
export class VendorDeliveryController {
  constructor(@Inject(DeliveryQueryService) private readonly deliveries: DeliveryQueryService, @Inject(DeliveryCorrectionService) private readonly corrections?: DeliveryCorrectionService) {}

  @Get() @ApiResponse({ status: 200, type: DeliveryListResponseDto }) async list(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Query() query: VendorDeliveryPageQueryDto) {
    const page = await this.deliveries.listVendor(requestContextStore.requireActor(), vendorId, query);
    return { items: page.items.map(toDeliverySummaryResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  @Get(':deliveryId') @ApiResponse({ status: 200, type: VendorDeliveryDetailResponseDto }) get(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('deliveryId', new ParseUUIDPipe({ version: '4' })) deliveryId: string) {
    return this.deliveries.getVendorDetail(requestContextStore.requireActor(), vendorId, deliveryId).then(toVendorDeliveryDetailResponse);
  }

  @Post(':scheduledDeliveryId/corrections') @HttpCode(200) @ApiResponse({ status: 200, type: VendorDeliveryDetailResponseDto }) correct(@Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string, @Param('scheduledDeliveryId', new ParseUUIDPipe({ version: '4' })) scheduledDeliveryId: string, @Body() body: CorrectScheduledDeliveryRequestDto) {
    const { expectedVersion, replacementOutcome, actualQuantity, reason } = body;
    return this.corrections!.correct(requestContextStore.requireActor(), vendorId, scheduledDeliveryId, { expectedVersion, replacementOutcome, ...(actualQuantity ? { actualQuantity } : {}), reason }).then(toVendorDeliveryDetailResponse);
  }
}

for (const status of [400, 401, 403, 404, 409, 503]) ApiResponse({ status, type: ApiErrorResponseDto })(VendorDeliveryController);
Reflect.defineMetadata('design:paramtypes', [String, VendorDeliveryPageQueryDto], VendorDeliveryController.prototype, 'list');
Reflect.defineMetadata('design:paramtypes', [String, String], VendorDeliveryController.prototype, 'get');
Reflect.defineMetadata('design:paramtypes', [String, String, CorrectScheduledDeliveryRequestDto], VendorDeliveryController.prototype, 'correct');
