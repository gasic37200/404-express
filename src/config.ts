import { DEFAULT_RETRY_DELAYS_MS } from './webhooks/outbox.js';

export interface Config {
  port: number;
  dbPath: string;
  courierApiKey: string;
  /** 비어 있으면 admin API를 열지 않는다. */
  adminApiKey: string;
  webhookUrl: string;
  webhookApiKey: string;
  webhookTimeoutMs: number;
  /** 웹훅 재전송 간격 (ms). 길이 = 최대 재전송 횟수 */
  webhookRetryDelaysMs: number[];
  autoProgress: boolean;
  routing: {
    /** 카카오 주소 검색 키. 비면 좌표 변환 없이 기본 거리로 진행 */
    kakaoRestApiKey: string;
    geocodeTimeoutMs: number;
    /** 우체국 지점 표(JSON) 경로 */
    branchesPath: string;
    localSpeedKmh: number;
    linehaulSpeedKmh: number;
    hubDwellSec: number;
    /** 시연용 배율. 속도는 곱하고 대기 시간은 나눈다 */
    speedMultiplier: number;
    defaultLocalDistanceM: number;
    defaultLinehaulDistanceM: number;
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

/** 0보다 큰 정수 (속도·배율처럼 0이면 진행이 멈추는 값) */
function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = int(env, name, fallback);
  if (value === 0) throw new Error(`환경변수 ${name}는 0보다 커야 합니다.`);
  return value;
}

/** "60,300,1800" 꼴의 초 목록 */
function secondsList(env: NodeJS.ProcessEnv, name: string, fallbackMs: readonly number[]): number[] {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return [...fallbackMs];
  const values = raw.split(',').map((part) => Number(part.trim()));
  if (values.some((v) => !Number.isInteger(v) || v < 0)) {
    throw new Error(`환경변수 ${name}는 쉼표로 구분한 0 이상의 정수(초) 목록이어야 합니다.`);
  }
  return values.map((v) => v * 1000);
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
    webhookRetryDelaysMs: secondsList(env, 'WEBHOOK_RETRY_DELAYS_SEC', DEFAULT_RETRY_DELAYS_MS),
    autoProgress: (env.AUTO_PROGRESS ?? 'true') !== 'false',
    routing: {
      kakaoRestApiKey: env.KAKAO_REST_API_KEY ?? '',
      geocodeTimeoutMs: int(env, 'GEOCODE_TIMEOUT_MS', 2000),
      branchesPath: env.BRANCHES_PATH || './branches/branches.json',
      localSpeedKmh: positive(env, 'LOCAL_SPEED_KMH', 30),
      linehaulSpeedKmh: positive(env, 'LINEHAUL_SPEED_KMH', 80),
      hubDwellSec: int(env, 'HUB_DWELL_SEC', 1800),
      speedMultiplier: positive(env, 'SPEED_MULTIPLIER', 1),
      defaultLocalDistanceM: int(env, 'DEFAULT_LOCAL_DISTANCE_M', 5000),
      defaultLinehaulDistanceM: int(env, 'DEFAULT_LINEHAUL_DISTANCE_M', 30000),
    },
    progressTickMs: int(env, 'PROGRESS_TICK_MS', 5000),
    outboxTickMs: int(env, 'OUTBOX_TICK_MS', 2000),
  };
}
