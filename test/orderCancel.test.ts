import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { advanceDue } from '../src/shipments/service.js';
import { toKst } from '../src/time.js';
import { listEvents } from '../src/webhooks/outbox.js';
import { ADMIN_KEY, API_KEY, AT, body, PLAN, setup } from './helpers.js';

// 주문번호 취소: 구매자가 누른 시각(cancelRequestedAt)의 거리로 택배사가 판정한다.
// PLAN 기준: 잠금(2km) = 예약 후 400초, 수거 = 600초, 유예 30초
const KEY = 'shipment-20261008-000001';
const TRACKING = '404000000001';

type Env = ReturnType<typeof setup>;

const reserve = (env: Env) =>
  request(env.app).post('/api/v1/shipments').set('X-Api-Key', API_KEY).set('Idempotency-Key', KEY).send(body);

/** 예약 시각(테스트 시작 시각) + ms 를 +09:00 문자열로 */
const pressedAt = (env: Env, sinceBookingMs: number) => toKst(BOOKED + sinceBookingMs);
const BOOKED = Date.UTC(2026, 9, 8, 6, 0, 0);

const cancelByOrderNo = (env: Env, cancelRequestedAt: unknown, key = KEY) =>
  request(env.app)
    .post(`/api/v1/shipments/byOrderNo/${key}/cancel`)
    .set('X-Api-Key', API_KEY)
    .send({ cancelRequestedAt });

const statuses = (env: Env) => listEvents(env.db).map((e) => e.payload.status);

describe('주문번호 취소: 판정', () => {
  it('누른 시각에 2km 밖이면 취소된다 (200, CANCELLED 웹훅)', async () => {
    const env = setup();
    await reserve(env);
    env.tick(100_000);
    const res = await cancelByOrderNo(env, pressedAt(env, 100_000));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      courierOrderNo: KEY,
      trackingNo: TRACKING,
      status: 'CANCELLED',
      returning: false,
      cancelledAt: '2026-10-08T15:01:40+09:00',
    });
    expect(statuses(env)).toEqual(['NEAR_5KM', 'CANCELLED']);
    expect(listEvents(env.db).at(-1)!.payload).toMatchObject({ status: 'CANCELLED', occurredAt: '2026-10-08T15:01:40+09:00' });
  });

  it('잠금 1초 전에 누르면 취소된다', async () => {
    const env = setup();
    await reserve(env);
    env.tick(AT.CANCEL_LOCKED + 5_000); // 큐가 늦게 보내 지금은 이미 잠긴 뒤
    const res = await cancelByOrderNo(env, pressedAt(env, AT.CANCEL_LOCKED - 1_000));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
  });

  it('잠금 후 30초 안에 눌렀고 아직 수거 전이면 받아준다 (유예)', async () => {
    const env = setup();
    await reserve(env);
    env.tick(AT.CANCEL_LOCKED + 15_000);
    const res = await cancelByOrderNo(env, pressedAt(env, AT.CANCEL_LOCKED + 10_000));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', returning: false });
  });

  it('잠금 후 30초가 지나 누르면 409 SHIPMENT_NOT_CANCELLABLE, 배송은 계속 진행된다', async () => {
    const env = setup();
    await reserve(env);
    env.tick(AT.CANCEL_LOCKED + 31_000);
    const res = await cancelByOrderNo(env, pressedAt(env, AT.CANCEL_LOCKED + 31_000));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIPMENT_NOT_CANCELLABLE');
    env.tick(AT.DELIVERED);
    advanceDue(env.db, env.clock());
    expect(statuses(env).at(-1)).toBe('DELIVERED');
  });

  it('유예 안에 눌렀어도 이미 수거됐으면 409', async () => {
    const env = setup();
    await reserve(env);
    env.tick(AT.PICKED_UP);
    const res = await cancelByOrderNo(env, pressedAt(env, AT.CANCEL_LOCKED + 10_000));
    expect(res.status).toBe(409);
  });

  it('시작 거리가 2km 이하면 예약 직후 바로 잠겨 409 (유예 30초 지난 뒤)', async () => {
    const env = setup({ ...PLAN, pickupM: 1500 });
    await reserve(env);
    env.tick(40_000);
    const res = await cancelByOrderNo(env, pressedAt(env, 40_000));
    expect(res.status).toBe(409);
  });

  it('미래 시각이 오면 지금 시각으로 보고 판정한다', async () => {
    const env = setup();
    await reserve(env);
    env.tick(AT.CANCEL_LOCKED + 40_000);
    const res = await cancelByOrderNo(env, pressedAt(env, 0 - 0 + 10 * AT.DELIVERED)); // 한참 뒤 시각
    expect(res.status).toBe(409); // 지금(잠금 + 40초) 기준이면 유예도 지남
  });
});

describe('주문번호 취소: 멱등', () => {
  it('같은 주문번호를 다시 보내면 처음 결과 그대로 (웹훅도 한 번)', async () => {
    const env = setup();
    await reserve(env);
    env.tick(100_000);
    const first = await cancelByOrderNo(env, pressedAt(env, 100_000));
    env.tick(60_000);
    const second = await cancelByOrderNo(env, pressedAt(env, 100_000));
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(statuses(env).filter((s) => s === 'CANCELLED')).toHaveLength(1);
  });

  it('처음이 409면 다시 보내도 409 (다른 시각을 보내도 첫 판정)', async () => {
    const env = setup();
    await reserve(env);
    env.tick(AT.CANCEL_LOCKED + 40_000);
    expect((await cancelByOrderNo(env, pressedAt(env, AT.CANCEL_LOCKED + 40_000))).status).toBe(409);
    const again = await cancelByOrderNo(env, pressedAt(env, 0));
    expect(again.status).toBe(409);
  });

});

describe('취소된 배송 건', () => {
  it('배송 완료 시각이 지나도 진행되지 않고 CANCELLED 뒤로 웹훅이 생기지 않는다', async () => {
    const env = setup();
    await reserve(env);
    await cancelByOrderNo(env, pressedAt(env, 0));
    env.tick(AT.DELIVERED);
    expect(advanceDue(env.db, env.clock())).toBe(0);
    expect(statuses(env)).toEqual(['CANCELLED']);
    const found = await request(env.app).get(`/api/v1/shipments/${TRACKING}`).set('X-Api-Key', API_KEY);
    expect(found.body.data).toMatchObject({ status: 'CANCELLED', pickedUpAt: null, remainingDistanceMeters: null });
  });

  it('admin 진행도 409', async () => {
    const env = setup();
    await reserve(env);
    await cancelByOrderNo(env, pressedAt(env, 0));
    const res = await request(env.app).post(`/api/v1/admin/shipments/${TRACKING}/advance`).set('X-Admin-Key', ADMIN_KEY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('같은 Idempotency-Key로 다시 예약하면 새로 만들지 않고 취소된 기존 건을 200으로 돌려준다', async () => {
    const env = setup();
    await reserve(env);
    await cancelByOrderNo(env, pressedAt(env, 0));
    const again = await reserve(env);
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ trackingNo: TRACKING, courierOrderNo: KEY, status: 'CANCELLED' });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM shipments').get()).toEqual({ n: 1 });
  });
});

describe('주문번호 취소: 예약 전', () => {
  it('예약이 없으면 취소 기록만 남기고 200 (trackingNo null)', async () => {
    const env = setup();
    const res = await cancelByOrderNo(env, pressedAt(env, 0));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      courierOrderNo: KEY,
      trackingNo: null,
      status: 'CANCELLED',
      returning: false,
      cancelledAt: '2026-10-08T15:00:00+09:00',
    });
    expect(listEvents(env.db)).toHaveLength(0); // 배송 건이 없으니 웹훅도 없음
  });

  it('취소 기록이 있는 주문번호로 늦게 온 예약은 409 ORDER_ALREADY_CANCELLED', async () => {
    const env = setup();
    await cancelByOrderNo(env, pressedAt(env, 0));
    const res = await reserve(env);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_ALREADY_CANCELLED');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM shipments').get()).toEqual({ n: 0 });
  });
});

describe('주문번호 취소: 택배사 장애로 이미 수거됨 → 반송', () => {
  it('누른 시각엔 2km 밖인데 지금은 수거됨 → 200 returning, CANCELLED → RETURNING → RETURNED', async () => {
    const env = setup();
    await reserve(env);
    env.tick(AT.PICKED_UP + 100_000); // 택배사가 죽어 있다가 수거 이후에 요청을 받음
    const res = await cancelByOrderNo(env, pressedAt(env, 100_000));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'RETURNING', returning: true, cancelledAt: '2026-10-08T15:11:40+09:00' });
    expect(statuses(env).slice(-2)).toEqual(['CANCELLED', 'RETURNING']);

    // 반송: 수거에 걸린 만큼(600초) 뒤 판매자에게 돌아간다. 그 사이 원래 단계는 진행되지 않는다
    env.tick(599_000);
    advanceDue(env.db, env.clock());
    expect(statuses(env).at(-1)).toBe('RETURNING');
    env.tick(1_000);
    advanceDue(env.db, env.clock());
    expect(statuses(env).at(-1)).toBe('RETURNED');
    expect(statuses(env)).not.toContain('IN_TRANSIT');

    const found = await request(env.app).get(`/api/v1/shipments/${TRACKING}`).set('X-Api-Key', API_KEY);
    expect(found.body.data).toMatchObject({ status: 'RETURNED', returnedAt: '2026-10-08T15:21:40+09:00', remainingDistanceMeters: null });
  });

  it('반송 중 다시 보내도 처음 결과(returning: true)', async () => {
    const env = setup();
    await reserve(env);
    env.tick(AT.PICKED_UP + 100_000);
    await cancelByOrderNo(env, pressedAt(env, 100_000));
    const again = await cancelByOrderNo(env, pressedAt(env, 100_000));
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ status: 'RETURNING', returning: true });
  });
});

describe('주문번호 취소: 요청 검증', () => {
  it.each([
    ['없음', undefined],
    ['시간대 없음', '2026-10-08T15:00:00'],
    ['형식 틀림', '어제'],
  ])('cancelRequestedAt %s → 400 INVALID_FIELD_ERROR', async (_label, value) => {
    const env = setup();
    const res = await cancelByOrderNo(env, value);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FIELD_ERROR');
  });

  it('주문번호 형식이 틀리면 400', async () => {
    const env = setup();
    const res = await cancelByOrderNo(env, pressedAt(env, 0), 'order-1');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FIELD_ERROR');
  });

  it('키가 없으면 401', async () => {
    const env = setup();
    const res = await request(env.app).post(`/api/v1/shipments/byOrderNo/${KEY}/cancel`).send({ cancelRequestedAt: pressedAt(env, 0) });
    expect(res.status).toBe(401);
  });
});
