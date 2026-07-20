import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { RouteService } from '../application/route.service.js';
import { CreateRouteRequestDto, RenameRouteRequestDto, ReplaceRouteStopsRequestDto, RouteListResponseDto, RoutePageQueryDto, RouteResponseDto, RouteStopsResponseDto, RouteStopsQueryDto, RouteVersionReasonRequestDto, toRouteResponse } from './route.dto.js';

@ApiTags('Vendor routes') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@Controller('vendors/:vendorId/routes')
export class RouteController {
  constructor(@Inject(RouteService) private readonly routes: RouteService) {}
  @Get() @ApiResponse({ status: 200, type: RouteListResponseDto }) async list(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Query() query: RoutePageQueryDto) { const page = await this.routes.list(requestContextStore.requireActor(), vendorId, query); return { items: page.items.map(toRouteResponse), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }; }
  @Post() @ApiResponse({ status: 201, type: RouteResponseDto }) async create(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Body() body: CreateRouteRequestDto) { return toRouteResponse(await this.routes.create(requestContextStore.requireActor(), vendorId, body)); }
  @Get(':routeId') @ApiResponse({ status: 200, type: RouteResponseDto }) async get(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('routeId', ParseUUIDPipe) routeId: string) { return toRouteResponse(await this.routes.get(requestContextStore.requireActor(), vendorId, routeId)); }
  @Get(':routeId/stops') @ApiResponse({ status: 200, type: RouteStopsResponseDto }) listStops(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('routeId', ParseUUIDPipe) routeId: string, @Query() query: RouteStopsQueryDto) { return this.routes.listStops(requestContextStore.requireActor(), vendorId, routeId, query); }
  @Post(':routeId/stops/replace') @HttpCode(200) @ApiResponse({ status: 200, type: RouteStopsResponseDto }) replaceStops(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('routeId', ParseUUIDPipe) routeId: string, @Body() body: ReplaceRouteStopsRequestDto) { return this.routes.replaceStops(requestContextStore.requireActor(), vendorId, routeId, body); }
  @Patch(':routeId') @ApiResponse({ status: 200, type: RouteResponseDto }) async rename(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('routeId', ParseUUIDPipe) routeId: string, @Body() body: RenameRouteRequestDto) { return toRouteResponse(await this.routes.rename(requestContextStore.requireActor(), vendorId, routeId, body)); }
  @Post(':routeId/deactivate') @HttpCode(200) @ApiResponse({ status: 200, type: RouteResponseDto }) deactivate(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('routeId', ParseUUIDPipe) routeId: string, @Body() body: RouteVersionReasonRequestDto) { return this.change('deactivate', vendorId, routeId, body); }
  @Post(':routeId/reactivate') @HttpCode(200) @ApiResponse({ status: 200, type: RouteResponseDto }) reactivate(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('routeId', ParseUUIDPipe) routeId: string, @Body() body: RouteVersionReasonRequestDto) { return this.change('reactivate', vendorId, routeId, body); }
  @Delete(':routeId') @HttpCode(204) async softDelete(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('routeId', ParseUUIDPipe) routeId: string, @Body() body: RouteVersionReasonRequestDto) { await this.routes.softDelete(requestContextStore.requireActor(), vendorId, routeId, body); }
  @Post(':routeId/restore') @HttpCode(200) @ApiResponse({ status: 200, type: RouteResponseDto }) restore(@Param('vendorId', ParseUUIDPipe) vendorId: string, @Param('routeId', ParseUUIDPipe) routeId: string, @Body() body: RouteVersionReasonRequestDto) { return this.change('restore', vendorId, routeId, body); }
  private async change(operation: 'deactivate' | 'reactivate' | 'restore', vendorId: string, routeId: string, body: RouteVersionReasonRequestDto) { return toRouteResponse(await this.routes[operation](requestContextStore.requireActor(), vendorId, routeId, body)); }
}

for (const status of [400, 401, 403, 404, 409, 503]) ApiResponse({ status, type: ApiErrorResponseDto })(RouteController);
for (const [key, types] of [['list', [String, RoutePageQueryDto]], ['create', [String, CreateRouteRequestDto]], ['get', [String, String]], ['listStops', [String, String, RouteStopsQueryDto]], ['replaceStops', [String, String, ReplaceRouteStopsRequestDto]], ['rename', [String, String, RenameRouteRequestDto]], ['deactivate', [String, String, RouteVersionReasonRequestDto]], ['reactivate', [String, String, RouteVersionReasonRequestDto]], ['softDelete', [String, String, RouteVersionReasonRequestDto]], ['restore', [String, String, RouteVersionReasonRequestDto]]] as const)
  Reflect.defineMetadata('design:paramtypes', types, RouteController.prototype, key);
