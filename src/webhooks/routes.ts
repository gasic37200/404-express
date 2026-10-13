import { Router } from 'express';
import type { Db } from '../db.js';
import { BusinessError } from '../http/errors.js';
import { ok } from '../http/response.js';
import type { Clock } from '../time.js';
import { listEvents, retryDeadEvent, type OutboxStatus } from './outbox.js';

const STATUSES: readonly OutboxStatus[] = ['PENDING', 'SENT', 'DEAD'];

export function adminWebhookRoutes(db: Db, clock: Clock): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const status = req.query.status;
    if (status !== undefined && !STATUSES.includes(status as OutboxStatus)) {
      throw new BusinessError('INVALID_FIELD_ERROR', `status: ${STATUSES.join(', ')} 중 하나여야 합니다.`);
    }
    res.json(ok('웹훅 이벤트 조회에 성공했습니다.', listEvents(db, status as OutboxStatus | undefined)));
  });

  router.post('/:eventId/retry', (req, res) => {
    res.json(ok('웹훅 재전송을 예약했습니다.', retryDeadEvent(db, req.params.eventId, clock())));
  });

  return router;
}
