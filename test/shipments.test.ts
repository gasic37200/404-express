import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { advanceDue } from '../src/shipments/service.js';
import { listEvents } from '../src/webhooks/outbox.js';
import { ADMIN_KEY, API_KEY, AT, body, PLAN, setup, STAGES } from './helpers.js';

const KEY = 'shipment-20261008-000001';

function reserve(app: ReturnType<typeof setup>['app'], key = KEY, payload: object = body) {
  return request(app).post('/api/v1/shipments').set('X-Api-Key', API_KEY).set('Idempotency-Key', key).send(payload);
}

describe('예약', () => {
  it('처음 요청이면 201과 송장번호를 준다', async () => {
    const { app } = setup();
    const res = await reserve(app);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 201,
      data: { trackingNo: '404000000001', courierOrderNo: KEY, status: 'RESERVED', bookedAt: '2026-10-08T15:00:00+09:00' },
    });
    expect(res.body.code).toBeUndefined();
  });

  it('같은 키 + 같은 본문이면 새로 만들지 않고 200으로 같은 송장번호를 준다', async () => {
    const { app } = setup();
    await reserve(app);
    const reordered = { itemSummary: body.itemSummary, receiver: body.receiver, sender: body.sender };
    const res = await reserve(app, KEY, reordered);
    expect(res.status).toBe(200);
    expect(res.body.data.trackingNo).toBe('404000000001');
  });

  it('같은 키 + 다른 본문이면 409', async () => {
    const { app } = setup();
    await reserve(app);
    const res = await reserve(app, KEY, { ...body, itemSummary: '다른 물건' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it.each([undefined, 'shipment-2026-10-08-000001', 'shipment-20261008-1'])('키 형식이 틀리면 400 (%s)', async (key) => {
    const { app } = setup();
    const req = request(app).post('/api/v1/shipments').set('X-Api-Key', API_KEY);
    if (key) req.set('Idempotency-Key', key);
    const res = await req.send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('필수값이 비면 400 INVALID_FIELD_ERROR', async () => {
    const { app } = setup();
    const res = await reserve(app, KEY, { ...body, receiver: { ...body.receiver, address: ' ' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FIELD_ERROR');
    expect(res.body.message).toContain('receiver.address');
  });

  it('API 키가 틀리면 401', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/v1/shipments').set('X-Api-Key', 'wrong').set('Idempotency-Key', KEY).send(body);
    expect(res.status).toBe(401);
  });
});

describe('조회와 취소', () => {
  it('송장번호로 조회한다, 없으면 404', async () => {
    const { app } = setup();
    await reserve(app);
    const found = await request(app).get('/api/v1/shipments/404000000001').set('X-Api-Key', API_KEY);
    expect(found.body.data.status).toBe('RESERVED');
    const missing = await request(app).get('/api/v1/shipments/404999999999').set('X-Api-Key', API_KEY);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('SHIPMENT_NOT_FOUND');
  });

  it('RESERVED는 취소되고, 다시 취소해도 200 (웹훅 없음)', async () => {
    const { app, db } = setup();
    await reserve(app);
    const first = await request(app).post('/api/v1/shipments/404000000001/cancel').set('X-Api-Key', API_KEY);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('CANCELLED');
    const again = await request(app).post('/api/v1/shipments/404000000001/cancel').set('X-Api-Key', API_KEY);
    expect(again.status).toBe(200);
    expect(listEvents(db)).toHaveLength(0);
  });

  it('수거 이후 취소는 409', async () => {
    const { app } = setup();
    await reserve(app);
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/v1/admin/shipments/404000000001/advance').set('X-Admin-Key', ADMIN_KEY); // NEAR_5KM → CANCEL_LOCKED → PICKED_UP
    }
    const res = await request(app).post('/api/v1/shipments/404000000001/cancel').set('X-Api-Key', API_KEY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIPMENT_NOT_CANCELLABLE');
  });
});

describe('상태 진행', () => {
  it('admin advance는 다음 단계로 한 칸씩 진행하고 이벤트를 쌓는다, 끝나면 409', async () => {
    const { app, db } = setup();
    await reserve(app);
    const advance = () => request(app).post('/api/v1/admin/shipments/404000000001/advance').set('X-Admin-Key', ADMIN_KEY);
    for (const stage of STAGES) {
      expect((await advance()).body.data.status).toBe(stage);
    }
    const done = await advance();
    expect(done.status).toBe(409);
    expect(done.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(listEvents(db).map((e) => e.payload.status)).toEqual(STAGES);
  });

  it('admin 키가 없으면 401', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/v1/admin/shipments/404000000001/advance');
    expect(res.status).toBe(401);
  });

  it('자동 진행은 경로 계획의 도달 시각을 지난 단계만 옮긴다', async () => {
    const { app, db, clock, tick } = setup();
    await reserve(app);

    tick(AT.NEAR_5KM - 1_000);
    expect(advanceDue(db, clock())).toBe(0);
    tick(1_000);
    expect(advanceDue(db, clock())).toBe(1); // NEAR_5KM
    tick(AT.DELIVERED - AT.NEAR_5KM);
    expect(advanceDue(db, clock())).toBe(7); // 나머지 7단계를 한 번에 지남

    const res = await request(app).get('/api/v1/shipments/404000000001').set('X-Api-Key', API_KEY);
    expect(res.body.data).toMatchObject({
      status: 'DELIVERED',
      pickedUpAt: '2026-10-08T15:10:00+09:00',
      inTransitAt: '2026-10-08T15:21:00+09:00',
      deliveredAt: '2026-10-08T15:43:40+09:00',
      remainingDistanceMeters: null,
      locationName: '해운대우체국',
    });
  });

  it('스케줄러가 늦어 여러 단계를 지나쳐도 순서대로, 원래 도달 시각으로 웹훅을 쌓는다', async () => {
    const { app, db, clock, tick } = setup();
    await reserve(app);
    tick(AT.IN_TRANSIT + 10_000);
    advanceDue(db, clock());
    expect(listEvents(db).map((e) => [e.payload.status, e.payload.occurredAt])).toEqual([
      ['NEAR_5KM', '2026-10-08T15:01:40+09:00'],
      ['CANCEL_LOCKED', '2026-10-08T15:06:40+09:00'],
      ['PICKED_UP', '2026-10-08T15:10:00+09:00'],
      ['ARRIVED_ORIGIN', '2026-10-08T15:20:00+09:00'],
      ['IN_TRANSIT', '2026-10-08T15:21:00+09:00'],
    ]);
  });

  it('웹훅에 남은 거리(해당 단계만)와 지점 이름을 싣는다', async () => {
    const { app, db, clock, tick } = setup();
    await reserve(app);
    tick(AT.ARRIVED_ORIGIN);
    advanceDue(db, clock());
    const payloads = listEvents(db).map((e) => e.payload);
    expect(payloads[0]).toMatchObject({ status: 'NEAR_5KM', remainingDistanceMeters: 5000, locationName: '강남우체국' });
    expect(payloads[1]).toMatchObject({ status: 'CANCEL_LOCKED', remainingDistanceMeters: 2000 });
    expect(payloads[3].status).toBe('ARRIVED_ORIGIN');
    expect('remainingDistanceMeters' in payloads[3]).toBe(false);
    expect(payloads[3].locationName).toBe('강남우체국');
  });

  it('조회하면 지금 남은 거리와 현재 단계를 준다', async () => {
    const { app, tick } = setup();
    await reserve(app);
    tick(250_000);
    const res = await request(app).get('/api/v1/shipments/404000000001').set('X-Api-Key', API_KEY);
    expect(res.body.data).toMatchObject({ status: 'NEAR_5KM', remainingDistanceMeters: 3500, locationName: '강남우체국' });
  });

  it('주문번호로도 조회한다', async () => {
    const { app } = setup();
    await reserve(app);
    const res = await request(app)
      .get('/api/v1/shipments/by-order-no/shipment-20261008-000001')
      .set('X-Api-Key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.trackingNo).toBe('404000000001');
    const missing = await request(app)
      .get('/api/v1/shipments/by-order-no/shipment-20261008-999999')
      .set('X-Api-Key', API_KEY);
    expect(missing.status).toBe(404);
  });

  it('시작 거리가 2km 이하면 예약하자마자 CANCEL_LOCKED', async () => {
    const env = setup({ ...PLAN, pickupM: 1500 });
    const res = await reserve(env.app);
    expect(res.body.data.status).toBe('CANCEL_LOCKED');
    expect(listEvents(env.db).map((e) => e.payload.status)).toEqual(['CANCEL_LOCKED']);
  });

  it('취소된 건은 자동 진행하지 않는다', async () => {
    const { app, db, clock, tick } = setup();
    await reserve(app);
    await request(app).post('/api/v1/shipments/404000000001/cancel').set('X-Api-Key', API_KEY);
    tick(AT.DELIVERED);
    expect(advanceDue(db, clock())).toBe(0);
  });
});
