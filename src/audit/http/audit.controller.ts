import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { ActorGuard } from '../../identity/http/actor.guard.js';
import { RequestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ListAuditEvents } from '../application/list-audit-events.js';
import {
  AuditEventListResponseDto,
  ListAuditEventsQueryDto,
  toAuditEventResponse,
} from './audit.dto.js';

@ApiTags('Vendor audit')
@ApiBearerAuth('opaqueBearer')
@ApiExtraModels(ListAuditEventsQueryDto)
@UseGuards(ActorGuard)
@Controller('vendors/:vendorId/audit-events')
export class AuditController {
  constructor(
    @Inject(ListAuditEvents)
    private readonly audits: ListAuditEvents,
    @Inject(RequestContextStore)
    private readonly context: RequestContextStore,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List tenant audit events' })
  @ApiResponse({ status: 200, type: AuditEventListResponseDto })
  @ApiResponse({ status: 400, type: ApiErrorResponseDto })
  @ApiResponse({ status: 401, type: ApiErrorResponseDto })
  @ApiResponse({ status: 403, type: ApiErrorResponseDto })
  @ApiResponse({ status: 503, type: ApiErrorResponseDto })
  async list(
    @Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string,
    @Query() dto: ListAuditEventsQueryDto,
  ): Promise<AuditEventListResponseDto> {
    const page = await this.audits.execute(
      this.context.requireActor(),
      vendorId,
      {
        cursor: dto.cursor,
        limit: dto.limit,
        action: dto.action,
        entityType: dto.entityType,
        entityId: dto.entityId,
      },
    );
    return {
      items: page.items.map(toAuditEventResponse),
      ...(page.nextCursor === undefined
        ? {}
        : { nextCursor: page.nextCursor }),
    };
  }
}

// The integration suite runs TypeScript through tsx, which does not emit parameter metadata.
Reflect.defineMetadata(
  'design:paramtypes',
  [String, ListAuditEventsQueryDto],
  AuditController.prototype,
  'list',
);
