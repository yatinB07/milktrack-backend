import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { CatalogService } from '../application/catalog.service.js';
import { CatalogPageQueryDto, CreateUnitRequestDto, ReasonRequestDto, RenameUnitRequestDto, UnitListResponseDto, UnitResponseDto, toUnitResponse } from './catalog.dto.js';

@ApiTags('Vendor catalog units') @ApiBearerAuth('opaqueBearer')
@ApiResponse({ status: 400, type: ApiErrorResponseDto }) @ApiResponse({ status: 401, type: ApiErrorResponseDto })
@ApiResponse({ status: 403, type: ApiErrorResponseDto }) @ApiResponse({ status: 404, type: ApiErrorResponseDto })
@ApiResponse({ status: 409, type: ApiErrorResponseDto }) @ApiResponse({ status: 503, type: ApiErrorResponseDto })
@UseGuards(ActorGuard) @Controller('vendors/:vendorId/units')
export class UnitController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}
  @Get() @ApiResponse({ status: 200, type: UnitListResponseDto }) async list(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Query() query: CatalogPageQueryDto) {
    const page = await this.catalog.listUnits(requestContextStore.requireActor(), vendorId, query);
    return { items: page.items.map(toUnitResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  @Post() @ApiResponse({ status: 201, type: UnitResponseDto }) async create(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Body() body: CreateUnitRequestDto) {
    return toUnitResponse(await this.catalog.createUnit(requestContextStore.requireActor(), vendorId, body));
  }
  @Get(':unitId') @ApiResponse({ status: 200, type: UnitResponseDto }) async get(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('unitId', ParseUUIDPipe) unitId: string) {
    return toUnitResponse(await this.catalog.getUnit(requestContextStore.requireActor(), vendorId, unitId));
  }
  @Patch(':unitId') @ApiResponse({ status: 200, type: UnitResponseDto }) async rename(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('unitId', ParseUUIDPipe) unitId: string, @Body() body: RenameUnitRequestDto) {
    return toUnitResponse(await this.catalog.renameUnit(requestContextStore.requireActor(), vendorId, unitId, body));
  }
  @Post(':unitId/deactivate') @HttpCode(200) @ApiResponse({ status: 200, type: UnitResponseDto }) async deactivate(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('unitId', ParseUUIDPipe) unitId: string, @Body() body: ReasonRequestDto) {
    return toUnitResponse(await this.catalog.deactivateUnit(requestContextStore.requireActor(), vendorId, unitId, body));
  }
  @Post(':unitId/reactivate') @HttpCode(200) @ApiResponse({ status: 200, type: UnitResponseDto }) async reactivate(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('unitId', ParseUUIDPipe) unitId: string, @Body() body: ReasonRequestDto) {
    return toUnitResponse(await this.catalog.reactivateUnit(requestContextStore.requireActor(), vendorId, unitId, body));
  }
}
for (const [key, types] of [['list', [String, CatalogPageQueryDto]], ['create', [String, CreateUnitRequestDto]], ['get', [String, String]], ['rename', [String, String, RenameUnitRequestDto]], ['deactivate', [String, String, ReasonRequestDto]], ['reactivate', [String, String, ReasonRequestDto]]] as const)
  Reflect.defineMetadata('design:paramtypes', types, UnitController.prototype, key);
