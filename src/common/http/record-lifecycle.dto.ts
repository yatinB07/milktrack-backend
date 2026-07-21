import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import {
  type RecordLifecycle,
  recordLifecycles,
} from '../application/record-lifecycle.js';

export class LifecycleQueryDto {
  @ApiPropertyOptional({ enum: recordLifecycles, default: 'current' })
  @IsOptional()
  @IsIn(recordLifecycles)
  lifecycle?: RecordLifecycle;
}
