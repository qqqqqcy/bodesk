export const syncInterval = {min: 1, max: 15, default: 3};

export function validSyncInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= syncInterval.min && value <= syncInterval.max;
}

export function syncIntervalSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > syncInterval.max && value <= 30) return syncInterval.max;
  return validSyncInterval(value) ? value : syncInterval.default;
}
