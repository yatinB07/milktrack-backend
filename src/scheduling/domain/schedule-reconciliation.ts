export interface ScheduleTarget {
  subscriptionId: string;
  revisionId: string;
  householdId: string;
  productId: string;
  unitId: string;
  deliverySlotId: string;
  plannedQuantity: string;
  routeAssignmentId?: string | null;
}

export interface ScheduledDeliveryState extends ScheduleTarget {
  id: string;
  status: 'scheduled' | 'cancelled';
  version: number;
  finalized: boolean;
}

export interface ScheduleReconciliation {
  created: ScheduleTarget[];
  existing: ScheduledDeliveryState[];
  updated: Array<ScheduledDeliveryState & ScheduleTarget>;
  cancelled: ScheduledDeliveryState[];
}

const targetKey = ({ subscriptionId, deliverySlotId }: ScheduleTarget): string =>
  `${subscriptionId}:${deliverySlotId}`;

const sameProjection = (current: ScheduledDeliveryState, target: ScheduleTarget): boolean =>
  current.revisionId === target.revisionId &&
  current.householdId === target.householdId &&
  current.productId === target.productId &&
  current.unitId === target.unitId &&
  current.plannedQuantity === target.plannedQuantity &&
  (current.routeAssignmentId ?? null) === (target.routeAssignmentId ?? null);

export const planScheduleReconciliation = (
  current: ScheduledDeliveryState[],
  targets: ScheduleTarget[],
): ScheduleReconciliation => {
  const finalizedSubscriptions = new Set(
    current.filter(({ finalized }) => finalized).map(({ subscriptionId }) => subscriptionId),
  );
  const currentByKey = new Map(current.map((delivery) => [targetKey(delivery), delivery]));
  const targetKeys = new Set<string>();
  const result: ScheduleReconciliation = {
    created: [],
    existing: current.filter(({ finalized }) => finalized),
    updated: [],
    cancelled: [],
  };

  for (const target of targets) {
    if (finalizedSubscriptions.has(target.subscriptionId)) continue;
    const key = targetKey(target);
    targetKeys.add(key);
    const delivery = currentByKey.get(key);
    if (!delivery) {
      result.created.push(target);
    } else if (delivery.status === 'scheduled' && sameProjection(delivery, target)) {
      result.existing.push(delivery);
    } else {
      result.updated.push({ ...delivery, ...target });
    }
  }

  for (const delivery of current) {
    if (
      delivery.status === 'scheduled' &&
      !delivery.finalized &&
      !finalizedSubscriptions.has(delivery.subscriptionId) &&
      !targetKeys.has(targetKey(delivery))
    ) result.cancelled.push(delivery);
  }

  return result;
};
