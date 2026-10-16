import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { BusinessError } from '../http/errors.js';
import { toKst, type Clock } from '../time.js';

export type OutboxStatus = 'PENDING' | 'SENT' | 'DEAD';

export interface WebhookPayload {
  eventId: string;
  courierOrderNo: string;
  trackingNo: string;
  status: string;
  occurredAt: string;
}

interface OutboxRow {
  id: number;
  event_id: string;
  shipment_id: number;
  payload_json: string;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

/**
 * 재전송 간격: n번째 실패 뒤 기다리는 시간. 1분 → 5분 → 30분 → 2시간 → 6시간.
 * 처음 전송 1번 + 재전송 길이만큼(기본 5번) 시도하고, 모두 실패하면 DEAD.
 */
export const DEFAULT_RETRY_DELAYS_MS = [60, 300, 1800, 7200, 21600].map((s) => s * 1000);

/** 상태 전이와 같은 트랜잭션 안에서 불러야 이벤트가 유실되지 않는다. */
export function enqueueWebhook(
  db: Db,
  shipment: { id: number; courierOrderNo: string; trackingNo: string },
  status: string,
  now: number,
): void {
  const payload: WebhookPayload = {
    eventId: `evt_${randomUUID()}`,
    courierOrderNo: shipment.courierOrderNo,
    trackingNo: shipment.trackingNo,
    status,
    occurredAt: toKst(now),
  };
  db.prepare(
    `INSERT INTO webhook_outbox (event_id, shipment_id, payload_json, status, next_attempt_at, created_at)
     VALUES (?, ?, ?, 'PENDING', ?, ?)`,
  ).run(payload.eventId, shipment.id, JSON.stringify(payload), now, now);
}

export interface DispatcherDeps {
  db: Db;
  clock: Clock;
  webhookUrl: string;
  webhookApiKey: string;
  timeoutMs: number;
  retryDelaysMs: readonly number[];
  fetch?: typeof fetch;
  log?: Pick<Console, 'warn' | 'error'>;
}

type SendResult = { ok: true } | { ok: false; retryable: boolean; error: string };

async function send(deps: DispatcherDeps, payloadJson: string): Promise<SendResult> {
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(deps.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': deps.webhookApiKey },
      body: payloadJson,
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (res.ok) return { ok: true };
    // JustCommit은 처리했거나 무시해도 되는 건 200, 키 문제는 401, 서버 에러는 5xx로 답한다.
    // 4xx는 설정·데이터 문제라 다시 보내도 같으므로 5xx만 재전송한다.
    return { ok: false, retryable: res.status >= 500, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 재전송 시각이 된 PENDING 이벤트를 모두 보낸다. 이벤트마다 따로 예약되므로, 한 이벤트의 재전송이
 * 같은 배송 건의 다른 이벤트를 막지 않는다. 순서가 뒤바뀌어도 JustCommit이 "앞으로만 반영 + 중복 무시"로 처리한다.
 * 전송은 동시에 하므로 응답이 느린 이벤트가 다른 이벤트를 기다리게 하지 않는다.
 */
export async function dispatchDue(deps: DispatcherDeps): Promise<number> {
  const { db, clock } = deps;
  const due = db
    .prepare(`SELECT * FROM webhook_outbox WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY id`)
    .all(clock()) as unknown as OutboxRow[];

  await Promise.all(
    due.map(async (row) => {
      // 재전송도 처음 저장한 payload_json을 그대로 보낸다(eventId, occurredAt 동일).
      const result = await send(deps, row.payload_json);
      record(deps, row, result);
    }),
  );
  return due.length;
}

function record(deps: DispatcherDeps, row: OutboxRow, result: SendResult): void {
  const { db, clock, retryDelaysMs } = deps;
  const now = clock();
  const attempts = row.attempts + 1;
  const payload = JSON.parse(row.payload_json) as WebhookPayload;
  const label = `event=${row.event_id} trackingNo=${payload.trackingNo} status=${payload.status}`;

  if (result.ok) {
    db.prepare(`UPDATE webhook_outbox SET status = 'SENT', attempts = ?, sent_at = ?, last_error = NULL WHERE id = ?`).run(
      attempts,
      now,
      row.id,
    );
    return;
  }

  const retriesLeft = attempts <= retryDelaysMs.length;
  if (!result.retryable || !retriesLeft) {
    db.prepare(`UPDATE webhook_outbox SET status = 'DEAD', attempts = ?, last_error = ? WHERE id = ?`).run(
      attempts,
      result.error,
      row.id,
    );
    const reason = result.retryable ? '재전송 횟수 초과' : '재전송하지 않는 응답';
    deps.log?.error(`[webhook] 전송 실패(${reason}) ${label} attempts=${attempts} error=${result.error}`);
    return;
  }

  const nextAttemptAt = now + retryDelaysMs[attempts - 1];
  db.prepare(`UPDATE webhook_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`).run(
    attempts,
    nextAttemptAt,
    result.error,
    row.id,
  );
  deps.log?.warn(
    `[webhook] 전송 실패, 재전송 예약 ${label} attempts=${attempts} error=${result.error} next=${toKst(nextAttemptAt)}`,
  );
}

export interface OutboxEventView {
  eventId: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  sentAt: string | null;
  payload: WebhookPayload;
}

function toView(row: OutboxRow): OutboxEventView {
  return {
    eventId: row.event_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: toKst(row.next_attempt_at),
    createdAt: toKst(row.created_at),
    sentAt: toKst(row.sent_at),
    payload: JSON.parse(row.payload_json),
  };
}

export function listEvents(db: Db, status?: OutboxStatus): OutboxEventView[] {
  const rows = status
    ? db.prepare(`SELECT * FROM webhook_outbox WHERE status = ? ORDER BY id`).all(status)
    : db.prepare(`SELECT * FROM webhook_outbox ORDER BY id`).all();
  return (rows as unknown as OutboxRow[]).map(toView);
}

/** DEAD 이벤트를 다시 PENDING으로 돌린다. 시도 횟수도 초기화한다. */
export function retryDeadEvent(db: Db, eventId: string, now: number): OutboxEventView {
  const row = db.prepare(`SELECT * FROM webhook_outbox WHERE event_id = ?`).get(eventId) as OutboxRow | undefined;
  if (!row) throw new BusinessError('WEBHOOK_EVENT_NOT_FOUND');
  if (row.status !== 'DEAD') throw new BusinessError('WEBHOOK_EVENT_NOT_DEAD');
  db.prepare(`UPDATE webhook_outbox SET status = 'PENDING', attempts = 0, next_attempt_at = ? WHERE id = ?`).run(now, row.id);
  return toView({ ...row, status: 'PENDING', attempts: 0, next_attempt_at: now });
}
