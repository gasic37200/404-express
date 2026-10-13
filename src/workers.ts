import type { Config } from './config.js';
import type { Db } from './db.js';
import { advanceDue } from './shipments/service.js';
import type { Clock } from './time.js';
import { dispatchDue } from './webhooks/outbox.js';

/** 이전 실행이 끝나기 전에 다음 tick이 겹치지 않게 하는 반복 실행기 */
function every(ms: number, task: () => unknown | Promise<unknown>): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (e) {
      console.error('[worker] 실행 실패', e);
    } finally {
      running = false;
    }
  }, ms);
  return () => clearInterval(timer);
}

export function startWorkers(db: Db, clock: Clock, config: Config): () => void {
  const stops: (() => void)[] = [];

  if (config.autoProgress) {
    stops.push(every(config.progressTickMs, () => advanceDue(db, config.delays, clock())));
  }
  stops.push(
    every(config.outboxTickMs, () =>
      dispatchDue({
        db,
        clock,
        webhookUrl: config.webhookUrl,
        webhookApiKey: config.webhookApiKey,
        timeoutMs: config.webhookTimeoutMs,
        log: console,
      }),
    ),
  );

  return () => stops.forEach((stop) => stop());
}
