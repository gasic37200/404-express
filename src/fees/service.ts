import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transaction, type Db } from '../db.js';
import { toKst } from '../time.js';
import { enqueueStandaloneWebhook } from '../webhooks/outbox.js';

const zipcode = z.string().regex(/^\d{5}$/, '우편번호는 숫자 5자리여야 합니다');

const zipRange = z
  .object({ from: zipcode, to: zipcode, name: z.string().trim().min(1).max(100) })
  .refine((r) => r.from <= r.to, '구간의 from이 to보다 클 수 없습니다');

const fee = z.number().int('금액은 원 단위 정수여야 합니다').min(0);

/**
 * 배송비 = baseFee + 지역 할증 하나. 지금은 크기·무게가 없어 baseFee가 하나지만,
 * 나중에 크기별 기본 요금이 생겨도 지역 할증은 그대로 더하도록 총액이 아니라 할증으로 둔다.
 */
export const shippingFeeTableSchema = z.object({
  baseFee: fee,
  jejuSurcharge: fee,
  remoteSurcharge: fee,
  jejuZipcodes: z.array(zipRange),
  remoteZipcodes: z.array(zipRange),
});

export type ShippingFeeTable = z.infer<typeof shippingFeeTableSchema>;

export interface ShippingFeeView extends ShippingFeeTable {
  version: number;
  updatedAt: string;
}

/** 웹훅·조회 응답에 쓰는 status */
export const SHIPPING_FEES_CHANGED = 'SHIPPING_FEES_CHANGED';

interface VersionRow {
  version: number;
  table_json: string;
  content_hash: string;
  created_at: number;
}

const inRanges = (ranges: ShippingFeeTable['jejuZipcodes'], zip: string) => ranges.some((r) => r.from <= zip && zip <= r.to);

/** 배송지 우편번호의 지역 할증. 하나만 붙는다: 도서산간 → 제주 → 없음 (제주 안 섬은 도서산간 할증만) */
export function surchargeFor(table: ShippingFeeTable, zip: string): number {
  if (inRanges(table.remoteZipcodes, zip)) return table.remoteSurcharge;
  if (inRanges(table.jejuZipcodes, zip)) return table.jejuSurcharge;
  return 0;
}

/** 배송지 우편번호의 배송비 = 기본 요금 + 지역 할증. market이 같은 규칙으로 계산한다 */
export function feeFor(table: ShippingFeeTable, zip: string): number {
  return table.baseFee + surchargeFor(table, zip);
}

/** 파일의 설명(source) 같은 다른 필드는 버리고 계약 필드만 남긴다 */
function normalize(table: ShippingFeeTable): ShippingFeeTable {
  const ranges = (rs: ShippingFeeTable['jejuZipcodes']) => rs.map(({ from, to, name }) => ({ from, to, name }));
  return {
    baseFee: table.baseFee,
    jejuSurcharge: table.jejuSurcharge,
    remoteSurcharge: table.remoteSurcharge,
    jejuZipcodes: ranges(table.jejuZipcodes),
    remoteZipcodes: ranges(table.remoteZipcodes),
  };
}

const hashOf = (table: ShippingFeeTable) => createHash('sha256').update(JSON.stringify(table)).digest('hex');

function latestRow(db: Db): VersionRow | undefined {
  return db.prepare(`SELECT * FROM shipping_fee_versions ORDER BY version DESC LIMIT 1`).get() as VersionRow | undefined;
}

function toView(row: VersionRow): ShippingFeeView {
  return { version: row.version, updatedAt: toKst(row.created_at), ...(JSON.parse(row.table_json) as ShippingFeeTable) };
}

/** 새 버전을 저장하고, 같은 트랜잭션에서 요금표 전체를 실은 변경 웹훅을 outbox에 넣는다 */
function insertVersion(db: Db, table: ShippingFeeTable, now: number): VersionRow {
  const version = (latestRow(db)?.version ?? 0) + 1;
  db.prepare(`INSERT INTO shipping_fee_versions (version, table_json, content_hash, created_at) VALUES (?, ?, ?, ?)`).run(
    version,
    JSON.stringify(table),
    hashOf(table),
    now,
  );
  const row = latestRow(db)!;
  const { version: v, updatedAt, ...rest } = toView(row);
  enqueueStandaloneWebhook(db, { status: SHIPPING_FEES_CHANGED, occurredAt: now, version: v, updatedAt, ...rest }, now);
  return row;
}

/** 요금표가 비어 있으면 초기 파일을 버전 1로 넣는다. 이미 있으면 아무것도 하지 않는다(재시작해도 버전 유지). */
export function seedShippingFees(db: Db, initial: ShippingFeeTable, now: number): void {
  const table = normalize(shippingFeeTableSchema.parse(initial));
  transaction(db, () => {
    if (!latestRow(db)) insertVersion(db, table, now);
  });
}

export function getShippingFees(db: Db): ShippingFeeView | null {
  const row = latestRow(db);
  return row ? toView(row) : null;
}

/** 바꾸면 버전을 올리고 웹훅을 보낸다. 지금과 같은 내용이면 버전을 올리지 않는다(멱등). */
export function updateShippingFees(db: Db, input: ShippingFeeTable, now: number): ShippingFeeView {
  const table = normalize(input);
  return transaction(db, () => {
    const current = latestRow(db);
    if (current && current.content_hash === hashOf(table)) return toView(current);
    return toView(insertVersion(db, table, now));
  });
}
