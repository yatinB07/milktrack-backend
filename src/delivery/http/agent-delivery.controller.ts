import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { AgentStopOutcomeService } from '../application/agent-stop-outcome.service.js';
import { AgentStopOutcomeRequestDto, AgentStopOutcomeResponseDto, toAgentStopOutcomeResponse } from './delivery.dto.js';

@ApiTags('Agent deliveries') @ApiBearerAuth('opaqueBearer') @UseGuards(ActorGuard)
@Controller('agent/vendors/:vendorId/route-stops/:routeStopId/outcomes')
export class AgentDeliveryController {
  constructor(@Inject(AgentStopOutcomeService) private readonly outcomes: AgentStopOutcomeService) {}

  @Post() @HttpCode(201) @ApiResponse({ status: 201, type: AgentStopOutcomeResponseDto })
  async record(
    @Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string,
    @Param('routeStopId', new ParseUUIDPipe({ version: '4' })) routeStopId: string,
    @Body() body: AgentStopOutcomeRequestDto,
  ) {
    return toAgentStopOutcomeResponse(await this.outcomes.record(requestContextStore.requireActor(), vendorId, routeStopId, body));
  }
}

for (const status of [400, 401, 403, 404, 409, 503]) ApiResponse({ status, type: ApiErrorResponseDto })(AgentDeliveryController);
Reflect.defineMetadata('design:paramtypes', [String, String, AgentStopOutcomeRequestDto], AgentDeliveryController.prototype, 'record');
