import 'reflect-metadata';

import { Body, Controller, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt } from 'class-validator';

export class ValidationTestRequestDto {
  @Type(() => Number)
  @IsInt()
  count!: number;
}

@Controller('validation-test')
export class ValidationTestController {
  @Post()
  validate(@Body() request: ValidationTestRequestDto): ValidationTestRequestDto {
    return request;
  }
}

// tsx does not emit decorator metadata, so expose the type consumed by Nest's global pipe.
Reflect.defineMetadata(
  'design:paramtypes',
  [ValidationTestRequestDto],
  ValidationTestController.prototype,
  'validate',
);
