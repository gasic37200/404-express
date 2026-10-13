/** 테스트에서 시간을 갈아끼울 수 있도록 모든 "지금"은 Clock을 거친다. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** epoch ms → `2026-10-08T15:30:00+09:00` */
export function toKst(epochMs: number): string;
export function toKst(epochMs: number | null): string | null;
export function toKst(epochMs: number | null): string | null {
  if (epochMs === null) return null;
  const iso = new Date(epochMs + KST_OFFSET_MS).toISOString(); // 2026-10-08T06:30:00.000Z 꼴
  return `${iso.slice(0, 19)}+09:00`;
}
