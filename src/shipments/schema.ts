import { z } from 'zod';

// 서버가 만드는 키: shipment-yyyyMMdd-일련번호6자리
export const COURIER_ORDER_NO_PATTERN = /^shipment-\d{8}-\d{6}$/;

const party = z.object({
  name: z.string().trim().min(1).max(50),
  phone: z.string().trim().min(1).max(20),
  address: z.string().trim().min(1).max(255),
});

export const reserveRequestSchema = z.object({
  sender: party,
  receiver: party,
  itemSummary: z.string().trim().min(1).max(255),
});

// 시간대 표기가 꼭 있는 ISO-8601 (예: 2026-10-08T15:00:00+09:00)
const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export const orderCancelRequestSchema = z.object({
  /** 구매자가 취소를 누른 시각. market이 CANCEL_PENDING으로 바꿀 때 함께 저장한 값 */
  cancelRequestedAt: z
    .string()
    .regex(OFFSET_DATE_TIME, '시간대가 포함된 ISO-8601 시각이어야 합니다 (예: 2026-10-08T15:00:00+09:00)')
    .refine((value) => !Number.isNaN(Date.parse(value)), '존재하지 않는 시각입니다'),
});

export type Party = z.infer<typeof party>;
export type ReserveRequest = z.infer<typeof reserveRequestSchema>;
