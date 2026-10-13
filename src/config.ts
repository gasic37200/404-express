export interface Config {
  port: number;
  dbPath: string;
  courierApiKey: string;
  /** 비어 있으면 admin API를 열지 않는다. */
  adminApiKey: string;
  webhookUrl: string;
  webhookApiKey: string;
  webhookTimeoutMs: number;
  autoProgress: boolean;
  /** 각 상태에 머무는 시간 (ms) */
  delays: {
    pickup: number;
    inTransit: number;
    delivery: number;
  };
  progressTickMs: number;
  outboxTickMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`환경변수 ${name}가 필요합니다.`);
  return value;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`환경변수 ${name}는 0 이상의 정수여야 합니다.`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env, 'PORT', 3000),
    dbPath: env.DB_PATH || './data/courier.db',
    courierApiKey: required(env, 'COURIER_API_KEY'),
    adminApiKey: env.ADMIN_API_KEY ?? '',
    webhookUrl: required(env, 'WEBHOOK_URL'),
    webhookApiKey: required(env, 'WEBHOOK_API_KEY'),
    webhookTimeoutMs: int(env, 'WEBHOOK_TIMEOUT_MS', 5000),
    autoProgress: (env.AUTO_PROGRESS ?? 'true') !== 'false',
    delays: {
      pickup: int(env, 'PICKUP_DELAY_SEC', 180) * 1000,
      inTransit: int(env, 'IN_TRANSIT_DELAY_SEC', 120) * 1000,
      delivery: int(env, 'DELIVERY_DELAY_SEC', 120) * 1000,
    },
    progressTickMs: int(env, 'PROGRESS_TICK_MS', 5000),
    outboxTickMs: int(env, 'OUTBOX_TICK_MS', 2000),
  };
}
