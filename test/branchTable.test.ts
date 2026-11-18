import { describe, expect, it } from 'vitest';
import { addressCandidates, buildBranchTable, parseCsv, parsePostOffices, selectBranches } from '../src/routing/branchTable.js';
import type { Geocoder } from '../src/routing/planner.js';

const CSV = [
  '﻿지방우정청,총괄국명,우체국명, 우편번호 , 주소(도로명) , 전화번호 ',
  '서울지방우정청,서울중앙우체국,서울중앙우체국,04535,서울특별시 중구 소공로 70 (충무로1가),02-6450-1114',
  '서울지방우정청,서울중앙우체국,서울태평로우체국,04512,"서울특별시 중구 칠패로 42, 우리빌딩 2층 (봉래동1가)",02-6949-6941',
  '서울지방우정청,서울중앙우체국,서울중앙우편집중국,04535,서울특별시 중구 소공로 1,02-1',
  '부산지방우정청,해운대우체국,해운대우체국,48095,부산광역시 해운대구 해운대로 553 (우동),051-1',
  '',
].join('\r\n');

describe('CSV 읽기', () => {
  it('BOM과 따옴표 안 쉼표를 처리한다', () => {
    const rows = parseCsv(CSV);
    expect(rows[0][0]).toBe('지방우정청');
    expect(rows[2][4]).toBe('서울특별시 중구 칠패로 42, 우리빌딩 2층 (봉래동1가)');
    expect(rows).toHaveLength(5);
  });

  it('머리글 공백을 무시하고 우체국 목록으로 바꾼다', () => {
    const offices = parsePostOffices(CSV);
    expect(offices[1]).toEqual({
      region: '서울지방우정청',
      hub: '서울중앙우체국',
      name: '서울태평로우체국',
      address: '서울특별시 중구 칠패로 42, 우리빌딩 2층 (봉래동1가)',
    });
  });

  it('따옴표 없이 쉼표가 들어가 칸이 늘어난 행은 주소 뒤 칸을 주소에 붙인다', () => {
    const csv = '지방우정청,총괄국명,우체국명,우편번호,주소(도로명),전화번호\nA,B,C,1,경기도 어딘가 1,2층,031-1';
    expect(parsePostOffices(csv)[0].address).toBe('경기도 어딘가 1,2층');
  });
});

describe('지점 고르기', () => {
  const offices = parsePostOffices(CSV);

  it('기본은 총괄국만', () => {
    expect(selectBranches(offices, 'hubs').map((o) => o.name)).toEqual(['서울중앙우체국', '해운대우체국']);
  });

  it('all이면 우편집중국만 빼고 전부', () => {
    expect(selectBranches(offices, 'all').map((o) => o.name)).toEqual(['서울중앙우체국', '서울태평로우체국', '해운대우체국']);
  });
});

describe('주소 후보', () => {
  it('괄호 참고 항목을 빼고, 안 되면 건물번호까지만', () => {
    expect(addressCandidates('서울특별시 중구 칠패로 42, 우리빌딩 2층 (봉래동1가)')).toEqual([
      '서울특별시 중구 칠패로 42, 우리빌딩 2층',
      '서울특별시 중구 칠패로 42',
    ]);
  });

  it('이미 짧으면 하나만', () => {
    expect(addressCandidates('부산광역시 해운대구 해운대로 553 (우동)')).toEqual(['부산광역시 해운대구 해운대로 553']);
  });
});

describe('지점 표 만들기', () => {
  const offices = selectBranches(parsePostOffices(CSV), 'all');

  it('후보를 차례로 시도하고, 끝까지 못 찾은 지점은 실패 목록으로', async () => {
    const calls: string[] = [];
    const geocoder: Geocoder = {
      geocode: async (address) => {
        calls.push(address);
        if (address === '서울특별시 중구 소공로 70') return { lat: 37.56, lng: 126.98 };
        if (address === '서울특별시 중구 칠패로 42') return { lat: 37.559, lng: 126.972 };
        return null;
      },
    };
    const { branches, failed } = await buildBranchTable(offices, geocoder, { cache: {}, delayMs: 0 });
    expect(branches).toEqual([
      { name: '서울중앙우체국', address: '서울특별시 중구 소공로 70 (충무로1가)', lat: 37.56, lng: 126.98 },
      { name: '서울태평로우체국', address: '서울특별시 중구 칠패로 42, 우리빌딩 2층 (봉래동1가)', lat: 37.559, lng: 126.972 },
    ]);
    expect(failed.map((o) => o.name)).toEqual(['해운대우체국']);
    expect(calls).toContain('서울특별시 중구 칠패로 42, 우리빌딩 2층');
  });

  it('캐시에 있는 주소는 다시 부르지 않는다 (중간에 끊겨도 이어서)', async () => {
    let count = 0;
    const geocoder: Geocoder = { geocode: async () => (count++, { lat: 1, lng: 1 }) };
    const cache = { '서울특별시 중구 소공로 70 (충무로1가)': { lat: 37.56, lng: 126.98 } };
    const { branches } = await buildBranchTable(offices, geocoder, { cache, delayMs: 0 });
    expect(branches[0]).toMatchObject({ name: '서울중앙우체국', lat: 37.56 });
    expect(count).toBe(2);
    expect(Object.keys(cache)).toHaveLength(3); // 새로 찾은 것도 캐시에 들어감
  });

  it('지오코더 오류는 그 지점만 실패로 넘긴다', async () => {
    const geocoder: Geocoder = { geocode: async () => Promise.reject(new Error('HTTP 429')) };
    const { branches, failed } = await buildBranchTable(offices, geocoder, { cache: {}, delayMs: 0 });
    expect(branches).toHaveLength(0);
    expect(failed).toHaveLength(3);
  });
});
