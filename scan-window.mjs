export const scanIntervalMs = 5 * 60_000;

export function scanWindowIsOpen(at) {
  const vietnamTime = new Date(at + 7 * 60 * 60_000);
  const minuteOfDay = vietnamTime.getUTCHours() * 60 + vietnamTime.getUTCMinutes();
  return minuteOfDay >= 8 * 60 + 30 && minuteOfDay <= 20 * 60 + 30;
}

export function scanSlot(at) {
  return Math.floor(at / scanIntervalMs) * scanIntervalMs;
}
