import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

import { HealthService } from './health.service.js';
import { HealthResponseDto } from './http/health-response.dto.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  @ApiOkResponse({ type: HealthResponseDto })
  getHealth(): HealthResponseDto {
    const health = this.healthService.getHealth();
    return new HealthResponseDto(
      health.status,
      health.service,
      health.timestamp,
    );
  }
}
