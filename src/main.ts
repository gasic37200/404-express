import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { seedShippingFees } from './fees/service.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { loadBranches } from './routing/branches.js';
import { kakaoGeocoder } from './routing/kakao.js';
import { createPlanner } from './routing/planner.js';
import { systemClock } from './time.js';
import { startWorkers } from './workers.js';

const config = loadConfig();
const db = openDb(config.dbPath);
// 요금표가 비어 있으면 초기 파일을 버전 1로 넣는다(변경 웹훅도 나간다). 이미 있으면 그대로
seedShippingFees(db, JSON.parse(readFileSync(config.shippingFeesPath, 'utf8')), systemClock());
const { routing } = config;
if (!routing.kakaoRestApiKey) console.warn('[routing] KAKAO_REST_API_KEY 없음, 모든 예약을 기본 거리로 진행');
const planner = createPlanner({
  geocoder: kakaoGeocoder(routing.kakaoRestApiKey, routing.geocodeTimeoutMs),
  branches: loadBranches(routing.branchesPath),
  speeds: {
    localKmh: routing.localSpeedKmh,
    linehaulKmh: routing.linehaulSpeedKmh,
    dwellSec: routing.hubDwellSec,
    multiplier: routing.speedMultiplier,
  },
  defaults: { localM: routing.defaultLocalDistanceM, linehaulM: routing.defaultLinehaulDistanceM },
  log: console,
});
const app = createApp({ db, clock: systemClock, planner, config });
const stopWorkers = startWorkers(db, systemClock, config);

const server = app.listen(config.port, () => {
  console.log(`404-express listening on :${config.port} (autoProgress=${config.autoProgress})`);
});

function shutdown() {
  stopWorkers();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
