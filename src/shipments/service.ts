import { createHash } from 'node:crypto';
import { transaction, type Db } from '../db.js';
import { BusinessError } from '../http/errors.js';
import { remainingAt, timeline, type RoutePlan } from '../routing/timeline.js';
import { toKst } from '../time.js';
import { enqueueWebhook } from '../webhooks/outbox.js';
import type { Party, ReserveRequest } from './schema.js';
import { BEFORE_PICKUP, orderOf, TERMINAL_STATUSES, type ShipmentStatus } from './status.js';

interface ShipmentRow {
  id: number;
  courier_order_no: string;
  request_hash: string;
  tracking_no: string;
  status: ShipmentStatus;
  sender_json: string;
  receiver_json: string;
  item_summary: string;
  plan_json: string;
  progress_origin_at: number;
  stage_times_json: string;
  booked_at: number;
  status_changed_at: number;
}

type StageTimes = Partial<Record<ShipmentStatus, number>>;

export interface ShipmentView {
  trackingNo: string;
  courierOrderNo: string;
  /** 현재 단계 */
  status: ShipmentStatus;
  /** 지금 이동 중인 구간에서 남은 거리(m). 지점에 머물거나 끝난 건은 null */
  remainingDistanceMeters: number | null;
  /** 현재 단계의 지점 이름. 모르면 null */
  locationName: string | null;
  sender: Party;
  receiver: Party;
  itemSummary: string;
  bookedAt: string;
  pickedUpAt: string | null;
  inTransitAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  /** 반송 완료 시각 (택배사 장애로 수거 뒤 취소가 인정된 건만) */
  returnedAt: string | null;
}

const planOf = (row: ShipmentRow) => JSON.parse(row.plan_json) as RoutePlan;
const timesOf = (row: ShipmentRow) => JSON.parse(row.stage_times_json) as StageTimes;

function locationOf(row: ShipmentRow): string | null {
  const plan = planOf(row);
  if (row.status === 'RESERVED' || row.status === 'RETURNING' || row.status === 'RETURNED') return plan.originBranch;
  if (row.status === 'CANCELLED') return null;
  return timeline(plan).find((s) => s.status === row.status)?.locationName ?? null;
}

function toView(row: ShipmentRow, now: number): ShipmentView {
  const times = timesOf(row);
  const moving = !TERMINAL_STATUSES.has(row.status) && row.status !== 'RETURNING';
  return {
    trackingNo: row.tracking_no,
    courierOrderNo: row.courier_order_no,
    status: row.status,
    remainingDistanceMeters: moving ? remainingAt(planOf(row), now - row.progress_origin_at) : null,
    locationName: locationOf(row),
    sender: JSON.parse(row.sender_json),
    receiver: JSON.parse(row.receiver_json),
    itemSummary: row.item_summary,
    bookedAt: toKst(row.booked_at),
    pickedUpAt: toKst(times.PICKED_UP ?? null),
    inTransitAt: toKst(times.IN_TRANSIT ?? null),
    deliveredAt: toKst(times.DELIVERED ?? null),
    cancelledAt: toKst(times.CANCELLED ?? null),
    returnedAt: toKst(times.RETURNED ?? null),
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

function rowById(db: Db, id: number): ShipmentRow {
  return db.prepare(`SELECT * FROM shipments WHERE id = ?`).get(id) as unknown as ShipmentRow;
}

function findRow(db: Db, trackingNo: string): ShipmentRow {
  const row = db.prepare(`SELECT * FROM shipments WHERE tracking_no = ?`).get(trackingNo) as ShipmentRow | undefined;
  if (!row) throw new BusinessError('SHIPMENT_NOT_FOUND');
  return row;
}

function findRowByOrderNo(db: Db, courierOrderNo: string): ShipmentRow | undefined {
  return db.prepare(`SELECT * FROM shipments WHERE courier_order_no = ?`).get(courierOrderNo) as ShipmentRow | undefined;
}

/**
 * 시각표를 따라잡는다: 지금까지 도달한 단계를 순서대로 반영하고, 단계마다 웹훅을 원래 도달 시각으로 outbox에 넣는다.
 * 상태 변경과 웹훅 적재가 같은 트랜잭션이어야 하므로 transaction() 안에서만 부른다.
 */
function catchUp(db: Db, row: ShipmentRow, now: number): ShipmentRow {
  return catchUpCounting(db, row, now).row;
}

/** 반송은 수거에 걸린 시간만큼 걸려 판매자에게 돌아간다 */
const returnTravelMs = (plan: RoutePlan) => (plan.pickupM / plan.localMps) * 1000;

function catchUpCounting(db: Db, row: ShipmentRow, now: number): { row: ShipmentRow; applied: number } {
  if (TERMINAL_STATUSES.has(row.status)) return { row, applied: 0 };
  if (row.status === 'RETURNING') return catchUpReturn(db, row, now);
  const current = orderOf(row.status);
  const due = timeline(planOf(row)).filter(
    (s) => orderOf(s.status) > current && row.progress_origin_at + s.atMs <= now,
  );
  if (due.length === 0) return { row, applied: 0 };

  const times = timesOf(row);
  for (const stage of due) {
    const occurredAt = Math.round(row.progress_origin_at + stage.atMs);
    times[stage.status] = occurredAt;
    enqueueWebhook(
      db,
      { id: row.id, courierOrderNo: row.courier_order_no, trackingNo: row.tracking_no },
      {
        status: stage.status,
        occurredAt,
        remainingDistanceMeters: stage.remainingDistanceMeters,
        locationName: stage.locationName,
      },
      now,
    );
  }
  const last = due[due.length - 1].status;
  db.prepare(`UPDATE shipments SET status = ?, stage_times_json = ?, status_changed_at = ? WHERE id = ?`).run(
    last,
    JSON.stringify(times),
    times[last]!,
    row.id,
  );
  return { row: rowById(db, row.id), applied: due.length };
}

function catchUpReturn(db: Db, row: ShipmentRow, now: number): { row: ShipmentRow; applied: number } {
  const plan = planOf(row);
  const times = timesOf(row);
  const returnedAt = Math.round(times.RETURNING! + returnTravelMs(plan));
  if (now < returnedAt) return { row, applied: 0 };
  times.RETURNED = returnedAt;
  enqueueWebhook(
    db,
    { id: row.id, courierOrderNo: row.courier_order_no, trackingNo: row.tracking_no },
    { status: 'RETURNED', occurredAt: returnedAt, locationName: plan.originBranch },
    now,
  );
  db.prepare(`UPDATE shipments SET status = 'RETURNED', stage_times_json = ?, status_changed_at = ? WHERE id = ?`).run(
    JSON.stringify(times),
    returnedAt,
    row.id,
  );
  return { row: rowById(db, row.id), applied: 1 };
}

function hasOrderCancellation(db: Db, courierOrderNo: string): boolean {
  return db.prepare(`SELECT 1 FROM order_cancellations WHERE courier_order_no = ?`).get(courierOrderNo) !== undefined;
}

/**
 * 이미 같은 키로 예약된 건이 있으면 그 결과를 돌려준다(경로 계획 전에 확인해 좌표 변환을 다시 하지 않는다).
 * 없으면 null.
 */
export function findExistingReservation(
  db: Db,
  courierOrderNo: string,
  request: ReserveRequest,
  now: number,
): ShipmentView | null {
  const existing = findRowByOrderNo(db, courierOrderNo);
  if (!existing) {
    // 예약 전에 취소된 주문번호면 늦게 온 예약을 받지 않는다
    if (hasOrderCancellation(db, courierOrderNo)) throw new BusinessError('ORDER_ALREADY_CANCELLED');
    return null;
  }
  if (existing.request_hash !== hashRequest(request)) throw new BusinessError('IDEMPOTENCY_KEY_REUSED');
  return toView(existing, now);
}

export function reserve(
  db: Db,
  courierOrderNo: string,
  request: ReserveRequest,
  plan: RoutePlan,
  now: number,
): { shipment: ShipmentView; created: boolean } {
  const requestHash = hashRequest(request);
  return transaction(db, () => {
    // 경로 계획(네트워크)은 트랜잭션 밖에서 했으므로, 그 사이 같은 키가 들어왔는지 다시 확인한다
    const existing = findRowByOrderNo(db, courierOrderNo);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new BusinessError('IDEMPOTENCY_KEY_REUSED');
      return { shipment: toView(existing, now), created: false };
    }
    // 좌표 변환 중에 같은 주문번호 취소가 먼저 들어왔을 수 있다
    if (hasOrderCancellation(db, courierOrderNo)) throw new BusinessError('ORDER_ALREADY_CANCELLED');

    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO shipments (courier_order_no, request_hash, status, sender_json, receiver_json, item_summary,
                                plan_json, progress_origin_at, stage_times_json, booked_at, status_changed_at)
         VALUES (?, ?, 'RESERVED', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        courierOrderNo,
        requestHash,
        JSON.stringify(request.sender),
        JSON.stringify(request.receiver),
        request.itemSummary,
        JSON.stringify(plan),
        now,
        JSON.stringify({ RESERVED: now }),
        now,
        now,
      );
    const id = Number(lastInsertRowid);
    db.prepare(`UPDATE shipments SET tracking_no = ? WHERE id = ?`).run(trackingNoOf(id), id);
    // 시작 거리가 2km 이하면 예약하자마자 CANCEL_LOCKED
    const row = catchUp(db, rowById(db, id), now);
    return { shipment: toView(row, now), created: true };
  });
}

export function getShipment(db: Db, trackingNo: string, now: number): ShipmentView {
  return transaction(db, () => toView(catchUp(db, findRow(db, trackingNo), now), now));
}

export function getShipmentByOrderNo(db: Db, courierOrderNo: string, now: number): ShipmentView {
  return transaction(db, () => {
    const row = findRowByOrderNo(db, courierOrderNo);
    if (!row) throw new BusinessError('SHIPMENT_NOT_FOUND');
    return toView(catchUp(db, row, now), now);
  });
}

/**
 * 테스트용 강제 진행: 다음 단계가 지금 도달하도록 진행 기준 시각을 당긴다.
 * 이후 단계도 같은 간격으로 이어지므로 남은 거리 계산과 어긋나지 않는다.
 */
export function advance(db: Db, trackingNo: string, now: number): ShipmentView {
  return transaction(db, () => {
    const row = catchUp(db, findRow(db, trackingNo), now);
    const next = TERMINAL_STATUSES.has(row.status)
      ? undefined
      : timeline(planOf(row)).find((s) => orderOf(s.status) > orderOf(row.status));
    if (!next) throw new BusinessError('INVALID_STATE_TRANSITION');
    db.prepare(`UPDATE shipments SET progress_origin_at = ? WHERE id = ?`).run(Math.round(now - next.atMs), row.id);
    return toView(catchUp(db, rowById(db, row.id), now), now);
  });
}

/** 자동 진행: 진행 중인 모든 배송 건의 시각표를 따라잡는다. 반영한 단계 수를 돌려준다. */
export function advanceDue(db: Db, now: number): number {
  return transaction(db, () => {
    const rows = db
      .prepare(`SELECT * FROM shipments WHERE status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED') ORDER BY id`)
      .all() as unknown as ShipmentRow[];
    let count = 0;
    for (const row of rows) {
      count += catchUpCounting(db, row, now).applied;
    }
    return count;
  });
}

// ---------------------------------------------------------------------------
// 주문번호 취소: 구매자가 누른 시각(cancelRequestedAt)의 거리로 택배사가 판정한다.

export interface OrderCancelView {
  courierOrderNo: string;
  /** 예약 전에 취소된 주문번호면 null */
  trackingNo: string | null;
  status: ShipmentStatus;
  /** true면 택배사 장애로 이미 수거된 뒤 취소가 인정돼 반송한다(택배사 비용) */
  returning: boolean;
  cancelledAt: string;
  returnedAt: string | null;
}

interface OrderCancellationRow {
  courier_order_no: string;
  result: 'CANCELLED' | 'REJECTED';
  is_returning: number;
  cancel_requested_at: number;
  decided_at: number;
  shipment_id: number | null;
}

/**
 * 판정 함수(취소 응답과 같은 규칙). 누른 시각에 2km 밖이면 취소 가능.
 * 2km 안이어도 잠긴 직후 graceMs 안에 눌렀고 지금 아직 수거 전이면 받아준다.
 */
export function isCancellable(plan: RoutePlan, originAt: number, pressedAt: number, now: number, graceMs: number): boolean {
  const stages = timeline(plan);
  const lockedAt = originAt + stages.find((s) => s.status === 'CANCEL_LOCKED')!.atMs;
  const pickedUpAt = originAt + stages.find((s) => s.status === 'PICKED_UP')!.atMs;
  if (pressedAt < lockedAt) return true;
  return pressedAt < lockedAt + graceMs && now < pickedUpAt;
}

function orderCancelView(db: Db, decision: OrderCancellationRow, now: number): OrderCancelView {
  if (decision.shipment_id === null) {
    return {
      courierOrderNo: decision.courier_order_no,
      trackingNo: null,
      status: 'CANCELLED',
      returning: false,
      cancelledAt: toKst(decision.decided_at),
      returnedAt: null,
    };
  }
  const row = catchUp(db, rowById(db, decision.shipment_id), now);
  const view = toView(row, now);
  return {
    courierOrderNo: view.courierOrderNo,
    trackingNo: view.trackingNo,
    status: view.status,
    returning: decision.is_returning === 1,
    cancelledAt: view.cancelledAt ?? toKst(decision.decided_at),
    returnedAt: view.returnedAt,
  };
}

function rejected(): BusinessError {
  return new BusinessError('SHIPMENT_NOT_CANCELLABLE', '기사가 수거지 2km 안에 들어와 취소할 수 없습니다.');
}

export function cancelByOrderNo(
  db: Db,
  courierOrderNo: string,
  cancelRequestedAt: number,
  now: number,
  graceMs: number,
): OrderCancelView {
  // 거절도 판정 기록을 커밋해야 하므로, 트랜잭션은 'REJECTED'를 돌려주고 409는 밖에서 던진다
  const result = transaction(db, (): OrderCancelView | 'REJECTED' => {
    const decided = db
      .prepare(`SELECT * FROM order_cancellations WHERE courier_order_no = ?`)
      .get(courierOrderNo) as OrderCancellationRow | undefined;
    if (decided) {
      // 같은 주문번호는 첫 판정을 그대로 돌려준다
      if (decided.result === 'REJECTED') return 'REJECTED';
      return orderCancelView(db, decided, now);
    }

    const pressedAt = Math.min(cancelRequestedAt, now); // 미래 시각은 받은 시각으로 자른다
    const record = (result: 'CANCELLED' | 'REJECTED', returning: boolean, shipmentId: number | null) => {
      db.prepare(
        `INSERT INTO order_cancellations (courier_order_no, result, is_returning, cancel_requested_at, decided_at, shipment_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(courierOrderNo, result, returning ? 1 : 0, pressedAt, now, shipmentId);
      return db.prepare(`SELECT * FROM order_cancellations WHERE courier_order_no = ?`).get(courierOrderNo) as unknown as OrderCancellationRow;
    };

    const found = findRowByOrderNo(db, courierOrderNo);
    if (!found) return orderCancelView(db, record('CANCELLED', false, null), now); // 예약 전 취소

    // 배송 건을 취소 상태로 바꾸는 길은 이 함수뿐이고 판정 기록이 먼저 남으므로, 여기 오는 건은 진행 중이거나 배송 완료다
    const row = catchUp(db, found, now);

    const plan = planOf(row);
    if (!isCancellable(plan, row.progress_origin_at, pressedAt, now, graceMs)) {
      record('REJECTED', false, row.id);
      return 'REJECTED';
    }

    const shipment = { id: row.id, courierOrderNo: row.courier_order_no, trackingNo: row.tracking_no };
    const times = { ...timesOf(row), CANCELLED: now };
    enqueueWebhook(db, shipment, { status: 'CANCELLED', occurredAt: now }, now);

    // 누른 시각엔 취소 가능했는데 지금은 이미 수거됨 = 택배사 장애. 택배사가 책임지고 반송한다
    const returning = !BEFORE_PICKUP.has(row.status);
    if (returning) {
      times.RETURNING = now;
      enqueueWebhook(db, shipment, { status: 'RETURNING', occurredAt: now, locationName: plan.originBranch }, now);
    }
    db.prepare(`UPDATE shipments SET status = ?, stage_times_json = ?, status_changed_at = ? WHERE id = ?`).run(
      returning ? 'RETURNING' : 'CANCELLED',
      JSON.stringify(times),
      now,
      row.id,
    );
    return orderCancelView(db, record('CANCELLED', returning, row.id), now);
  });
  if (result === 'REJECTED') throw rejected();
  return result;
}
