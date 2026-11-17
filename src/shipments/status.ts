import type { StageStatus } from '../routing/timeline.js';

/**
 * 배송 상태. RESERVED(예약 = 기사 배정)에서 시작해 경로 계획의 단계를 앞으로만 지난다.
 * CANCELLED는 취소 API로만 간다. RETURNING → RETURNED는 택배사 장애로 수거 뒤에 취소가 인정된 반송이다.
 */
export type ShipmentStatus = 'RESERVED' | StageStatus | 'CANCELLED' | 'RETURNING' | 'RETURNED';

/** 진행 순서. 앞으로만 간다. */
export const PROGRESS_ORDER: readonly ShipmentStatus[] = [
  'RESERVED', // 택배 예약(기사 배정)
  'NEAR_5KM', // 기사가 판매자 5km 안 (시작 거리가 5km를 넘을 때만)
  'CANCEL_LOCKED', // 기사가 판매자 2km 안 = 취소 불가
  'PICKED_UP', // 수거
  'ARRIVED_ORIGIN', // 출발지 집하점 도착
  'IN_TRANSIT', // 간선 이동
  'ARRIVED_DEST', // 도착지 집하점 도착
  'OUT_FOR_DELIVERY', // 배송 기사 배정
  'DELIVERED', // 배송 완료
];

export const TERMINAL_STATUSES: ReadonlySet<ShipmentStatus> = new Set(['DELIVERED', 'CANCELLED', 'RETURNED']);

/** 수거 전 단계. 이 단계에서 취소가 인정되면 반송 없이 취소된다 */
export const BEFORE_PICKUP: ReadonlySet<ShipmentStatus> = new Set(['RESERVED', 'NEAR_5KM', 'CANCEL_LOCKED']);

export const orderOf = (status: ShipmentStatus) => PROGRESS_ORDER.indexOf(status);
