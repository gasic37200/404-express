import { createHash } from 'node:crypto';
import { transaction, type Db } from '../db.js';
import { BusinessError } from '../http/errors.js';
import { toKst } from '../time.js';
import { enqueueWebhook } from '../webhooks/outbox.js';
import type { Party, ReserveRequest } from './schema.js';
import { NEXT_STATUS, STATUS_TIMESTAMP_COLUMN, type ShipmentStatus } from './status.js';

interface ShipmentRow {
  id: number;
  courier_order_no: string;
  request_hash: string;
  tracking_no: string;
  status: ShipmentStatus;
  sender_json: string;
  receiver_json: string;
  item_summary: string;
  booked_at: number;
  picked_up_at: number | null;
  in_transit_at: number | null;
  delivered_at: number | null;
  cancelled_at: number | null;
  status_changed_at: number;
}

export interface ShipmentView {
  trackingNo: string;
  courierOrderNo: string;
  status: ShipmentStatus;
  sender: Party;
  receiver: Party;
  itemSummary: string;
  bookedAt: string;
  pickedUpAt: string | null;
  inTransitAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
}

function toView(row: ShipmentRow): ShipmentView {
  return {
    trackingNo: row.tracking_no,
    courierOrderNo: row.courier_order_no,
    status: row.status,
    sender: JSON.parse(row.sender_json),
    receiver: JSON.parse(row.receiver_json),
    itemSummary: row.item_summary,
    bookedAt: toKst(row.booked_at),
    pickedUpAt: toKst(row.picked_up_at),
    inTransitAt: toKst(row.in_transit_at),
    deliveredAt: toKst(row.delivered_at),
    cancelledAt: toKst(row.cancelled_at),
  };
}

/** 키 순서와 무관하게 같은 본문이면 같은 해시가 나오도록 정렬해서 직렬화한다. */
function hashRequest(request: ReserveRequest): string {
  const canonical = JSON.stringify(request, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/** 송장번호: 404 + 9자리 일련번호 (404000000001) */
function trackingNoOf(id: number): string {
  return `404${String(id).padStart(9, '0')}`;
}

function findRow(db: Db, trackingNo: string): ShipmentRow {
  const row = db.prepare(`SELECT * FROM shipments WHERE tracking_no = ?`).get(trackingNo) as ShipmentRow | undefined;
  if (!row) throw new BusinessError('SHIPMENT_NOT_FOUND');
  return row;
}

export function reserve(
  db: Db,
  courierOrderNo: string,
  request: ReserveRequest,
  now: number,
): { shipment: ShipmentView; created: boolean } {
  const requestHash = hashRequest(request);
  return transaction(db, () => {
    const existing = db.prepare(`SELECT * FROM shipments WHERE courier_order_no = ?`).get(courierOrderNo) as
      | ShipmentRow
      | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) throw new BusinessError('IDEMPOTENCY_KEY_REUSED');
      return { shipment: toView(existing), created: false };
    }

    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO shipments (courier_order_no, request_hash, status, sender_json, receiver_json, item_summary,
                                booked_at, status_changed_at)
         VALUES (?, ?, 'RESERVED', ?, ?, ?, ?, ?)`,
      )
      .run(
        courierOrderNo,
        requestHash,
        JSON.stringify(request.sender),
        JSON.stringify(request.receiver),
        request.itemSummary,
        now,
        now,
      );
    const id = Number(lastInsertRowid);
    db.prepare(`UPDATE shipments SET tracking_no = ? WHERE id = ?`).run(trackingNoOf(id), id);
    const row = db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(id) as unknown as ShipmentRow;
    return { shipment: toView(row), created: true };
  });
}

export function getShipment(db: Db, trackingNo: string): ShipmentView {
  return toView(findRow(db, trackingNo));
}

/** RESERVED일 때만 취소된다. 이미 CANCELLED면 그대로 돌려준다(멱등). 취소는 웹훅을 보내지 않는다. */
export function cancel(db: Db, trackingNo: string, now: number): ShipmentView {
  return transaction(db, () => {
    const row = findRow(db, trackingNo);
    if (row.status === 'CANCELLED') return toView(row);
    if (row.status !== 'RESERVED') throw new BusinessError('SHIPMENT_NOT_CANCELLABLE');
    db.prepare(`UPDATE shipments SET status = 'CANCELLED', cancelled_at = ?, status_changed_at = ? WHERE id = ?`).run(
      now,
      now,
      row.id,
    );
    return toView(findRow(db, trackingNo));
  });
}

/** 다음 상태로 한 칸 진행하고, 같은 트랜잭션에서 웹훅 이벤트를 outbox에 넣는다. */
function advanceRow(db: Db, row: ShipmentRow, now: number): void {
  const next = NEXT_STATUS[row.status];
  if (!next) throw new BusinessError('INVALID_STATE_TRANSITION');
  db.prepare(
    `UPDATE shipments SET status = ?, ${STATUS_TIMESTAMP_COLUMN[next]} = ?, status_changed_at = ? WHERE id = ?`,
  ).run(next, now, now, row.id);
  enqueueWebhook(db, { id: row.id, courierOrderNo: row.courier_order_no, trackingNo: row.tracking_no }, next, now);
}

export function advance(db: Db, trackingNo: string, now: number): ShipmentView {
  return transaction(db, () => {
    advanceRow(db, findRow(db, trackingNo), now);
    return toView(findRow(db, trackingNo));
  });
}

export interface ProgressDelays {
  pickup: number;
  inTransit: number;
  delivery: number;
}

/** 자동 진행: 현재 상태에 정해진 시간 이상 머문 배송 건을 한 칸씩 진행한다. */
export function advanceDue(db: Db, delays: ProgressDelays, now: number): number {
  const stay: [ShipmentStatus, number][] = [
    ['RESERVED', delays.pickup],
    ['PICKED_UP', delays.inTransit],
    ['IN_TRANSIT', delays.delivery],
  ];
  return transaction(db, () => {
    let count = 0;
    for (const [status, delay] of stay) {
      const rows = db
        .prepare(`SELECT * FROM shipments WHERE status = ? AND status_changed_at <= ? ORDER BY id`)
        .all(status, now - delay) as unknown as ShipmentRow[];
      for (const row of rows) {
        advanceRow(db, row, now);
        count++;
      }
    }
    return count;
  });
}
