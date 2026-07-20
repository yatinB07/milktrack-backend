import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { PricingService } from '../application/pricing.service.js';
import { ClosePriceRequestDto, CreateOverrideRequestDto, OverrideListResponseDto, OverrideResponseDto, PricePageQueryDto, toOverrideResponse } from './pricing.dto.js';

@ApiTags('Customer price overrides') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@ApiResponse({ status: 400, type: ApiErrorResponseDto }) @ApiResponse({ status: 401, type: ApiErrorResponseDto }) @ApiResponse({ status: 403, type: ApiErrorResponseDto }) @ApiResponse({ status: 404, type: ApiErrorResponseDto }) @ApiResponse({ status: 409, type: ApiErrorResponseDto })
@ApiResponse({ status: 503, type: ApiErrorResponseDto })
@Controller('vendors/:vendorId/households/:householdId/price-overrides')
export class PriceOverrideController {
  constructor(@Inject(PricingService) private readonly pricing: PricingService) {}
  @Get() @ApiResponse({ status: 200, type: OverrideListResponseDto }) async list(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('householdId', ParseUUIDPipe) householdId: string, @Query() query: PricePageQueryDto) { const page = await this.pricing.listOverrides(requestContextStore.requireActor(), vendorId, householdId, query); return { items: page.items.map(toOverrideResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }; }
  @Post() @ApiResponse({ status: 201, type: OverrideResponseDto }) async create(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('householdId', ParseUUIDPipe) householdId: string, @Body() body: CreateOverrideRequestDto) { return toOverrideResponse(await this.pricing.createOverride(requestContextStore.requireActor(), vendorId, householdId, body)); }
  @Get(':overrideId') @ApiResponse({ status: 200, type: OverrideResponseDto }) async get(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('householdId', ParseUUIDPipe) householdId: string, @Param('overrideId', ParseUUIDPipe) overrideId: string) { return toOverrideResponse(await this.pricing.getOverride(requestContextStore.requireActor(), vendorId, householdId, overrideId)); }
  @Post(':overrideId/close') @HttpCode(200) @ApiResponse({ status: 200, type: OverrideResponseDto }) async close(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('householdId', ParseUUIDPipe) householdId: string, @Param('overrideId', ParseUUIDPipe) overrideId: string, @Body() body: ClosePriceRequestDto) { return toOverrideResponse(await this.pricing.closeOverride(requestContextStore.requireActor(), vendorId, householdId, overrideId, body)); }
}
for (const [key, types] of [['list', [String, String, PricePageQueryDto]], ['create', [String, String, CreateOverrideRequestDto]], ['get', [String, String, String]], ['close', [String, String, String, ClosePriceRequestDto]]] as const) Reflect.defineMetadata('design:paramtypes', types, PriceOverrideController.prototype, key);
