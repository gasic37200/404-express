import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { advanceDue } from '../src/shipments/service.js';
import { listEvents } from '../src/webhooks/outbox.js';
import { ADMIN_KEY, API_KEY, body, setup } from './helpers.js';

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
    await request(app).post('/api/v1/admin/shipments/404000000001/advance').set('X-Admin-Key', ADMIN_KEY);
    const res = await request(app).post('/api/v1/shipments/404000000001/cancel').set('X-Api-Key', API_KEY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIPMENT_NOT_CANCELLABLE');
  });
});

describe('상태 진행', () => {
  it('admin advance는 한 칸씩 진행하고 이벤트를 쌓는다, 끝나면 409', async () => {
    const { app, db } = setup();
    await reserve(app);
    const advance = () => request(app).post('/api/v1/admin/shipments/404000000001/advance').set('X-Admin-Key', ADMIN_KEY);
    expect((await advance()).body.data.status).toBe('PICKED_UP');
    expect((await advance()).body.data.status).toBe('IN_TRANSIT');
    expect((await advance()).body.data.status).toBe('DELIVERED');
    const done = await advance();
    expect(done.status).toBe(409);
    expect(listEvents(db).map((e) => e.payload.status)).toEqual(['PICKED_UP', 'IN_TRANSIT', 'DELIVERED']);
  });

  it('admin 키가 없으면 401', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/v1/admin/shipments/404000000001/advance');
    expect(res.status).toBe(401);
  });

  it('자동 진행은 머문 시간이 지난 건만 한 칸씩 옮긴다', async () => {
    const { app, db, clock, tick } = setup();
    const delays = { pickup: 180_000, inTransit: 120_000, delivery: 120_000 };
    await reserve(app);

    tick(179_000);
    expect(advanceDue(db, delays, clock())).toBe(0);
    tick(1_000);
    expect(advanceDue(db, delays, clock())).toBe(1); // PICKED_UP
    tick(120_000);
    advanceDue(db, delays, clock()); // IN_TRANSIT
    tick(120_000);
    advanceDue(db, delays, clock()); // DELIVERED

    const res = await request(app).get('/api/v1/shipments/404000000001').set('X-Api-Key', API_KEY);
    expect(res.body.data).toMatchObject({
      status: 'DELIVERED',
      pickedUpAt: '2026-10-08T15:03:00+09:00',
      inTransitAt: '2026-10-08T15:05:00+09:00',
      deliveredAt: '2026-10-08T15:07:00+09:00',
    });
  });

  it('취소된 건은 자동 진행하지 않는다', async () => {
    const { app, db, clock, tick } = setup();
    await reserve(app);
    await request(app).post('/api/v1/shipments/404000000001/cancel').set('X-Api-Key', API_KEY);
    tick(600_000);
    expect(advanceDue(db, { pickup: 0, inTransit: 0, delivery: 0 }, clock())).toBe(0);
  });
});
