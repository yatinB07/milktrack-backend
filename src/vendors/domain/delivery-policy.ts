export const LATE_LEAVE_POLICIES = ['reject', 'approval'] as const;
export type LateLeavePolicy = (typeof LATE_LEAVE_POLICIES)[number];

export type DeliveryPolicy = Readonly<{
  vendorId: string;
  skipCutoffMinutes: number;
  lateLeavePolicy: LateLeavePolicy;
  captureAgentLocationEvidence: boolean;
  version: number;
}>;

export type UpdateDeliveryPolicyCommand = Readonly<{
  skipCutoffMinutes: number;
  lateLeavePolicy: LateLeavePolicy;
  captureAgentLocationEvidence: boolean;
  expectedVersion: number;
  reason: string;
}>;
