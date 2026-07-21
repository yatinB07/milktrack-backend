import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { LifecycleQueryDto } from '../../common/http/record-lifecycle.dto.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { CatalogService } from '../application/catalog.service.js';
import { CreateProductRequestDto, ProductListResponseDto, ProductPageQueryDto, ProductResponseDto, RestoreProductRequestDto, UpdateProductRequestDto, VersionedReasonRequestDto, toProductResponse } from './catalog.dto.js';

@ApiTags('Vendor catalog products') @ApiBearerAuth('opaqueBearer')
@ApiResponse({ status: 400, type: ApiErrorResponseDto }) @ApiResponse({ status: 401, type: ApiErrorResponseDto })
@ApiResponse({ status: 403, type: ApiErrorResponseDto }) @ApiResponse({ status: 404, type: ApiErrorResponseDto })
@ApiResponse({ status: 409, type: ApiErrorResponseDto }) @ApiResponse({ status: 503, type: ApiErrorResponseDto })
@UseGuards(ActorGuard) @Controller('vendors/:vendorId/products')
export class ProductController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}
  @Get() @ApiOperation({ summary: 'List products in the selected lifecycle' }) @ApiResponse({ status: 200, type: ProductListResponseDto }) async list(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Query() query: ProductPageQueryDto) {
    const page = await this.catalog.listProducts(requestContextStore.requireActor(), vendorId, { ...query, lifecycle: query.lifecycle ?? 'current' });
    return { items: page.items.map(toProductResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  @Post() @ApiResponse({ status: 201, type: ProductResponseDto }) async create(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Body() body: CreateProductRequestDto) {
    return toProductResponse(await this.catalog.createProduct(requestContextStore.requireActor(), vendorId, body));
  }
  @Get(':productId') @ApiOperation({ summary: 'Read a product in the selected lifecycle' }) @ApiResponse({ status: 200, type: ProductResponseDto }) async get(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('productId', ParseUUIDPipe) productId: string, @Query() query: LifecycleQueryDto) {
    return toProductResponse(await this.catalog.getProduct(requestContextStore.requireActor(), vendorId, productId, query.lifecycle ?? 'current'));
  }
  @Patch(':productId') @ApiResponse({ status: 200, type: ProductResponseDto }) async update(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('productId', ParseUUIDPipe) productId: string, @Body() body: UpdateProductRequestDto) {
    return toProductResponse(await this.catalog.updateProduct(requestContextStore.requireActor(), vendorId, productId, body));
  }
  @Delete(':productId') @HttpCode(204) async remove(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('productId', ParseUUIDPipe) productId: string, @Body() body: VersionedReasonRequestDto) {
    await this.catalog.deleteProduct(requestContextStore.requireActor(), vendorId, productId, body);
  }
  @Post(':productId/restore') @HttpCode(200) @ApiResponse({ status: 200, type: ProductResponseDto }) async restore(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('productId', ParseUUIDPipe) productId: string, @Body() body: RestoreProductRequestDto) {
    return toProductResponse(await this.catalog.restoreProduct(requestContextStore.requireActor(), vendorId, productId, body));
  }
}
for (const [key, types] of [['list', [String, ProductPageQueryDto]], ['create', [String, CreateProductRequestDto]], ['get', [String, String, LifecycleQueryDto]], ['update', [String, String, UpdateProductRequestDto]], ['remove', [String, String, VersionedReasonRequestDto]], ['restore', [String, String, RestoreProductRequestDto]]] as const)
  Reflect.defineMetadata('design:paramtypes', types, ProductController.prototype, key);
