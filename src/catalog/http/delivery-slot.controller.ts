import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { CatalogService } from '../application/catalog.service.js';
import { CatalogPageQueryDto, CreateDeliverySlotRequestDto, DeliverySlotListResponseDto, DeliverySlotResponseDto, ReasonRequestDto, RenameDeliverySlotRequestDto, toDeliverySlotResponse } from './catalog.dto.js';

@ApiTags('Vendor delivery slots') @ApiBearerAuth('opaqueBearer')
@ApiResponse({ status: 400, type: ApiErrorResponseDto }) @ApiResponse({ status: 401, type: ApiErrorResponseDto })
@ApiResponse({ status: 403, type: ApiErrorResponseDto }) @ApiResponse({ status: 404, type: ApiErrorResponseDto })
@ApiResponse({ status: 409, type: ApiErrorResponseDto }) @ApiResponse({ status: 503, type: ApiErrorResponseDto })
@UseGuards(ActorGuard) @Controller('vendors/:vendorId/delivery-slots')
export class DeliverySlotController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}
  @Get() @ApiResponse({ status: 200, type: DeliverySlotListResponseDto }) async list(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Query() query: CatalogPageQueryDto) {
    const page = await this.catalog.listDeliverySlots(requestContextStore.requireActor(), vendorId, query);
    return { items: page.items.map(toDeliverySlotResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  @Post() @ApiResponse({ status: 201, type: DeliverySlotResponseDto }) async create(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Body() body: CreateDeliverySlotRequestDto) {
    return toDeliverySlotResponse(await this.catalog.createDeliverySlot(requestContextStore.requireActor(), vendorId, body));
  }
  @Get(':slotId') @ApiResponse({ status: 200, type: DeliverySlotResponseDto }) async get(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('slotId', ParseUUIDPipe) slotId: string) {
    return toDeliverySlotResponse(await this.catalog.getDeliverySlot(requestContextStore.requireActor(), vendorId, slotId));
  }
  @Patch(':slotId') @ApiResponse({ status: 200, type: DeliverySlotResponseDto }) async rename(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('slotId', ParseUUIDPipe) slotId: string, @Body() body: RenameDeliverySlotRequestDto) {
    return toDeliverySlotResponse(await this.catalog.renameDeliverySlot(requestContextStore.requireActor(), vendorId, slotId, body));
  }
  @Post(':slotId/deactivate') @HttpCode(200) @ApiResponse({ status: 200, type: DeliverySlotResponseDto }) async deactivate(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('slotId', ParseUUIDPipe) slotId: string, @Body() body: ReasonRequestDto) {
    return toDeliverySlotResponse(await this.catalog.deactivateDeliverySlot(requestContextStore.requireActor(), vendorId, slotId, body));
  }
  @Post(':slotId/reactivate') @HttpCode(200) @ApiResponse({ status: 200, type: DeliverySlotResponseDto }) async reactivate(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('slotId', ParseUUIDPipe) slotId: string, @Body() body: ReasonRequestDto) {
    return toDeliverySlotResponse(await this.catalog.reactivateDeliverySlot(requestContextStore.requireActor(), vendorId, slotId, body));
  }
}
for (const [key, types] of [['list', [String, CatalogPageQueryDto]], ['create', [String, CreateDeliverySlotRequestDto]], ['get', [String, String]], ['rename', [String, String, RenameDeliverySlotRequestDto]], ['deactivate', [String, String, ReasonRequestDto]], ['reactivate', [String, String, ReasonRequestDto]]] as const)
  Reflect.defineMetadata('design:paramtypes', types, DeliverySlotController.prototype, key);
