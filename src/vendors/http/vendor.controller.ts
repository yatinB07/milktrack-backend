import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { ActorGuard } from '../../authorization/http/actor.guard.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { VendorService } from '../application/vendor.service.js';
import {
  CreateVendorRequestDto,
  ListVendorsQueryDto,
  toVendorResponse,
  TransitionVendorRequestDto,
  VendorListResponseDto,
  VendorResponseDto,
} from './vendor.dto.js';

@ApiTags('Platform vendors')
@ApiBearerAuth('opaqueBearer')
@UseGuards(ActorGuard)
@Controller('platform/vendors')
export class VendorController {
  constructor(@Inject(VendorService) private readonly vendors: VendorService) {}

  @Post()
  @ApiOperation({ summary: 'Create a vendor' })
  @ApiResponse({ status: 201, type: VendorResponseDto })
  @ApiResponse({ status: 400, type: ApiErrorResponseDto })
  @ApiResponse({ status: 401, type: ApiErrorResponseDto })
  @ApiResponse({ status: 403, type: ApiErrorResponseDto })
  @ApiResponse({ status: 409, type: ApiErrorResponseDto })
  async create(@Body() dto: CreateVendorRequestDto): Promise<VendorResponseDto> {
    return toVendorResponse(
      await this.vendors.create(requestContextStore.requireActor(), {
        code: dto.code,
        legalName: dto.legalName,
        displayName: dto.displayName,
        timezone: dto.timezone,
        currency: dto.currency,
        skipCutoffMinutes: dto.skipCutoffMinutes,
        billingDay: dto.billingDay,
      }),
    );
  }

  @Get()
  @ApiOperation({ summary: 'List active vendor records' })
  @ApiResponse({ status: 200, type: VendorListResponseDto })
  @ApiResponse({ status: 400, type: ApiErrorResponseDto })
  @ApiResponse({ status: 401, type: ApiErrorResponseDto })
  @ApiResponse({ status: 403, type: ApiErrorResponseDto })
  async list(@Query() dto: ListVendorsQueryDto): Promise<VendorListResponseDto> {
    const page = await this.vendors.list(requestContextStore.requireActor(), {
      cursor: dto.cursor,
      limit: dto.limit,
      status: dto.status,
    });
    return {
      items: page.items.map(toVendorResponse),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an active vendor record' })
  @ApiResponse({ status: 200, type: VendorResponseDto })
  @ApiResponse({ status: 400, type: ApiErrorResponseDto })
  @ApiResponse({ status: 401, type: ApiErrorResponseDto })
  @ApiResponse({ status: 403, type: ApiErrorResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorResponseDto })
  async get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<VendorResponseDto> {
    return toVendorResponse(
      await this.vendors.get(requestContextStore.requireActor(), id),
    );
  }

  @Post(':id/transitions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Transition vendor lifecycle state' })
  @ApiResponse({ status: 200, type: VendorResponseDto })
  @ApiResponse({ status: 400, type: ApiErrorResponseDto })
  @ApiResponse({ status: 401, type: ApiErrorResponseDto })
  @ApiResponse({ status: 403, type: ApiErrorResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorResponseDto })
  @ApiResponse({ status: 409, type: ApiErrorResponseDto })
  async transition(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: TransitionVendorRequestDto,
  ): Promise<VendorResponseDto> {
    return toVendorResponse(
      await this.vendors.transition(requestContextStore.requireActor(), {
        vendorId: id,
        to: dto.to,
        reason: dto.reason,
        expectedVersion: dto.expectedVersion,
      }),
    );
  }
}

// The integration suite runs TypeScript through tsx, which does not emit parameter metadata.
Reflect.defineMetadata(
  'design:paramtypes',
  [CreateVendorRequestDto],
  VendorController.prototype,
  'create',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [ListVendorsQueryDto],
  VendorController.prototype,
  'list',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [String],
  VendorController.prototype,
  'get',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [String, TransitionVendorRequestDto],
  VendorController.prototype,
  'transition',
);
