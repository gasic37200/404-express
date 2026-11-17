import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  courier_order_no   TEXT    NOT NULL UNIQUE,  -- 서버가 보낸 Idempotency-Key
  request_hash       TEXT    NOT NULL,         -- 같은 키로 다른 본문이 오는지 판별
  tracking_no        TEXT    UNIQUE,           -- 택배사가 발급하는 송장번호
  status             TEXT    NOT NULL,
  sender_json        TEXT    NOT NULL,
  receiver_json      TEXT    NOT NULL,
  item_summary       TEXT    NOT NULL,
  plan_json          TEXT    NOT NULL,         -- 예약 때 정한 경로 계획(거리·지점·속도). 남은 거리는 저장하지 않고 계산
  progress_origin_at INTEGER NOT NULL,         -- 진행 기준 시각. 보통 예약 시각, admin 진행 때 당겨진다
  stage_times_json   TEXT    NOT NULL,         -- 상태별로 실제 반영된 시각 {status: epoch ms}
  booked_at          INTEGER NOT NULL,
  status_changed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments (status);

-- 주문번호 취소의 첫 판정. 같은 주문번호가 다시 오면 이 결과를 그대로 돌려준다.
-- 예약 전에 온 취소도 여기 남아, 늦게 온 같은 주문번호 예약을 막는다.
CREATE TABLE IF NOT EXISTS order_cancellations (
  courier_order_no    TEXT    PRIMARY KEY,
  result              TEXT    NOT NULL,      -- CANCELLED | REJECTED
  is_returning        INTEGER NOT NULL,      -- 1이면 수거 뒤 취소 인정(반송). returning은 SQLite 예약어라 못 씀
  cancel_requested_at INTEGER NOT NULL,      -- 판정에 쓴 시각(미래 값은 받은 시각으로 자름)
  decided_at          INTEGER NOT NULL,
  shipment_id         INTEGER REFERENCES shipments (id)
);

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT    NOT NULL UNIQUE,
  shipment_id     INTEGER NOT NULL REFERENCES shipments (id),
  payload_json    TEXT    NOT NULL,
  status          TEXT    NOT NULL,          -- PENDING | SENT | DEAD
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_shipment ON webhook_outbox (shipment_id, status, id);
`;

/**
 * 마이그레이션이 없으므로, 예전 스키마(경로 계획 이전)의 DB 파일이면 조용히 망가지지 않게 바로 멈춘다.
 * 개발 모드라 해당 DB 파일(운영은 courier-data 볼륨)을 지우고 다시 띄우면 된다.
 */
function assertSchemaCompatible(db: Db): void {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('shipments')`).all() as { name: string }[];
  if (columns.length > 0 && !columns.some((c) => c.name === 'plan_json')) {
    throw new Error('DB 스키마가 예전 버전입니다(plan_json 없음). 개발 모드이므로 DB 파일을 지우고 다시 시작하세요.');
  }
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  assertSchemaCompatible(db);
  db.exec(SCHEMA);
  return db;
}

/** node:sqlite에는 transaction 헬퍼가 없어서 직접 감싼다. 동기 함수만 넘길 것. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
