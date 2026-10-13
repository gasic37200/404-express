export const ShipmentStatus = {
  RESERVED: 'RESERVED', // 택배 예약
  PICKED_UP: 'PICKED_UP', // 접수 완료
  IN_TRANSIT: 'IN_TRANSIT', // 배송 중
  DELIVERED: 'DELIVERED', // 배송 완료
  CANCELLED: 'CANCELLED', // 접수 취소
} as const;

export type ShipmentStatus = (typeof ShipmentStatus)[keyof typeof ShipmentStatus];

/** 앞으로만 진행한다. CANCELLED는 RESERVED에서 취소 API로만 간다. */
export const NEXT_STATUS: Partial<Record<ShipmentStatus, ShipmentStatus>> = {
  RESERVED: 'PICKED_UP',
  PICKED_UP: 'IN_TRANSIT',
  IN_TRANSIT: 'DELIVERED',
};

/** 상태가 바뀔 때 채우는 시각 컬럼 */
export const STATUS_TIMESTAMP_COLUMN: Record<ShipmentStatus, string> = {
  RESERVED: 'booked_at',
  PICKED_UP: 'picked_up_at',
  IN_TRANSIT: 'in_transit_at',
  DELIVERED: 'delivered_at',
  CANCELLED: 'cancelled_at',
};
