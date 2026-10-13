import { Router } from 'express';
import type { Db } from '../db.js';
import { BusinessError } from '../http/errors.js';
import { created, ok } from '../http/response.js';
import type { Clock } from '../time.js';
import { COURIER_ORDER_NO_PATTERN, reserveRequestSchema } from './schema.js';
import { advance, cancel, getShipment, reserve } from './service.js';

function parseReserveBody(body: unknown) {
  const result = reserveRequestSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new BusinessError('INVALID_FIELD_ERROR', `${issue.path.join('.')}: ${issue.message}`);
  }
  return result.data;
}

export function shipmentRoutes(db: Db, clock: Clock): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const key = req.header('Idempotency-Key');
    if (!key || !COURIER_ORDER_NO_PATTERN.test(key)) throw new BusinessError('INVALID_IDEMPOTENCY_KEY');
    const request = parseReserveBody(req.body);

    const { shipment, created: isNew } = reserve(db, key, request, clock());
    if (isNew) {
      res.status(201).json(created('택배 예약이 완료되었습니다.', shipment));
    } else {
      res.status(200).json(ok('이미 예약된 배송 건입니다.', shipment));
    }
  });

  router.get('/:trackingNo', (req, res) => {
    res.json(ok('배송 조회에 성공했습니다.', getShipment(db, req.params.trackingNo)));
  });

  router.post('/:trackingNo/cancel', (req, res) => {
    res.json(ok('택배 접수가 취소되었습니다.', cancel(db, req.params.trackingNo, clock())));
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
