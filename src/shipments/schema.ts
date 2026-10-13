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

export type Party = z.infer<typeof party>;
export type ReserveRequest = z.infer<typeof reserveRequestSchema>;
