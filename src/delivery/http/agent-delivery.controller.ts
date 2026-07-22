import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { AgentStopOutcomeService } from '../application/agent-stop-outcome.service.js';
import { AgentStopOutcomeRequestDto, AgentStopOutcomeResponseDto, DeliveredAgentStopOutcomeDto, DeliveredStopOutcomeItemDto, MissedAgentStopOutcomeDto, NonDeliveredStopOutcomeItemDto, SkippedAgentStopOutcomeDto, toAgentStopOutcomeResponse } from './delivery.dto.js';

const coordinatePair = {
  oneOf: [
    { required: ['latitude', 'longitude'] },
    { not: { anyOf: [{ required: ['latitude'] }, { required: ['longitude'] }] } },
  ],
};
const otherRequiresNote = (reasons: readonly string[]) => ({
  oneOf: [
    { properties: { reasonCode: { enum: ['other'] } }, required: ['note'] },
    { properties: { reasonCode: { enum: reasons.filter((reason) => reason !== 'other') } } },
  ],
});

@ApiTags('Agent deliveries') @ApiBearerAuth('opaqueBearer')
@ApiExtraModels(AgentStopOutcomeRequestDto, DeliveredAgentStopOutcomeDto, SkippedAgentStopOutcomeDto, MissedAgentStopOutcomeDto, DeliveredStopOutcomeItemDto, NonDeliveredStopOutcomeItemDto)
@UseGuards(ActorGuard)
@Controller('agent/vendors/:vendorId/route-stops/:routeStopId/outcomes')
export class AgentDeliveryController {
  constructor(@Inject(AgentStopOutcomeService) private readonly outcomes: AgentStopOutcomeService) {}

  @Post() @HttpCode(201)
  @ApiBody({ schema: {
    title: 'AgentStopOutcomeRequestDto',
    oneOf: [
      { allOf: [{ $ref: getSchemaPath(DeliveredAgentStopOutcomeDto) }, { not: { anyOf: ['reasonCode', 'note', 'latitude', 'longitude'].map((property) => ({ required: [property] })) } }] },
      { allOf: [{ $ref: getSchemaPath(SkippedAgentStopOutcomeDto) }, coordinatePair, otherRequiresNote(['customer_on_leave', 'customer_unavailable', 'customer_requested_skip_at_door', 'other'])] },
      { allOf: [{ $ref: getSchemaPath(MissedAgentStopOutcomeDto) }, coordinatePair, otherRequiresNote(['address_not_found', 'access_blocked', 'product_unavailable', 'vehicle_or_route_issue', 'safety_issue', 'other'])] },
    ],
    discriminator: { propertyName: 'outcome' },
  } })
  @ApiResponse({ status: 201, type: AgentStopOutcomeResponseDto })
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
