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

/** n번째 실패 뒤 기다리는 시간. 길이 + 1 = 최대 시도 횟수(10회). */
export const RETRY_BACKOFF_MS = [10, 30, 60, 300, 900, 1800, 3600, 3600, 3600].map((s) => s * 1000);
export const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

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
    // 4xx는 다시 보내도 같으므로 바로 포기한다. 408/429만 예외.
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    return { ok: false, retryable, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 배송 건별 FIFO: 각 배송 건에서 아직 SENT가 아닌 가장 오래된 이벤트만 후보가 된다.
 * 그 이벤트가 DEAD면 해당 배송 건의 뒤 이벤트도 멈춘다(관리자 재전송 또는 서버 polling으로 복구).
 */
export async function dispatchDue(deps: DispatcherDeps): Promise<number> {
  const { db, clock } = deps;
  const due = db
    .prepare(
      `SELECT o.* FROM webhook_outbox o
        WHERE o.status = 'PENDING'
          AND o.next_attempt_at <= ?
          AND o.id = (SELECT MIN(h.id) FROM webhook_outbox h
                       WHERE h.shipment_id = o.shipment_id AND h.status <> 'SENT')
        ORDER BY o.id`,
    )
    .all(clock()) as unknown as OutboxRow[];

  for (const row of due) {
    const result = await send(deps, row.payload_json);
    const now = clock();
    const attempts = row.attempts + 1;
    if (result.ok) {
      db.prepare(`UPDATE webhook_outbox SET status = 'SENT', attempts = ?, sent_at = ?, last_error = NULL WHERE id = ?`).run(
        attempts,
        now,
        row.id,
      );
      continue;
    }
    if (!result.retryable || attempts >= MAX_ATTEMPTS) {
      db.prepare(`UPDATE webhook_outbox SET status = 'DEAD', attempts = ?, last_error = ? WHERE id = ?`).run(
        attempts,
        result.error,
        row.id,
      );
      deps.log?.warn(`[webhook] DEAD event=${row.event_id} attempts=${attempts} error=${result.error}`);
      continue;
    }
    db.prepare(`UPDATE webhook_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`).run(
      attempts,
      now + RETRY_BACKOFF_MS[attempts - 1],
      result.error,
      row.id,
    );
  }
  return due.length;
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
