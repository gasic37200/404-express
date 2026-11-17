/**
 * 예약 때 한 번 정한 경로 계획. 남은 거리는 저장하지 않고, 이 계획과 "예약 후 지난 시간"으로 계산한다.
 * 속도·대기 시간에는 SPEED_MULTIPLIER가 이미 반영돼 있다(진행 중인 건은 설정을 바꿔도 그대로 간다).
 */
export interface RoutePlan {
  /** 판매자와 가장 가까운 지점 ↔ 판매자 */
  pickupM: number;
  /** 판매자 쪽 지점 ↔ 구매자 쪽 지점 */
  linehaulM: number;
  /** 구매자 쪽 지점 ↔ 구매자 */
  deliveryM: number;
  originBranch: string | null;
  destBranch: string | null;
  /** 수거·배송 기사 속도 */
  localMps: number;
  /** 간선 속도 */
  linehaulMps: number;
  /** 집하점에 머무는 시간 */
  dwellMs: number;
}

/** 이 거리 안이면 알림 단계 */
export const NEAR_DISTANCE_M = 5000;
/** 이 거리 안이면 취소 불가 */
export const CANCEL_LOCK_DISTANCE_M = 2000;

export type StageStatus =
  | 'NEAR_5KM'
  | 'CANCEL_LOCKED'
  | 'PICKED_UP'
  | 'ARRIVED_ORIGIN'
  | 'IN_TRANSIT'
  | 'ARRIVED_DEST'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED';

export interface Stage {
  status: StageStatus;
  /** 진행 기준 시각(예약 시각)으로부터 ms */
  atMs: number;
  /** 거리에 의미가 있는 단계만 */
  remainingDistanceMeters?: number;
  locationName: string | null;
}

const travelMs = (meters: number, mps: number) => (meters / mps) * 1000;

/** 계획이 지나갈 단계와 각 도달 시각. 앞으로만 진행한다. */
export function timeline(plan: RoutePlan): Stage[] {
  const { pickupM, linehaulM, deliveryM, originBranch, destBranch, localMps, linehaulMps, dwellMs } = plan;
  const stages: Stage[] = [];

  if (pickupM > NEAR_DISTANCE_M) {
    stages.push({
      status: 'NEAR_5KM',
      atMs: travelMs(pickupM - NEAR_DISTANCE_M, localMps),
      remainingDistanceMeters: NEAR_DISTANCE_M,
      locationName: originBranch,
    });
  }
  // 시작 거리가 2km 이하면 예약하자마자(0ms) 잠긴다
  stages.push({
    status: 'CANCEL_LOCKED',
    atMs: travelMs(Math.max(0, pickupM - CANCEL_LOCK_DISTANCE_M), localMps),
    remainingDistanceMeters: Math.min(pickupM, CANCEL_LOCK_DISTANCE_M),
    locationName: originBranch,
  });

  const pickedUp = travelMs(pickupM, localMps);
  const arrivedOrigin = pickedUp + travelMs(pickupM, localMps); // 기사가 지점으로 돌아온다
  const inTransit = arrivedOrigin + dwellMs;
  const arrivedDest = inTransit + travelMs(linehaulM, linehaulMps);
  const outForDelivery = arrivedDest + dwellMs;
  const delivered = outForDelivery + travelMs(deliveryM, localMps);

  stages.push(
    { status: 'PICKED_UP', atMs: pickedUp, remainingDistanceMeters: 0, locationName: originBranch },
    { status: 'ARRIVED_ORIGIN', atMs: arrivedOrigin, locationName: originBranch },
    { status: 'IN_TRANSIT', atMs: inTransit, remainingDistanceMeters: linehaulM, locationName: originBranch },
    { status: 'ARRIVED_DEST', atMs: arrivedDest, locationName: destBranch },
    { status: 'OUT_FOR_DELIVERY', atMs: outForDelivery, remainingDistanceMeters: deliveryM, locationName: destBranch },
    { status: 'DELIVERED', atMs: delivered, remainingDistanceMeters: 0, locationName: destBranch },
  );
  return stages;
}

function atOf(stages: Stage[], status: StageStatus): number {
  return stages.find((s) => s.status === status)!.atMs;
}

/**
 * 지금 이동 중인 구간에서 남은 거리(m, 반올림). 이동 중이 아니면 null.
 * 수거 전: 판매자까지 / 간선 중: 도착 지점까지 / 배송 중: 구매자까지.
 */
export function remainingAt(plan: RoutePlan, elapsedMs: number): number | null {
  const stages = timeline(plan);
  const t = Math.max(0, elapsedMs);
  const pickedUp = atOf(stages, 'PICKED_UP');
  if (t <= pickedUp) return Math.round(Math.max(0, plan.pickupM - (plan.localMps * t) / 1000));

  const inTransit = atOf(stages, 'IN_TRANSIT');
  const arrivedDest = atOf(stages, 'ARRIVED_DEST');
  if (t >= inTransit && t < arrivedDest) {
    return Math.round(Math.max(0, plan.linehaulM - (plan.linehaulMps * (t - inTransit)) / 1000));
  }

  const out = atOf(stages, 'OUT_FOR_DELIVERY');
  const delivered = atOf(stages, 'DELIVERED');
  if (t >= out && t < delivered) {
    return Math.round(Math.max(0, plan.deliveryM - (plan.localMps * (t - out)) / 1000));
  }
  return null;
}
