export interface ActivityWindow {
  start: number | null;
  end: number;
}

export function validActivityWindow(value: unknown): value is ActivityWindow {
  if (!value || typeof value !== 'object' || !('start' in value) || !('end' in value)) return false;
  const {start, end} = value;
  return typeof end === 'number' && Number.isSafeInteger(end) && end > 0 && end <= 8640000000000000 &&
    (start === null || typeof start === 'number' && Number.isSafeInteger(start) && start > 0 && start <= end);
}

export function withinActivityWindow(time: number, window: ActivityWindow) {
  return time > 0 && time >= (window.start ?? 0) && time <= window.end;
}
