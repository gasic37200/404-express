import { Router } from 'express';
import type { Db } from '../db.js';
import { BusinessError } from '../http/errors.js';
import { created, ok } from '../http/response.js';
import type { Planner } from '../routing/planner.js';
import type { Clock } from '../time.js';
import { COURIER_ORDER_NO_PATTERN, orderCancelRequestSchema, reserveRequestSchema } from './schema.js';
import {
  advance,
  cancelByOrderNo,
  findExistingReservation,
  getShipment,
  getShipmentByOrderNo,
  reserve,
} from './service.js';

function parseBody<T>(schema: { safeParse(body: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new BusinessError('INVALID_FIELD_ERROR', `${issue.path.map(String).join('.')}: ${issue.message}`);
  }
  return result.data;
}

const parseReserveBody = (body: unknown) => parseBody(reserveRequestSchema, body);

export function shipmentRoutes(db: Db, clock: Clock, planner: Planner, cancelGraceMs: number): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const key = req.header('Idempotency-Key');
    if (!key || !COURIER_ORDER_NO_PATTERN.test(key)) throw new BusinessError('INVALID_IDEMPOTENCY_KEY');
    const request = parseReserveBody(req.body);

    // 같은 키 재요청은 좌표 변환(외부 호출) 없이 바로 돌려준다
    const existing = findExistingReservation(db, key, request, clock());
    if (existing) {
      res.status(200).json(ok('이미 예약된 배송 건입니다.', existing));
      return;
    }
    // 경로 계획은 네트워크 호출이라 트랜잭션 밖에서 한다
    const plan = await planner(request);
    const { shipment, created: isNew } = reserve(db, key, request, plan, clock());
    if (isNew) {
      res.status(201).json(created('택배 예약이 완료되었습니다.', shipment));
    } else {
      res.status(200).json(ok('이미 예약된 배송 건입니다.', shipment));
    }
  });

  router.post('/byOrderNo/:courierOrderNo/cancel', (req, res) => {
    const { courierOrderNo } = req.params;
    if (!COURIER_ORDER_NO_PATTERN.test(courierOrderNo)) {
      throw new BusinessError('INVALID_FIELD_ERROR', 'courierOrderNo: 형식이 올바르지 않습니다 (shipment-yyyyMMdd-NNNNNN)');
    }
    const { cancelRequestedAt } = parseBody(orderCancelRequestSchema, req.body);
    const result = cancelByOrderNo(db, courierOrderNo, Date.parse(cancelRequestedAt), clock(), cancelGraceMs);
    res.json(ok(result.returning ? '취소가 인정되어 반송합니다.' : '택배 접수가 취소되었습니다.', result));
  });

  router.get('/byOrderNo/:courierOrderNo', (req, res) => {
    res.json(ok('배송 조회에 성공했습니다.', getShipmentByOrderNo(db, req.params.courierOrderNo, clock())));
  });

  router.get('/:trackingNo', (req, res) => {
    res.json(ok('배송 조회에 성공했습니다.', getShipment(db, req.params.trackingNo, clock())));
  });

  return router;
}

export function adminShipmentRoutes(db: Db, clock: Clock): Router {
  const router = Router();

  router.post('/:trackingNo/advance', (req, res) => {
    res.json(ok('배송 상태를 다음 단계로 진행했습니다.', advance(db, req.params.trackingNo, clock())));
  });

  return router;
}
