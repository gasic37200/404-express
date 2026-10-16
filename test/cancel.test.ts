import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { advanceDue, cancel } from '../src/shipments/service.js';
import { listEvents } from '../src/webhooks/outbox.js';
import { ADMIN_KEY, API_KEY, body, setup } from './helpers.js';

// JustCommit 배송 취소(#161)가 기대는 계약
const KEY = 'shipment-20261016-000001';
const TRACKING = '404000000001';
const DELAYS = { pickup: 180_000, inTransit: 120_000, delivery: 120_000 };

type App = ReturnType<typeof setup>['app'];

const reserve = (app: App) =>
  request(app).post('/api/v1/shipments').set('X-Api-Key', API_KEY).set('Idempotency-Key', KEY).send(body);
const cancelReq = (app: App, trackingNo = TRACKING, key = API_KEY) =>
  request(app).post(`/api/v1/shipments/${trackingNo}/cancel`).set('X-Api-Key', key);

describe('배송 취소 API', () => {
  it('RESERVED → 200, CANCELLED, cancelledAt 채움', async () => {
    const { app, tick } = setup();
    await reserve(app);
    tick(30_000);
    const res = await cancelReq(app);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      trackingNo: TRACKING,
      status: 'CANCELLED',
      cancelledAt: '2026-10-08T15:00:30+09:00',
    });
  });

  it('두 번 취소해도 둘 다 200, 같은 결과 (타임아웃 뒤 재요청 안전)', async () => {
    const { app, tick } = setup();
    await reserve(app);
    const first = await cancelReq(app);
    tick(60_000);
    const second = await cancelReq(app);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data); // cancelledAt도 처음 값 그대로
  });

  it('PICKED_UP 이후 → 409 SHIPMENT_NOT_CANCELLABLE', async () => {
    const { app } = setup();
    await reserve(app);
    await request(app).post(`/api/v1/admin/shipments/${TRACKING}/advance`).set('X-Admin-Key', ADMIN_KEY);
    const res = await cancelReq(app);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIPMENT_NOT_CANCELLABLE');
  });

  it('없는 송장번호 → 404 SHIPMENT_NOT_FOUND', async () => {
    const { app } = setup();
    const res = await cancelReq(app, '404999999999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SHIPMENT_NOT_FOUND');
  });

  it('키 오류 → 401 UNAUTHORIZED, 취소되지 않음', async () => {
    const { app } = setup();
    await reserve(app);
    const res = await cancelReq(app, TRACKING, 'wrong');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    const found = await request(app).get(`/api/v1/shipments/${TRACKING}`).set('X-Api-Key', API_KEY);
    expect(found.body.data.status).toBe('RESERVED');
  });
});

describe('취소된 건의 자동 진행과 웹훅', () => {
  it('취소한 건은 수거 시각이 지나도 진행되지 않고 웹훅도 쌓이지 않는다', async () => {
    const { app, db, clock, tick } = setup();
    await reserve(app);
    await cancelReq(app);

    tick(DELAYS.pickup + 60_000); // 3분 넘게
    expect(advanceDue(db, DELAYS, clock())).toBe(0);
    expect(listEvents(db)).toHaveLength(0);
    const found = await request(app).get(`/api/v1/shipments/${TRACKING}`).set('X-Api-Key', API_KEY);
    expect(found.body.data).toMatchObject({ status: 'CANCELLED', pickedUpAt: null });
  });

  it('취소된 건은 admin 진행도 409', async () => {
    const { app } = setup();
    await reserve(app);
    await cancelReq(app);
    const res = await request(app).post(`/api/v1/admin/shipments/${TRACKING}/advance`).set('X-Admin-Key', ADMIN_KEY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('취소된 건을 같은 Idempotency-Key로 다시 예약', () => {
  it('새로 만들지 않고 취소된 기존 건을 200으로 돌려준다 (trackingNo 포함)', async () => {
    const { app, db } = setup();
    await reserve(app);
    await cancelReq(app);

    const again = await reserve(app);
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ trackingNo: TRACKING, courierOrderNo: KEY, status: 'CANCELLED' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM shipments').get()).toEqual({ n: 1 });
  });
});

describe('취소와 자동 수거가 겹칠 때', () => {
  it('취소가 먼저면 수거되지 않는다', async () => {
    const { app, db, clock, tick } = setup();
    await reserve(app);
    tick(DELAYS.pickup); // 수거 시각 도달
    cancel(db, TRACKING, clock()); // 같은 시각, 취소가 먼저 처리됨
    expect(advanceDue(db, DELAYS, clock())).toBe(0);
    expect(listEvents(db)).toHaveLength(0);
  });

  it('수거가 먼저면 취소는 409이고 상태는 PICKED_UP으로 남는다', async () => {
    const { app, db, clock, tick } = setup();
    await reserve(app);
    tick(DELAYS.pickup);
    expect(advanceDue(db, DELAYS, clock())).toBe(1); // 수거가 먼저 처리됨
    const res = await cancelReq(app);
    expect(res.status).toBe(409);
    const found = await request(app).get(`/api/v1/shipments/${TRACKING}`).set('X-Api-Key', API_KEY);
    expect(found.body.data).toMatchObject({ status: 'PICKED_UP', cancelledAt: null });
  });
});
