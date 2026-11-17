import type { ReserveRequest } from '../shipments/schema.js';
import { haversineMeters, type LatLng } from './geo.js';
import type { RoutePlan } from './timeline.js';

export interface Branch extends LatLng {
  name: string;
  address: string;
}

/** 주소 → 좌표. 찾지 못하면 null. */
export interface Geocoder {
  geocode(address: string): Promise<LatLng | null>;
}

export interface PlannerOptions {
  geocoder: Geocoder;
  branches: readonly Branch[];
  speeds: { localKmh: number; linehaulKmh: number; dwellSec: number; multiplier: number };
  /** 좌표·지점을 모를 때 쓰는 거리 */
  defaults: { localM: number; linehaulM: number };
  log?: Pick<Console, 'warn'>;
}

export type Planner = (request: ReserveRequest) => Promise<RoutePlan>;

function nearest(branches: readonly Branch[], point: LatLng): { branch: Branch; meters: number } | null {
  let best: { branch: Branch; meters: number } | null = null;
  for (const branch of branches) {
    const meters = haversineMeters(point, branch);
    if (!best || meters < best.meters) best = { branch, meters };
  }
  return best;
}

/**
 * 예약 요청으로 경로 계획을 만든다. 좌표 변환이 실패해도 예외를 던지지 않고 기본 거리로 진행한다(예약을 막지 않음).
 * 주소는 개인정보라 로그에 남기지 않는다.
 */
export function createPlanner({ geocoder, branches, speeds, defaults, log }: PlannerOptions): Planner {
  const safeGeocode = async (address: string, who: string) => {
    try {
      const point = await geocoder.geocode(address);
      if (!point) log?.warn(`[routing] 좌표 변환 실패(${who}), 기본 거리로 진행`);
      return point;
    } catch (e) {
      log?.warn(`[routing] 좌표 변환 오류(${who}), 기본 거리로 진행: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  return async (request) => {
    const [senderPoint, receiverPoint] = await Promise.all([
      safeGeocode(request.sender.address, '판매자'),
      safeGeocode(request.receiver.address, '구매자'),
    ]);
    const origin = senderPoint ? nearest(branches, senderPoint) : null;
    const dest = receiverPoint ? nearest(branches, receiverPoint) : null;
    const m = speeds.multiplier;

    return {
      pickupM: Math.round(origin?.meters ?? defaults.localM),
      linehaulM: Math.round(origin && dest ? haversineMeters(origin.branch, dest.branch) : defaults.linehaulM),
      deliveryM: Math.round(dest?.meters ?? defaults.localM),
      originBranch: origin?.branch.name ?? null,
      destBranch: dest?.branch.name ?? null,
      localMps: (speeds.localKmh * 1000 * m) / 3600,
      linehaulMps: (speeds.linehaulKmh * 1000 * m) / 3600,
      dwellMs: (speeds.dwellSec * 1000) / m,
    };
  };
}
