import type { LatLng } from './geo.js';
import type { Branch, Geocoder } from './planner.js';

/**
 * 공공데이터포털 「우정사업본부_전국 우체국 현황」 CSV → 지점 표(branches.json).
 * 좌표가 없으므로 카카오 주소 검색으로 한 번만 바꿔 저장한다. 실행은 scripts/build-branches.ts.
 */

export interface PostOffice {
  /** 지방우정청 */
  region: string;
  /** 총괄국명 */
  hub: string;
  name: string;
  address: string;
}

/** 따옴표와 따옴표 안의 쉼표·줄바꿈을 처리하는 작은 CSV 파서 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export function parsePostOffices(text: string): PostOffice[] {
  const [header, ...rows] = parseCsv(text);
  const col = (label: string) => {
    const i = header.findIndex((h) => h.trim().startsWith(label));
    if (i < 0) throw new Error(`CSV에 "${label}" 컬럼이 없습니다`);
    return i;
  };
  const [regionI, hubI, nameI, addressI] = [col('지방우정청'), col('총괄국명'), col('우체국명'), col('주소')];
  const tail = header.length - 1 - addressI; // 주소 뒤에 오는 칸 수(전화번호 등)

  return rows.map((r) => ({
    region: r[regionI].trim(),
    hub: r[hubI].trim(),
    name: r[nameI].trim(),
    // 따옴표 없이 주소에 쉼표가 들어가 칸이 늘어난 행: 늘어난 만큼 주소에 다시 붙인다
    address: r
      .slice(addressI, r.length - tail)
      .join(',')
      .trim(),
  }));
}

/**
 * hubs: 총괄국만(집하점 역할, 기본). all: 우편집중국(간선 허브라 동네 수거 지점이 아님)만 빼고 전부.
 */
export function selectBranches(offices: PostOffice[], scope: 'hubs' | 'all'): PostOffice[] {
  if (scope === 'hubs') return offices.filter((o) => o.name === o.hub);
  return offices.filter((o) => !o.name.endsWith('우편집중국'));
}

/** 카카오가 못 읽는 꼬리(괄호 참고 항목, 건물명·층)를 줄여 가며 시도할 주소들 */
export function addressCandidates(address: string): string[] {
  const noParen = address.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const roadNumber = noParen.match(/^(.*?(?:로|길)\s*\d+(?:-\d+)?)(?=[\s,]|$)/)?.[1];
  return [...new Set([noParen, roadNumber].filter((a): a is string => !!a))];
}

export interface BuildOptions {
  /** 원래 주소 → 좌표. 찾은 결과를 여기에 채우므로 파일로 저장해 두면 끊겨도 이어서 할 수 있다 */
  cache: Record<string, LatLng | null>;
  /** 카카오 호출 사이 간격 */
  delayMs: number;
  onProgress?: (done: number, total: number) => void;
}

export async function buildBranchTable(
  offices: PostOffice[],
  geocoder: Geocoder,
  { cache, delayMs, onProgress }: BuildOptions,
): Promise<{ branches: Branch[]; failed: PostOffice[] }> {
  const branches: Branch[] = [];
  const failed: PostOffice[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  for (const [i, office] of offices.entries()) {
    let point = cache[office.address];
    if (point === undefined) {
      point = null;
      for (const candidate of addressCandidates(office.address)) {
        try {
          point = await geocoder.geocode(candidate);
        } catch {
          point = null; // 이 지점만 실패로 넘기고, 캐시에 남기지 않아 다음 실행 때 다시 시도한다
          break;
        }
        if (delayMs > 0) await sleep(delayMs);
        if (point) break;
      }
      if (point) cache[office.address] = point;
    }
    if (point) branches.push({ name: office.name, address: office.address, lat: point.lat, lng: point.lng });
    else failed.push(office);
    onProgress?.(i + 1, offices.length);
  }
  return { branches, failed };
}
