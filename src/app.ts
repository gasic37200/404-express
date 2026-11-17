import express from 'express';
import { DEFAULT_CANCEL_GRACE_MS, type Config } from './config.js';
import type { Db } from './db.js';
import { requireKey } from './http/auth.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { ok } from './http/response.js';
import type { Planner } from './routing/planner.js';
import { adminShipmentRoutes, shipmentRoutes } from './shipments/routes.js';
import type { Clock } from './time.js';
import { adminWebhookRoutes } from './webhooks/routes.js';

export interface AppDeps {
  db: Db;
  clock: Clock;
  /** 예약 요청 → 경로 계획(좌표 변환·가까운 지점·거리) */
  planner: Planner;
  config: Pick<Config, 'courierApiKey' | 'adminApiKey'> & Partial<Pick<Config, 'cancelGraceMs'>>;
}

export function createApp({ db, clock, planner, config }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.json(ok('ok'));
  });

  app.use('/api/v1/shipments', requireKey('X-Api-Key', config.courierApiKey), shipmentRoutes(db, clock, planner, config.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS));

  if (config.adminApiKey) {
    const admin = requireKey('X-Admin-Key', config.adminApiKey);
    app.use('/api/v1/admin/shipments', admin, adminShipmentRoutes(db, clock));
    app.use('/api/v1/admin/webhooks', admin, adminWebhookRoutes(db, clock));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
