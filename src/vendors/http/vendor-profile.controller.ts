import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApiErrorResponseDto } from '../../common/errors/application-error.filter.js';
import { ActorGuard } from '../../identity/http/actor.guard.js';
import { VendorService } from '../application/vendor.service.js';
import { toVendorResponse, VendorResponseDto } from './vendor.dto.js';

@ApiTags('Vendor profile')
@ApiBearerAuth('opaqueBearer')
@UseGuards(ActorGuard)
@Controller('vendors/:vendorId/profile')
export class VendorProfileController {
  constructor(@Inject(VendorService) private readonly vendors: VendorService) {}

  @Get()
  @ApiOperation({ summary: 'Get the current vendor profile' })
  @ApiResponse({ status: 200, type: VendorResponseDto })
  @ApiResponse({ status: 400, type: ApiErrorResponseDto })
  @ApiResponse({ status: 401, type: ApiErrorResponseDto })
  @ApiResponse({ status: 403, type: ApiErrorResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorResponseDto })
  async getProfile(
    @Param('vendorId', new ParseUUIDPipe({ version: '4' })) vendorId: string,
  ): Promise<VendorResponseDto> {
    return toVendorResponse(
      await this.vendors.getProfile(requestContextStore.requireActor(), vendorId),
    );
  }
}

Reflect.defineMetadata(
  'design:paramtypes',
  [String],
  VendorProfileController.prototype,
  'getProfile',
);
