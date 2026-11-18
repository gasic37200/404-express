import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';

// 마이그레이션이 없으므로 예전 DB 파일이면 조용히 망가지지 않게 기동 때 멈춰야 한다
describe('예전 스키마 DB 파일', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  const oldDb = (sql: string) => {
    const dir = mkdtempSync(join(tmpdir(), '404-db-'));
    dirs.push(dir);
    const path = join(dir, 'old.db');
    const db = new DatabaseSync(path);
    db.exec(sql);
    db.close();
    return path;
  };

  it('shipments에 plan_json이 없으면 멈춘다', () => {
    const path = oldDb('CREATE TABLE shipments (id INTEGER PRIMARY KEY, status TEXT)');
    expect(() => openDb(path)).toThrow('plan_json');
  });

  it('webhook_outbox.shipment_id가 NOT NULL이면 멈춘다', () => {
    const path = oldDb(
      'CREATE TABLE shipments (id INTEGER PRIMARY KEY, plan_json TEXT); CREATE TABLE webhook_outbox (id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL)',
    );
    expect(() => openDb(path)).toThrow('webhook_outbox.shipment_id');
  });

  it('새 DB는 그대로 연다', () => {
    expect(() => openDb(':memory:').close()).not.toThrow();
  });
});
