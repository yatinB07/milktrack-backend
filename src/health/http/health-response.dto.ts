import { ApiProperty } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ enum: ['ok'] })
  readonly status: 'ok';

  @ApiProperty({ enum: ['milktrack-backend'] })
  readonly service: 'milktrack-backend';

  @ApiProperty({ type: String, format: 'date-time' })
  readonly timestamp: string;

  constructor(
    status: 'ok',
    service: 'milktrack-backend',
    timestamp: string,
  ) {
    this.status = status;
    this.service = service;
    this.timestamp = timestamp;
  }
}
