import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { PricingService } from '../application/pricing.service.js';
import { ClosePriceRequestDto, CreatePriceRequestDto, PriceListResponseDto, PricePageQueryDto, PriceResponseDto, toPriceResponse } from './pricing.dto.js';

@ApiTags('Effective pricing') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@ApiResponse({ status: 400, type: ApiErrorResponseDto }) @ApiResponse({ status: 401, type: ApiErrorResponseDto }) @ApiResponse({ status: 403, type: ApiErrorResponseDto }) @ApiResponse({ status: 404, type: ApiErrorResponseDto }) @ApiResponse({ status: 409, type: ApiErrorResponseDto })
@ApiResponse({ status: 503, type: ApiErrorResponseDto })
@Controller('vendors/:vendorId/global-prices')
export class GlobalPriceController {
  constructor(@Inject(PricingService) private readonly pricing: PricingService) {}
  @Get() @ApiResponse({ status: 200, type: PriceListResponseDto }) async list(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Query() query: PricePageQueryDto) { const page = await this.pricing.listGlobals(requestContextStore.requireActor(), vendorId, query); return { items: page.items.map(toPriceResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }; }
  @Post() @ApiResponse({ status: 201, type: PriceResponseDto }) async create(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Body() body: CreatePriceRequestDto) { return toPriceResponse(await this.pricing.createGlobal(requestContextStore.requireActor(), vendorId, body)); }
  @Get(':priceId') @ApiResponse({ status: 200, type: PriceResponseDto }) async get(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('priceId', ParseUUIDPipe) priceId: string) { return toPriceResponse(await this.pricing.getGlobal(requestContextStore.requireActor(), vendorId, priceId)); }
  @Post(':priceId/close') @HttpCode(200) @ApiResponse({ status: 200, type: PriceResponseDto }) async close(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('priceId', ParseUUIDPipe) priceId: string, @Body() body: ClosePriceRequestDto) { return toPriceResponse(await this.pricing.closeGlobal(requestContextStore.requireActor(), vendorId, priceId, body)); }
}
for (const [key, types] of [['list', [String, PricePageQueryDto]], ['create', [String, CreatePriceRequestDto]], ['get', [String, String]], ['close', [String, String, ClosePriceRequestDto]]] as const) Reflect.defineMetadata('design:paramtypes', types, GlobalPriceController.prototype, key);
