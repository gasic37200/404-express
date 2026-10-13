import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { advance, reserve } from '../src/shipments/service.js';
import { dispatchDue, listEvents, MAX_ATTEMPTS, RETRY_BACKOFF_MS } from '../src/webhooks/outbox.js';
import { ADMIN_KEY, body, setup } from './helpers.js';

type Reply = number | Error;

/** 응답을 차례로 돌려주는 가짜 fetch. 받은 요청도 기록한다. */
function fakeFetch(replies: Reply[], fallback: Reply = 200) {
  const calls: { headers: Record<string, string>; body: any }[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const reply = replies.length ? replies.shift()! : fallback;
    if (reply instanceof Error) throw reply;
    return new Response(null, { status: reply });
  }) as typeof fetch;
  return { fn, calls };
}

function newShipment(env: ReturnType<typeof setup>, seq = 1) {
  const key = `shipment-20261008-${String(seq).padStart(6, '0')}`;
  return reserve(env.db, key, body, env.clock()).shipment.trackingNo;
}

function deps(env: ReturnType<typeof setup>, fetch: typeof globalThis.fetch) {
  return { db: env.db, clock: env.clock, webhookUrl: 'http://server/webhook', webhookApiKey: 'wh-key', timeoutMs: 1000, fetch };
}

describe('웹훅 outbox', () => {
  it('2xx면 SENT, 헤더와 본문 계약을 지킨다', async () => {
    const env = setup();
    const trackingNo = newShipment(env);
    advance(env.db, trackingNo, env.clock());
    const { fn, calls } = fakeFetch([200]);

    await dispatchDue(deps(env, fn));

    expect(calls[0].headers['X-Api-Key']).toBe('wh-key');
    expect(calls[0].body).toMatchObject({
      courierOrderNo: 'shipment-20261008-000001',
      trackingNo,
      status: 'PICKED_UP',
      occurredAt: '2026-10-08T15:00:00+09:00',
    });
    expect(calls[0].body.eventId).toMatch(/^evt_/);
    expect(listEvents(env.db, 'SENT')).toHaveLength(1);
  });

  it('배송 건별 FIFO: 앞 이벤트가 성공하기 전에는 다음 이벤트를 보내지 않는다', async () => {
    const env = setup();
    const trackingNo = newShipment(env);
    advance(env.db, trackingNo, env.clock()); // PICKED_UP
    advance(env.db, trackingNo, env.clock()); // IN_TRANSIT
    const { fn, calls } = fakeFetch([503]);

    await dispatchDue(deps(env, fn)); // PICKED_UP 실패
    await dispatchDue(deps(env, fn)); // 백오프 중: 아무것도 안 보냄
    expect(calls.map((c) => c.body.status)).toEqual(['PICKED_UP']);

    env.tick(RETRY_BACKOFF_MS[0]);
    await dispatchDue(deps(env, fn)); // PICKED_UP 성공
    await dispatchDue(deps(env, fn)); // 그다음 IN_TRANSIT
    expect(calls.map((c) => c.body.status)).toEqual(['PICKED_UP', 'PICKED_UP', 'IN_TRANSIT']);
  });

  it('다른 배송 건은 서로 막지 않는다', async () => {
    const env = setup();
    const a = newShipment(env, 1);
    const b = newShipment(env, 2);
    advance(env.db, a, env.clock());
    advance(env.db, b, env.clock());
    const { fn, calls } = fakeFetch([500, 200]);

    await dispatchDue(deps(env, fn));
    expect(calls.map((c) => c.body.trackingNo)).toEqual([a, b]);
  });

  it('4xx는 바로 DEAD, 408/429와 네트워크 오류는 재시도', async () => {
    const env = setup();
    const ids = [1, 2, 3, 4].map((seq) => newShipment(env, seq));
    ids.forEach((no) => advance(env.db, no, env.clock()));
    const { fn } = fakeFetch([400, 408, 429, new Error('ECONNREFUSED')]);

    await dispatchDue(deps(env, fn));

    expect(listEvents(env.db, 'DEAD').map((e) => e.payload.trackingNo)).toEqual([ids[0]]);
    expect(listEvents(env.db, 'PENDING')).toHaveLength(3);
  });

  it(`${MAX_ATTEMPTS}번 실패하면 DEAD, admin 재전송으로 다시 보낸다`, async () => {
    const env = setup();
    const trackingNo = newShipment(env);
    advance(env.db, trackingNo, env.clock());
    const { fn, calls } = fakeFetch([], 500);

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await dispatchDue(deps(env, fn));
      env.tick(RETRY_BACKOFF_MS[i] ?? 0);
    }
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    const [dead] = listEvents(env.db, 'DEAD');
    expect(dead.attempts).toBe(MAX_ATTEMPTS);

    const listed = await request(env.app).get('/api/v1/admin/webhooks?status=DEAD').set('X-Admin-Key', ADMIN_KEY);
    expect(listed.body.data).toHaveLength(1);

    const retried = await request(env.app)
      .post(`/api/v1/admin/webhooks/${dead.eventId}/retry`)
      .set('X-Admin-Key', ADMIN_KEY);
    expect(retried.body.data.status).toBe('PENDING');

    await dispatchDue(deps(env, fakeFetch([200]).fn));
    expect(listEvents(env.db, 'SENT')).toHaveLength(1);
  });

  it('DEAD가 아닌 이벤트는 재전송할 수 없다', async () => {
    const env = setup();
    const trackingNo = newShipment(env);
    advance(env.db, trackingNo, env.clock());
    const [event] = listEvents(env.db);
    const res = await request(env.app).post(`/api/v1/admin/webhooks/${event.eventId}/retry`).set('X-Admin-Key', ADMIN_KEY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WEBHOOK_EVENT_NOT_DEAD');
  });
});
