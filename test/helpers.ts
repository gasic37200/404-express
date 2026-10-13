import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

export const API_KEY = 'test-key';
export const ADMIN_KEY = 'test-admin';

export function setup() {
  let now = Date.UTC(2026, 9, 8, 6, 0, 0); // 2026-10-08 15:00 KST
  const clock = () => now;
  const db = openDb(':memory:');
  const app = createApp({ db, clock, config: { courierApiKey: API_KEY, adminApiKey: ADMIN_KEY } });
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
