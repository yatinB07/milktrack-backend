export const recordLifecycles = ['current', 'deleted'] as const;
export type RecordLifecycle = (typeof recordLifecycles)[number];

export function recordLifecycleOf(
  deletedAt: Date | null | undefined,
): RecordLifecycle {
  return deletedAt ? 'deleted' : 'current';
}
