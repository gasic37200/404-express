import express from 'express';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { requireKey } from './http/auth.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { ok } from './http/response.js';
import { adminShipmentRoutes, shipmentRoutes } from './shipments/routes.js';
import type { Clock } from './time.js';
import { adminWebhookRoutes } from './webhooks/routes.js';

export interface AppDeps {
  db: Db;
  clock: Clock;
  config: Pick<Config, 'courierApiKey' | 'adminApiKey'>;
}

export function createApp({ db, clock, config }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.json(ok('ok'));
  });

  app.use('/api/v1/shipments', requireKey('X-Api-Key', config.courierApiKey), shipmentRoutes(db, clock));

  if (config.adminApiKey) {
    const admin = requireKey('X-Admin-Key', config.adminApiKey);
    app.use('/api/v1/admin/shipments', admin, adminShipmentRoutes(db, clock));
    app.use('/api/v1/admin/webhooks', admin, adminWebhookRoutes(db, clock));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
