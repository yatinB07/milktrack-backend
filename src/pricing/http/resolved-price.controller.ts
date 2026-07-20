import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { PricingService } from '../application/pricing.service.js';
import { CustomerResolvedPriceResponseDto, ResolvedPriceResponseDto, ResolveCustomerPriceQueryDto, ResolveVendorPriceQueryDto } from './pricing.dto.js';

@ApiTags('Resolved pricing') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@ApiResponse({ status: 400, type: ApiErrorResponseDto }) @ApiResponse({ status: 401, type: ApiErrorResponseDto }) @ApiResponse({ status: 403, type: ApiErrorResponseDto }) @ApiResponse({ status: 404, type: ApiErrorResponseDto })
@ApiResponse({ status: 409, type: ApiErrorResponseDto })
@ApiResponse({ status: 503, type: ApiErrorResponseDto })
@Controller('vendors/:vendorId/prices/resolved')
export class VendorResolvedPriceController {
  constructor(@Inject(PricingService) private readonly pricing: PricingService) {}
  @Get() @ApiResponse({ status: 200, type: ResolvedPriceResponseDto }) resolve(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Query() query: ResolveVendorPriceQueryDto) { return this.pricing.resolveVendor(requestContextStore.requireActor(), vendorId, query); }
}
Reflect.defineMetadata('design:paramtypes', [String, ResolveVendorPriceQueryDto], VendorResolvedPriceController.prototype, 'resolve');

@ApiTags('Customer resolved pricing') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@ApiResponse({ status: 400, type: ApiErrorResponseDto }) @ApiResponse({ status: 401, type: ApiErrorResponseDto }) @ApiResponse({ status: 403, type: ApiErrorResponseDto }) @ApiResponse({ status: 404, type: ApiErrorResponseDto })
@ApiResponse({ status: 409, type: ApiErrorResponseDto })
@ApiResponse({ status: 503, type: ApiErrorResponseDto })
@Controller('customer/vendors/:vendorId/households/:householdId/prices/resolved')
export class CustomerResolvedPriceController {
  constructor(@Inject(PricingService) private readonly pricing: PricingService) {}
  @Get() @ApiResponse({ status: 200, type: CustomerResolvedPriceResponseDto }) resolve(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('householdId', ParseUUIDPipe) householdId: string, @Query() query: ResolveCustomerPriceQueryDto) { return this.pricing.resolveCustomer(requestContextStore.requireActor(), vendorId, householdId, query); }
}
Reflect.defineMetadata('design:paramtypes', [String, String, ResolveCustomerPriceQueryDto], CustomerResolvedPriceController.prototype, 'resolve');
