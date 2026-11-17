import type { LatLng } from './geo.js';
import type { Geocoder } from './planner.js';

const KAKAO_ADDRESS_URL = 'https://dapi.kakao.com/v2/local/search/address.json';

/**
 * 카카오 주소 검색 API로 좌표를 찾는다. 키가 없거나 실패하면 null(호출한 쪽이 기본 거리로 진행).
 * 키는 .env의 KAKAO_REST_API_KEY에만 두고 로그에 남기지 않는다.
 */
export function kakaoGeocoder(apiKey: string, timeoutMs: number, doFetch: typeof fetch = fetch): Geocoder {
  return {
    async geocode(address: string): Promise<LatLng | null> {
      if (!apiKey) return null;
      const url = `${KAKAO_ADDRESS_URL}?query=${encodeURIComponent(address)}`;
      const res = await doFetch(url, {
        headers: { Authorization: `KakaoAK ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`카카오 주소 검색 HTTP ${res.status}`);
      const body = (await res.json()) as { documents?: { x: string; y: string }[] };
      const first = body.documents?.[0];
      if (!first) return null;
      const point = { lat: Number(first.y), lng: Number(first.x) };
      return Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : null;
    },
  };
}
