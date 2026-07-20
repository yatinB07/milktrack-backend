import { Inject, Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { validateRouteAssignmentDate } from '../domain/route-assignment-rules.js';
import { RouteAssignmentStore, type RouteScheduleProjection } from './route-assignment.store.js';

export abstract class RoutingScheduleService {
  abstract project(
    tx: TransactionContext,
    vendorId: string,
    serviceDate: string,
  ): Promise<readonly RouteScheduleProjection[]>;
}

@Injectable()
export class DefaultRoutingScheduleService extends RoutingScheduleService {
  constructor(@Inject(RouteAssignmentStore) private readonly assignments: RouteAssignmentStore) {
    super();
  }
  project(tx: TransactionContext, _vendorId: string, serviceDate: string) {
    validateRouteAssignmentDate(serviceDate);
    return this.assignments.schedule(tx, serviceDate);
  }
}
