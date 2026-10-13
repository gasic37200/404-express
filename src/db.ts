import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  courier_order_no TEXT    NOT NULL UNIQUE,  -- 서버가 보낸 Idempotency-Key
  request_hash     TEXT    NOT NULL,         -- 같은 키로 다른 본문이 오는지 판별
  tracking_no      TEXT    UNIQUE,           -- 택배사가 발급하는 송장번호
  status           TEXT    NOT NULL,
  sender_json      TEXT    NOT NULL,
  receiver_json    TEXT    NOT NULL,
  item_summary     TEXT    NOT NULL,
  booked_at        INTEGER NOT NULL,
  picked_up_at     INTEGER,
  in_transit_at    INTEGER,
  delivered_at     INTEGER,
  cancelled_at     INTEGER,
  status_changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments (status, status_changed_at);

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

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
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
