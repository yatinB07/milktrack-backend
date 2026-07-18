import { Injectable } from '@nestjs/common';

@Injectable()
export class HealthService {
  getHealth() {
    return {
      status: 'ok' as const,
      service: 'milktrack-backend' as const,
      timestamp: new Date().toISOString(),
    };
  }
}
