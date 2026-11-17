import { existsSync, readFileSync } from 'node:fs';
import type { Branch } from './planner.js';

/**
 * 우체국 지점 표(JSON 배열 {name, address, lat, lng})를 읽는다. 파일이 없으면 빈 표:
 * 이때는 모든 예약이 기본 거리로 진행된다.
 */
export function loadBranches(path: string, log: Pick<Console, 'warn'> = console): Branch[] {
  if (!existsSync(path)) {
    log.warn(`[routing] 지점 표 없음(${path}), 모든 예약을 기본 거리로 진행`);
    return [];
  }
  const rows = JSON.parse(readFileSync(path, 'utf8')) as Branch[];
  return rows.filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lng));
}
