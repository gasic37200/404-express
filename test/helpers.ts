import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import type { RoutePlan } from '../src/routing/timeline.js';

export const API_KEY = 'test-key';
export const ADMIN_KEY = 'test-admin';

/** 테스트용 고정 경로 계획: 근거리 10m/s, 간선 20m/s, 집하 대기 60초 */
export const PLAN: RoutePlan = {
  pickupM: 6000,
  linehaulM: 20000,
  deliveryM: 3000,
  originBranch: '강남우체국',
  destBranch: '해운대우체국',
  localMps: 10,
  linehaulMps: 20,
  dwellMs: 60_000,
};

/** PLAN 기준 각 단계 도달 시각 (예약 후 ms) */
export const AT = {
  NEAR_5KM: 100_000,
  CANCEL_LOCKED: 400_000,
  PICKED_UP: 600_000,
  ARRIVED_ORIGIN: 1_200_000,
  IN_TRANSIT: 1_260_000,
  ARRIVED_DEST: 2_260_000,
  OUT_FOR_DELIVERY: 2_320_000,
  DELIVERED: 2_620_000,
} as const;

export const STAGES = Object.keys(AT) as (keyof typeof AT)[];

export function setup(plan: RoutePlan = PLAN) {
  let now = Date.UTC(2026, 9, 8, 6, 0, 0); // 2026-10-08 15:00 KST
  const clock = () => now;
  const db = openDb(':memory:');
  const app = createApp({
    db,
    clock,
    planner: async () => plan,
    config: { courierApiKey: API_KEY, adminApiKey: ADMIN_KEY },
  });
  return {
    db,
    app,
    clock,
    tick(ms: number) {
      now += ms;
    },
  };
}

export const body = {
  sender: { name: '김판매', phone: '010-1111-2222', address: '서울시 강남구 1' },
  receiver: { name: '이구매', phone: '010-3333-4444', address: '부산시 해운대구 2' },
  itemSummary: '몬스테라 외 1건',
};
