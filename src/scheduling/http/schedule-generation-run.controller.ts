import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { ScheduleGenerationRunService } from '../application/schedule-generation-run.service.js';
import { GenerateManualScheduleRunRequestDto, ScheduleGenerationRunListResponseDto, ScheduleGenerationRunQueryDto, ScheduleGenerationRunResponseDto, toScheduleGenerationRunResponse } from './schedule-generation-run.dto.js';

@ApiTags('Schedule generation runs') @ApiBearerAuth('opaqueBearer')
@UseGuards(ActorGuard) @Controller('vendors/:vendorId/schedule-generation-runs')
export class ScheduleGenerationRunController {
  constructor(@Inject(ScheduleGenerationRunService) private readonly runs: ScheduleGenerationRunService) {}

  @Post('manual') @HttpCode(200) @ApiResponse({ status: 200, type: ScheduleGenerationRunResponseDto })
  async manual(
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
    @Body() body: GenerateManualScheduleRunRequestDto,
  ): Promise<ScheduleGenerationRunResponseDto> {
    return toScheduleGenerationRunResponse(await this.runs.generateManual(requestContextStore.requireActor(), vendorId, body));
  }

  @Get() @ApiResponse({ status: 200, type: ScheduleGenerationRunListResponseDto })
  async list(
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
    @Query() query: ScheduleGenerationRunQueryDto,
  ): Promise<ScheduleGenerationRunListResponseDto> {
    const page = await this.runs.list(requestContextStore.requireActor(), vendorId, query);
    return { items: page.items.map(toScheduleGenerationRunResponse), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
  }
}

for (const status of [400, 401, 403, 404, 409, 503]) ApiResponse({ status, type: ApiErrorResponseDto })(ScheduleGenerationRunController);
for (const [key, types] of [['manual', [String, GenerateManualScheduleRunRequestDto]], ['list', [String, ScheduleGenerationRunQueryDto]]] as const)
  Reflect.defineMetadata('design:paramtypes', types, ScheduleGenerationRunController.prototype, key);
