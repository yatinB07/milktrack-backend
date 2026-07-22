import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { VendorService } from '../application/vendor.service.js';
import { DeliveryPolicyResponseDto, toDeliveryPolicyResponse, UpdateDeliveryPolicyRequestDto } from './delivery-policy.dto.js';

@ApiTags('Vendor delivery policy') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@Controller('vendors/:vendorId/delivery-policy')
export class DeliveryPolicyController {
  constructor(@Inject(VendorService) private readonly vendors: VendorService) {}
  @Get() @ApiResponse({ status: 200, type: DeliveryPolicyResponseDto })
  async get(@Param('vendorId', ParseUUIDPipe) vendorId: string) { return toDeliveryPolicyResponse(await this.vendors.getDeliveryPolicy(requestContextStore.requireActor(), vendorId)); }
  @Patch() @ApiResponse({ status: 200, type: DeliveryPolicyResponseDto })
  async update(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Body() body: UpdateDeliveryPolicyRequestDto) { return toDeliveryPolicyResponse(await this.vendors.updateDeliveryPolicy(requestContextStore.requireActor(), vendorId, body)); }
}
for (const status of [400, 401, 403, 404, 409, 503]) ApiResponse({ status, type: ApiErrorResponseDto })(DeliveryPolicyController);
Reflect.defineMetadata('design:paramtypes', [String], DeliveryPolicyController.prototype, 'get');
Reflect.defineMetadata('design:paramtypes', [String, UpdateDeliveryPolicyRequestDto], DeliveryPolicyController.prototype, 'update');
