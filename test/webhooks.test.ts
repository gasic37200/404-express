import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { advance, reserve } from '../src/shipments/service.js';
import { DEFAULT_RETRY_DELAYS_MS, dispatchDue, listEvents } from '../src/webhooks/outbox.js';
import { ADMIN_KEY, body, setup } from './helpers.js';

type Reply = number | Error | Promise<number>;

/** 응답을 차례로 돌려주는 가짜 fetch. 받은 요청도 기록한다. */
function fakeFetch(replies: Reply[], fallback: Reply = 200) {
  const calls: { headers: Record<string, string>; body: any }[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const reply = await (replies.length ? replies.shift()! : fallback);
    if (reply instanceof Error) throw reply;
    return new Response(null, { status: reply });
  }) as typeof fetch;
  return { fn, calls };
}

function silentLog() {
  const lines: { level: 'warn' | 'error'; message: string }[] = [];
  return {
    lines,
    warn: (message: string) => lines.push({ level: 'warn', message }),
    error: (message: string) => lines.push({ level: 'error', message }),
  };
}

function newShipment(env: ReturnType<typeof setup>, seq = 1) {
  const key = `shipment-20261008-${String(seq).padStart(6, '0')}`;
  return reserve(env.db, key, body, env.clock()).shipment.trackingNo;
}

function deps(
  env: ReturnType<typeof setup>,
  fetch: typeof globalThis.fetch,
  log = silentLog(),
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
) {
  return {
    db: env.db,
    clock: env.clock,
    webhookUrl: 'http://server/webhook',
    webhookApiKey: 'wh-key',
    timeoutMs: 1000,
    retryDelaysMs,
    fetch,
    log,
  };
}

describe('웹훅 전송', () => {
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

  it('기본 재전송 간격은 1분 → 5분 → 30분 → 2시간 → 6시간', () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([60, 300, 1800, 7200, 21600].map((s) => s * 1000));
  });

  it('5xx·연결 실패는 간격대로 재전송하고, 재전송 내용은 처음과 같다', async () => {
    const env = setup();
    const trackingNo = newShipment(env);
    advance(env.db, trackingNo, env.clock());
    const { fn, calls } = fakeFetch([503, new Error('ECONNREFUSED'), 200]);
    const log = silentLog();

    await dispatchDue(deps(env, fn, log)); // 1차 실패 → 1분 뒤
    env.tick(59_000);
    await dispatchDue(deps(env, fn, log)); // 아직 아님
    expect(calls).toHaveLength(1);
    env.tick(1_000);
    await dispatchDue(deps(env, fn, log)); // 2차 실패 → 5분 뒤
    env.tick(300_000);
    await dispatchDue(deps(env, fn, log)); // 3차 성공

    expect(calls).toHaveLength(3);
    expect(calls[1].body).toEqual(calls[0].body);
    expect(calls[2].body).toEqual(calls[0].body);
    expect(listEvents(env.db, 'SENT')).toHaveLength(1);
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });

  it.each([400, 401, 404, 408, 429])('4xx(%i)는 재전송하지 않고 error 로그를 남긴다', async (status) => {
    const env = setup();
    const trackingNo = newShipment(env);
    advance(env.db, trackingNo, env.clock());
    const { fn, calls } = fakeFetch([status]);
    const log = silentLog();

    await dispatchDue(deps(env, fn, log));
    env.tick(DEFAULT_RETRY_DELAYS_MS.at(-1)! * 10);
    await dispatchDue(deps(env, fn, log));

    expect(calls).toHaveLength(1);
    expect(listEvents(env.db, 'DEAD')[0].lastError).toBe(`HTTP ${status}`);
    expect(log.lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('처음 전송 + 재전송 5번이 모두 실패하면 실패 목록에 남기고, admin 재전송으로 다시 보낸다', async () => {
    const env = setup();
    const trackingNo = newShipment(env);
    advance(env.db, trackingNo, env.clock());
    const { fn, calls } = fakeFetch([], 500);
    const log = silentLog();

    for (let i = 0; i <= DEFAULT_RETRY_DELAYS_MS.length; i++) {
      await dispatchDue(deps(env, fn, log));
      env.tick(DEFAULT_RETRY_DELAYS_MS[i] ?? 0);
    }
    expect(calls).toHaveLength(6);
    const [dead] = listEvents(env.db, 'DEAD');
    expect(dead.attempts).toBe(6);
    expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(1);

    const listed = await request(env.app).get('/api/v1/admin/webhooks?status=DEAD').set('X-Admin-Key', ADMIN_KEY);
    expect(listed.body.data).toHaveLength(1);

    const retried = await request(env.app)
      .post(`/api/v1/admin/webhooks/${dead.eventId}/retry`)
      .set('X-Admin-Key', ADMIN_KEY);
    expect(retried.body.data.status).toBe('PENDING');

    const again = fakeFetch([200]);
    await dispatchDue(deps(env, again.fn, log));
    expect(again.calls[0].body).toEqual(calls[0].body);
    expect(listEvents(env.db, 'SENT')).toHaveLength(1);
  });

  it('재전송 간격은 설정으로 바꿀 수 있다', async () => {
    const env = setup();
    const trackingNo = newShipment(env);
    advance(env.db, trackingNo, env.clock());
    const { fn, calls } = fakeFetch([500, 200]);
    const fast = [5_000, 5_000];

    await dispatchDue(deps(env, fn, silentLog(), fast));
    env.tick(5_000);
    await dispatchDue(deps(env, fn, silentLog(), fast));
    expect(calls).toHaveLength(2);
  });

  it('같은 배송 건이라도 앞 이벤트의 재전송이 뒤 이벤트를 막지 않는다', async () => {
    const env = setup();
    const trackingNo = newShipment(env);
    advance(env.db, trackingNo, env.clock()); // PICKED_UP
    advance(env.db, trackingNo, env.clock()); // IN_TRANSIT
    const { fn, calls } = fakeFetch([503, 200]);

    await dispatchDue(deps(env, fn));

    expect(calls.map((c) => c.body.status)).toEqual(['PICKED_UP', 'IN_TRANSIT']);
    expect(listEvents(env.db, 'SENT').map((e) => e.payload.status)).toEqual(['IN_TRANSIT']);
    expect(listEvents(env.db, 'PENDING').map((e) => e.payload.status)).toEqual(['PICKED_UP']);
  });

  it('응답이 느린 이벤트가 다른 이벤트 전송을 기다리게 하지 않는다', async () => {
    const env = setup();
    const a = newShipment(env, 1);
    const b = newShipment(env, 2);
    advance(env.db, a, env.clock());
    advance(env.db, b, env.clock());
    let release!: (status: number) => void;
    const slow = new Promise<number>((resolve) => (release = resolve));
    const { fn, calls } = fakeFetch([slow, 200]);

    const run = dispatchDue(deps(env, fn));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(2); // 첫 응답을 기다리지 않고 두 번째도 이미 보냄
    release(200);
    await run;
    expect(listEvents(env.db, 'SENT')).toHaveLength(2);
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
