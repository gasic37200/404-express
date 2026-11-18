/**
 * 우체국 CSV → branches/branches.json (지점 이름·주소·좌표).
 *
 *   npm run branches:build              # 총괄국만 (기본)
 *   npm run branches:build -- --all     # 우편집중국만 빼고 전부
 *
 * 입력: data/post-offices.csv (공공데이터포털 「우정사업본부_전국 우체국 현황」, git 제외)
 * 키: .env의 KAKAO_REST_API_KEY. 찾은 좌표는 data/geocode-cache.json에 남겨, 끊겨도 이어서 돌린다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildBranchTable, parsePostOffices, selectBranches } from '../src/routing/branchTable.js';
import { kakaoGeocoder } from '../src/routing/kakao.js';

const INPUT = 'data/post-offices.csv';
const CACHE = 'data/geocode-cache.json';
const OUTPUT = process.env.BRANCHES_PATH || 'branches/branches.json';

const apiKey = process.env.KAKAO_REST_API_KEY ?? '';
if (!apiKey) throw new Error('.env에 KAKAO_REST_API_KEY가 필요합니다.');
if (!existsSync(INPUT)) throw new Error(`${INPUT}가 없습니다. 공공데이터포털에서 받은 CSV를 이 이름으로 넣으세요.`);

const scope = process.argv.includes('--all') ? 'all' : 'hubs';
const offices = selectBranches(parsePostOffices(readFileSync(INPUT, 'utf8')), scope);
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
console.log(`지점 ${offices.length}곳 (${scope}), 캐시 ${Object.keys(cache).length}건`);

const saveCache = () => writeFileSync(CACHE, JSON.stringify(cache, null, 2));
const { branches, failed } = await buildBranchTable(offices, kakaoGeocoder(apiKey, 5000), {
  cache,
  delayMs: 100,
  onProgress: (done, total) => {
    if (done % 50 === 0 || done === total) {
      saveCache();
      console.log(`  ${done}/${total}`);
    }
  },
});
saveCache();

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(branches, null, 2) + '\n');
console.log(`저장: ${OUTPUT} (${branches.length}곳)`);
if (failed.length > 0) {
  console.warn(`좌표를 못 찾은 지점 ${failed.length}곳 (표에서 빠짐):`);
  for (const o of failed) console.warn(`  - ${o.name}: ${o.address}`);
}
