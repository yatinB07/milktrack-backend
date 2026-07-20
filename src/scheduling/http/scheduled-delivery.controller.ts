import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { ScheduledDeliveryService } from '../application/scheduled-delivery.service.js';
import {
  AgentScheduledDeliveryQueryDto,
  ScheduledDeliveryListResponseDto,
  toScheduledDeliveryResponse,
} from './scheduled-delivery.dto.js';

@ApiTags('Agent scheduled deliveries')
@ApiBearerAuth('opaqueBearer')
@UseGuards(ActorGuard)
@Controller('agent/vendors/:vendorId/scheduled-deliveries')
export class AgentScheduledDeliveryController {
  constructor(@Inject(ScheduledDeliveryService) private readonly deliveries: ScheduledDeliveryService) {}

  @Get()
  @ApiResponse({ status: 200, type: ScheduledDeliveryListResponseDto })
  async list(
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
    @Query() query: AgentScheduledDeliveryQueryDto,
  ) {
    const page = await this.deliveries.listSelf(
      requestContextStore.requireActor(),
      vendorId,
      query.serviceDate,
      query,
    );
    return {
      items: page.items.map(toScheduledDeliveryResponse),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}

for (const status of [400, 401, 403, 404, 409, 503]) {
  ApiResponse({ status, type: ApiErrorResponseDto })(AgentScheduledDeliveryController);
}
Reflect.defineMetadata(
  'design:paramtypes',
  [String, AgentScheduledDeliveryQueryDto],
  AgentScheduledDeliveryController.prototype,
  'list',
);
