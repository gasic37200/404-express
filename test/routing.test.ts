import { describe, expect, it } from 'vitest';
import { haversineMeters } from '../src/routing/geo.js';
import { kakaoGeocoder } from '../src/routing/kakao.js';
import { createPlanner, type Geocoder } from '../src/routing/planner.js';
import { remainingAt, timeline, type RoutePlan } from '../src/routing/timeline.js';

// 계산하기 쉬운 계획: 근거리 10m/s, 간선 20m/s, 집하 대기 60초
const PLAN: RoutePlan = {
  pickupM: 6000,
  linehaulM: 20000,
  deliveryM: 3000,
  originBranch: '강남우체국',
  destBranch: '해운대우체국',
  localMps: 10,
  linehaulMps: 20,
  dwellMs: 60_000,
};

describe('하버사인 거리', () => {
  it('서울시청 ↔ 부산시청은 약 325km', () => {
    const m = haversineMeters({ lat: 37.5663, lng: 126.9779 }, { lat: 35.1798, lng: 129.075 });
    expect(m / 1000).toBeGreaterThan(320);
    expect(m / 1000).toBeLessThan(330);
  });

  it('같은 점은 0', () => {
    expect(haversineMeters({ lat: 37.5, lng: 127 }, { lat: 37.5, lng: 127 })).toBe(0);
  });
});

describe('단계 시각표', () => {
  it('시작 거리가 5km를 넘으면 모든 단계를 순서대로 지난다', () => {
    expect(timeline(PLAN).map((s) => [s.status, s.atMs / 1000, s.remainingDistanceMeters, s.locationName])).toEqual([
      ['NEAR_5KM', 100, 5000, '강남우체국'],
      ['CANCEL_LOCKED', 400, 2000, '강남우체국'],
      ['PICKED_UP', 600, 0, '강남우체국'],
      ['ARRIVED_ORIGIN', 1200, undefined, '강남우체국'], // 기사가 지점으로 돌아옴
      ['IN_TRANSIT', 1260, 20000, '강남우체국'],
      ['ARRIVED_DEST', 2260, undefined, '해운대우체국'],
      ['OUT_FOR_DELIVERY', 2320, 3000, '해운대우체국'],
      ['DELIVERED', 2620, 0, '해운대우체국'],
    ]);
  });

  it('시작 거리가 5km 이하면 NEAR_5KM 없이 2km에서 잠긴다', () => {
    const stages = timeline({ ...PLAN, pickupM: 4000 });
    expect(stages[0]).toMatchObject({ status: 'CANCEL_LOCKED', atMs: 200_000, remainingDistanceMeters: 2000 });
  });

  it('시작 거리가 2km 이하면 예약하자마자 잠긴다', () => {
    const stages = timeline({ ...PLAN, pickupM: 1500 });
    expect(stages[0]).toMatchObject({ status: 'CANCEL_LOCKED', atMs: 0, remainingDistanceMeters: 1500 });
    expect(stages[1]).toMatchObject({ status: 'PICKED_UP', atMs: 150_000 });
  });

  it('지점을 모르면 위치 이름은 null', () => {
    expect(timeline({ ...PLAN, originBranch: null, destBranch: null }).every((s) => s.locationName === null)).toBe(true);
  });
});

describe('남은 거리', () => {
  it('수거 전에는 판매자까지 남은 거리', () => {
    expect(remainingAt(PLAN, 0)).toBe(6000);
    expect(remainingAt(PLAN, 250_000)).toBe(3500);
    expect(remainingAt(PLAN, 600_000)).toBe(0);
  });

  it('간선 중에는 도착 지점까지, 배송 중에는 구매자까지 남은 거리', () => {
    expect(remainingAt(PLAN, 1260_000 + 500_000)).toBe(10000);
    expect(remainingAt(PLAN, 2320_000 + 100_000)).toBe(2000);
  });

  it('지점에 머무는 동안과 배송 완료 뒤에는 null', () => {
    expect(remainingAt(PLAN, 1230_000)).toBeNull();
    expect(remainingAt(PLAN, 3000_000)).toBeNull();
  });
});

describe('경로 계획', () => {
  const branches = [
    { name: '강남우체국', address: '', lat: 37.5, lng: 127.0 },
    { name: '해운대우체국', address: '', lat: 35.16, lng: 129.16 },
  ];
  const speeds = { localKmh: 36, linehaulKmh: 72, dwellSec: 60, multiplier: 1 };
  const defaults = { localM: 5000, linehaulM: 30000 };
  const coords: Record<string, { lat: number; lng: number }> = {
    판매자주소: { lat: 37.51, lng: 127.0 }, // 강남우체국에서 북쪽 약 1.1km
    구매자주소: { lat: 35.16, lng: 129.18 }, // 해운대우체국에서 동쪽 약 1.8km
  };
  const fake: Geocoder = { geocode: async (address) => coords[address] ?? null };
  const req = (s: string, r: string) => ({
    sender: { name: 'a', phone: '1', address: s },
    receiver: { name: 'b', phone: '2', address: r },
    itemSummary: 'x',
  });

  it('가장 가까운 지점과의 직선 거리로 계획한다', async () => {
    const plan = await createPlanner({ geocoder: fake, branches, speeds, defaults })(req('판매자주소', '구매자주소'));
    expect(plan.originBranch).toBe('강남우체국');
    expect(plan.destBranch).toBe('해운대우체국');
    expect(plan.pickupM).toBeGreaterThan(1000);
    expect(plan.pickupM).toBeLessThan(1200);
    expect(plan.linehaulM / 1000).toBeGreaterThan(300);
    expect(plan.localMps).toBe(10);
    expect(plan.linehaulMps).toBe(20);
    expect(plan.dwellMs).toBe(60_000);
  });

  it('좌표 변환에 실패하면 기본 거리로 진행한다 (예약을 막지 않음)', async () => {
    const plan = await createPlanner({ geocoder: fake, branches, speeds, defaults })(req('모르는주소', '구매자주소'));
    expect(plan).toMatchObject({ pickupM: 5000, originBranch: null, linehaulM: 30000, destBranch: '해운대우체국' });
  });

  it('지오코더가 예외를 던져도 기본 거리로 진행한다', async () => {
    const broken: Geocoder = { geocode: async () => Promise.reject(new Error('boom')) };
    const plan = await createPlanner({ geocoder: broken, branches, speeds, defaults })(req('판매자주소', '구매자주소'));
    expect(plan).toMatchObject({ pickupM: 5000, linehaulM: 30000, deliveryM: 5000 });
  });

  it('배율을 올리면 속도와 대기 시간이 함께 빨라진다', async () => {
    const plan = await createPlanner({ geocoder: fake, branches, speeds: { ...speeds, multiplier: 60 }, defaults })(
      req('판매자주소', '구매자주소'),
    );
    expect(plan.localMps).toBe(600);
    expect(plan.dwellMs).toBe(1000);
  });
});

describe('카카오 주소 검색', () => {
  const okFetch = (documents: unknown[]) => {
    const calls: { url: string; auth: string }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify({ documents }), { status: 200 });
    }) as typeof fetch;
    return { fn, calls };
  };

  it('KakaoAK 헤더로 부르고 첫 결과의 y, x를 위도·경도로 쓴다', async () => {
    const { fn, calls } = okFetch([{ x: '127.0276', y: '37.4979' }]);
    const point = await kakaoGeocoder('k', 1000, fn).geocode('서울 강남구 강남대로 396');
    expect(point).toEqual({ lat: 37.4979, lng: 127.0276 });
    expect(calls[0].auth).toBe('KakaoAK k');
    expect(calls[0].url).toContain('query=' + encodeURIComponent('서울 강남구 강남대로 396'));
  });

  it('결과가 없으면 null', async () => {
    expect(await kakaoGeocoder('k', 1000, okFetch([]).fn).geocode('없는주소')).toBeNull();
  });

  it('키가 없으면 부르지 않고 null', async () => {
    const { fn, calls } = okFetch([{ x: '1', y: '1' }]);
    expect(await kakaoGeocoder('', 1000, fn).geocode('주소')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('HTTP 오류는 예외 (경로 계획이 기본 거리로 바꿔 받는다)', async () => {
    const fn = (async () => new Response('', { status: 401 })) as typeof fetch;
    await expect(kakaoGeocoder('k', 1000, fn).geocode('주소')).rejects.toThrow('HTTP 401');
  });
});
