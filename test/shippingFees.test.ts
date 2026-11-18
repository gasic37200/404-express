import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { feeFor, seedShippingFees, type ShippingFeeTable } from '../src/fees/service.js';
import { dispatchDue, listEvents } from '../src/webhooks/outbox.js';
import { ADMIN_KEY, API_KEY, setup } from './helpers.js';

const INITIAL: ShippingFeeTable = JSON.parse(readFileSync('fees/shipping-fees.json', 'utf8'));
const TABLE: ShippingFeeTable = {
  baseFee: 3000,
  jejuSurcharge: 3000,
  remoteSurcharge: 5000,
  jejuZipcodes: [{ from: '63000', to: '63644', name: '제주' }],
  remoteZipcodes: [
    { from: '40200', to: '40240', name: '울릉도' },
    { from: '63365', to: '63365', name: '우도' },
  ],
};

const getFees = (env: ReturnType<typeof setup>) => request(env.app).get('/api/v1/shippingFees').set('X-Api-Key', API_KEY);
const putFees = (env: ReturnType<typeof setup>, body: object) =>
  request(env.app).put('/api/v1/admin/shippingFees').set('X-Admin-Key', ADMIN_KEY).send(body);

describe('요금 판정 (market이 같은 규칙으로 계산)', () => {
  it.each([
    ['04535', 3000], // 서울
    ['63100', 6000], // 제주시
    ['40210', 8000], // 울릉도
    ['63365', 8000], // 우도: 제주 구간이지만 도서산간 할증 하나만 (3000 + 5000)
  ])('%s → %i원 (기본 + 할증)', (zipcode, fee) => {
    expect(feeFor(TABLE, zipcode)).toBe(fee);
  });

  it('기본 요금이 바뀌어도 할증은 그대로 더한다', () => {
    const bigger = { ...TABLE, baseFee: 4000 };
    expect([feeFor(bigger, '04535'), feeFor(bigger, '63100'), feeFor(bigger, '63365')]).toEqual([4000, 7000, 9000]);
  });
});

describe('초기 요금표', () => {
  it('비어 있으면 파일을 버전 1로 넣고 변경 웹훅을 쌓는다', async () => {
    const env = setup();
    seedShippingFees(env.db, INITIAL, env.clock());
    const res = await getFees(env);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ version: 1, baseFee: 3000, jejuSurcharge: 3000, remoteSurcharge: 5000, updatedAt: '2026-10-08T15:00:00+09:00' });
    expect(res.body.data.remoteZipcodes).toContainEqual({ from: '58826', to: '58826', name: '전남 신안 섬지역3' });
    expect(res.body.data).not.toHaveProperty('source');
    expect(listEvents(env.db).map((e) => e.payload.status)).toEqual(['SHIPPING_FEES_CHANGED']);
  });

  it('이미 있으면 다시 넣지 않는다 (재시작해도 버전 그대로)', async () => {
    const env = setup();
    seedShippingFees(env.db, INITIAL, env.clock());
    seedShippingFees(env.db, { ...INITIAL, baseFee: 9999 }, env.clock());
    expect((await getFees(env)).body.data).toMatchObject({ version: 1, baseFee: 3000 });
    expect(listEvents(env.db)).toHaveLength(1);
  });

  it('요금표가 없으면 404', async () => {
    const env = setup();
    expect((await getFees(env)).status).toBe(404);
  });

  it('키가 없으면 401', async () => {
    const env = setup();
    expect((await request(env.app).get('/api/v1/shippingFees')).status).toBe(401);
  });
});

describe('요금표 바꾸기 (admin)', () => {
  it('바꾸면 버전이 오르고, 요금표 전체를 실은 웹훅을 보낸다', async () => {
    const env = setup();
    seedShippingFees(env.db, TABLE, env.clock());
    env.tick(60_000);
    const res = await putFees(env, { ...TABLE, jejuSurcharge: 4000 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ version: 2, jejuSurcharge: 4000, updatedAt: '2026-10-08T15:01:00+09:00' });
    expect((await getFees(env)).body.data.version).toBe(2);

    const calls: any[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;
    await dispatchDue({ db: env.db, clock: env.clock, webhookUrl: 'http://x', webhookApiKey: 'k', timeoutMs: 1000, retryDelaysMs: [], fetch });
    const last = calls.at(-1);
    expect(last).toMatchObject({
      status: 'SHIPPING_FEES_CHANGED',
      version: 2,
      occurredAt: '2026-10-08T15:01:00+09:00',
      updatedAt: '2026-10-08T15:01:00+09:00',
      baseFee: 3000,
      jejuSurcharge: 4000,
      remoteSurcharge: 5000,
      jejuZipcodes: TABLE.jejuZipcodes,
      remoteZipcodes: TABLE.remoteZipcodes,
    });
    expect(last.eventId).toMatch(/^evt_/);
    expect(last).not.toHaveProperty('courierOrderNo');
    expect(last).not.toHaveProperty('trackingNo');
  });

  it('같은 내용이면 버전을 올리지 않고 웹훅도 보내지 않는다', async () => {
    const env = setup();
    seedShippingFees(env.db, TABLE, env.clock());
    const res = await putFees(env, TABLE);
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(1);
    expect(listEvents(env.db)).toHaveLength(1); // 처음 넣을 때 것만
  });

  it.each([
    ['금액 음수', { ...TABLE, baseFee: -1 }],
    ['금액 소수', { ...TABLE, baseFee: 3000.5 }],
    ['우편번호 4자리', { ...TABLE, remoteZipcodes: [{ from: '4020', to: '40240', name: 'x' }] }],
    ['구간 거꾸로', { ...TABLE, remoteZipcodes: [{ from: '40240', to: '40200', name: 'x' }] }],
    ['필드 없음', { baseFee: 3000 }],
  ])('%s → 400 INVALID_FIELD_ERROR', async (_label, body) => {
    const env = setup();
    seedShippingFees(env.db, TABLE, env.clock());
    const res = await putFees(env, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FIELD_ERROR');
  });

  it('admin 키가 없으면 401', async () => {
    const env = setup();
    const res = await request(env.app).put('/api/v1/admin/shippingFees').send(TABLE);
    expect(res.status).toBe(401);
  });
});
