import { randomUUID } from 'node:crypto';

import {
  ArgumentsHost,
  Catch,
  HttpException,
  type ExceptionFilter,
  Injectable,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { RequestContextStore } from '../context/request-context.js';
import { ApplicationError } from './application.error.js';

export class ApiErrorResponseDto {
  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  message!: string;

  @ApiProperty({ type: Boolean })
  retryable!: boolean;

  @ApiProperty({ type: String, format: 'uuid' })
  correlationId!: string;

  @ApiPropertyOptional({ type: Number, minimum: 1 })
  retryAfterSeconds?: number;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
  })
  fieldErrors?: Readonly<Record<string, readonly string[]>>;
}

type HttpResponse = {
  status(status: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: ApiErrorResponseDto): void;
};

@Catch()
@Injectable()
export class ApplicationErrorFilter implements ExceptionFilter {
  constructor(private readonly context: RequestContextStore) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const correlationId = this.context.get()?.correlationId ?? randomUUID();
    const error =
      exception instanceof ApplicationError
        ? exception
        : exception instanceof HttpException && exception.getStatus() < 500
          ? new ApplicationError(
              'INVALID_REQUEST',
              'Request is invalid',
              exception.getStatus(),
            )
        : new ApplicationError(
            'INTERNAL_ERROR',
            'An unexpected error occurred',
            500,
          );
    const body: ApiErrorResponseDto = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.fieldErrors === undefined
        ? {}
        : { fieldErrors: error.fieldErrors }),
    };

    if (error.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(error.retryAfterSeconds));
    }

    response.status(error.status).json(body);
  }
}
