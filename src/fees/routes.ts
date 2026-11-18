import { Router } from 'express';
import type { Db } from '../db.js';
import { BusinessError } from '../http/errors.js';
import { ok } from '../http/response.js';
import type { Clock } from '../time.js';
import { getShippingFees, shippingFeeTableSchema, updateShippingFees } from './service.js';

export function shippingFeeRoutes(db: Db): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const fees = getShippingFees(db);
    if (!fees) throw new BusinessError('RESOURCE_NOT_FOUND', '배송비 요금표가 아직 없습니다.');
    res.json(ok('배송비 요금표 조회에 성공했습니다.', fees));
  });

  return router;
}

export function adminShippingFeeRoutes(db: Db, clock: Clock): Router {
  const router = Router();

  router.put('/', (req, res) => {
    const result = shippingFeeTableSchema.safeParse(req.body ?? {});
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new BusinessError('INVALID_FIELD_ERROR', `${issue.path.map(String).join('.')}: ${issue.message}`);
    }
    res.json(ok('배송비 요금표를 저장했습니다.', updateShippingFees(db, result.data, clock())));
  });

  return router;
}
