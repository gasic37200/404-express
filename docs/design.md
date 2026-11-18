# 404-express 설계

JustCommit(식물 중고거래) 서버가 쓰는 **가짜 택배사**. 당근 택배를 모방한다.
판매자가 문앞에 두면 택배사가 수거하고, 배송 중 → 배송 완료로 진행한다.

## 상태

| 코드 | 의미 | 웹훅 `remainingDistanceMeters` | `locationName` |
|---|---|---|---|
| `RESERVED` | 택배 예약(= 기사 배정), 송장 발급 | (웹훅 없음, 예약 응답) | 출발 지점 |
| `NEAR_5KM` | 기사가 판매자 5km 안. 시작 거리가 5km를 넘을 때만 | `5000` | 출발 지점 |
| `CANCEL_LOCKED` | 기사가 판매자 2km 안 = 취소 불가. 시작 거리가 2km 이하면 예약하자마자 | `min(시작 거리, 2000)` | 출발 지점 |
| `PICKED_UP` | 수거(0m) | `0` | 출발 지점 |
| `ARRIVED_ORIGIN` | 출발지 집하점 도착(기사가 지점으로 돌아옴) | 없음 | 출발 지점 |
| `IN_TRANSIT` | 간선 출발(지점 ↔ 지점) | 간선 거리 | 출발 지점 |
| `ARRIVED_DEST` | 도착지 집하점 도착 | 없음 | 도착 지점 |
| `OUT_FOR_DELIVERY` | 배송 기사 배정 | 배송 거리 | 도착 지점 |
| `DELIVERED` | 배송 완료 | `0` | 도착 지점 |
| `CANCELLED` | 취소됨 | 없음 | 없음 |
| `RETURNING` | 반송 중: 판정상 취소가 맞는데 택배사 장애로 이미 수거된 건 | 없음 | 출발 지점 |
| `RETURNED` | 반송 완료: 판매자에게 돌아감 | 없음 | 출발 지점 |

- 위 순서로만 진행한다. 단계마다 웹훅 1번. 스케줄러가 늦어 여러 단계를 지나쳐도 순서대로, 각 단계의 원래 도달 시각(`occurredAt`)으로 보낸다.
- 택배 1건 = 서버의 판매자 주문(구매자·판매자 묶음) 1건. 택배사는 품목을 모른다.
  부분 취소는 서버 내부 일이고, 묶음 전체가 취소될 때만 서버가 취소 API를 부른다.

### 거리 시뮬레이션

- 예약 때 판매자·구매자 주소를 카카오 주소 검색으로 좌표로 바꾸고, 우체국 지점 표에서 각각 가장 가까운 지점을 찾는다.
- 지점 표: `branches/branches.json`(커밋됨, Docker 이미지에 포함). 공공데이터포털 「우정사업본부_전국 우체국 현황」(2026-08-31) CSV의 **총괄국 248곳**을 카카오로 한 번 좌표 변환한 것이다. 집하점 역할에 맞아 총괄국만 쓴다. 다시 만들 때는 CSV를 `data/post-offices.csv`로 두고 `npm run branches:build`(전체 지점은 `-- --all`, 우편집중국 제외).
- 경로 계획(예약 때 한 번 정해 저장): 수거 거리 = 판매자 ↔ 출발 지점, 간선 거리 = 출발 지점 ↔ 도착 지점, 배송 거리 = 도착 지점 ↔ 구매자. 모두 직선 거리(하버사인).
- 좌표 변환이나 지점 찾기에 실패하면 기본 거리(수거·배송 5km, 간선 30km)로 진행하고 지점 이름은 `null`이다. 예약은 막지 않는다.
- 남은 거리는 저장하지 않고 계산한다: 수거 전 = `max(0, 수거 거리 − 속도 × 예약 후 지난 시간)`. 간선·배송 중도 같은 방식.
- 시각표: 수거 = 수거 거리 ÷ 근거리 속도, 출발지 집하점 = 수거 + 같은 시간(돌아옴), 간선 출발 = + 집하 대기, 도착지 집하점 = + 간선 거리 ÷ 간선 속도, 배송 기사 배정 = + 집하 대기, 배송 완료 = + 배송 거리 ÷ 근거리 속도.
- 속도·대기: 근거리 30km/h, 간선 80km/h, 집하 대기 30분. `SPEED_MULTIPLIER`로 모두 함께 빠르게 한다(예약 때 계획에 반영되므로 진행 중인 건은 설정을 바꿔도 그대로).

## 식별자

| 이름 | 누가 만드나 | 형식 | 쓰임 |
|---|---|---|---|
| `courierOrderNo` | 서버 | `shipment-yyyyMMdd-NNNNNN` (`NNNNNN` = 서버 배송(shipment) ID 6자리) | 예약 요청의 `Idempotency-Key` |
| `trackingNo` | 택배사 | `404` + 9자리 일련번호 (`404000000001`) | URL 경로의 배송 ID, 송장번호 |

## API

모든 응답은 JustCommit `ApiResponse`와 같은 모양: `{ status, code?, message, data? }` (null 필드 생략).
시각은 ISO-8601 KST (`2026-10-08T15:30:00+09:00`).

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/api/v1/shipments` | `X-Api-Key` | 예약 |
| GET | `/api/v1/shipments/{trackingNo}` | `X-Api-Key` | 조회 (서버 polling용) |
| GET | `/api/v1/shipments/byOrderNo/{courierOrderNo}` | `X-Api-Key` | 주문번호로 조회 |
| POST | `/api/v1/shipments/byOrderNo/{courierOrderNo}/cancel` | `X-Api-Key` | 주문번호로 취소 (2km 판정) |
| POST | `/api/v1/admin/shipments/{trackingNo}/advance` | `X-Admin-Key` | 테스트용 한 칸 진행 |
| GET | `/api/v1/admin/webhooks?status=DEAD` | `X-Admin-Key` | 웹훅 이벤트 목록 (`PENDING`/`SENT`/`DEAD`) |
| POST | `/api/v1/admin/webhooks/{eventId}/retry` | `X-Admin-Key` | DEAD 이벤트 재전송 |

`ADMIN_API_KEY`가 비어 있으면 admin 경로는 열리지 않는다.

### 예약

```http
POST /api/v1/shipments
X-Api-Key: <COURIER_API_KEY>
Idempotency-Key: shipment-20261008-000001
Content-Type: application/json

{
  "sender":   { "name": "김판매", "phone": "010-1111-2222", "address": "서울시 ..." },
  "receiver": { "name": "이구매", "phone": "010-3333-4444", "address": "부산시 ..." },
  "itemSummary": "몬스테라 외 1건"
}
```

| 상황 | 응답 |
|---|---|
| 처음 보는 키 | `201`, 새 송장번호 |
| 같은 키 + 같은 본문 (키 순서 무관) | `200`, 처음 발급한 송장 그대로 |
| 같은 키 + 다른 본문 | `409 IDEMPOTENCY_KEY_REUSED` |
| 키 없음 / 형식 틀림 (`^shipment-\d{8}-\d{6}$`) | `400 INVALID_IDEMPOTENCY_KEY` |
| 필수값 누락 | `400 INVALID_FIELD_ERROR` |

- 처음 예약은 좌표 변환(카카오, 판매자·구매자 동시, 각 최대 `GEOCODE_TIMEOUT_MS`)만큼 늦어질 수 있다. 같은 키 재요청은 좌표 변환 없이 바로 돌려준다.

### 조회

`GET /api/v1/shipments/{trackingNo}`, `GET /api/v1/shipments/byOrderNo/{courierOrderNo}`. 조회할 때 시각표를 따라잡으므로 스케줄러보다 늦지 않는다.

| 필드 | 뜻 |
|---|---|
| `status` | 현재 단계 |
| `remainingDistanceMeters` | 지금 이동 중인 구간의 남은 거리(m). 수거 전 = 판매자까지, 간선 중 = 도착 지점까지, 배송 중 = 구매자까지. 지점에 머무는 중이거나 끝난 건은 `null` |
| `locationName` | 현재 단계의 지점 이름. 모르면 `null` |
| `bookedAt`, `pickedUpAt`, `inTransitAt`, `deliveredAt`, `cancelledAt`, `returnedAt` | 각 단계에 도달한 시각. `inTransitAt`은 간선 출발 시각 |

### 주문번호 취소 (2km 판정)

`POST /api/v1/shipments/byOrderNo/{courierOrderNo}/cancel`. market의 취소 큐가 쓰는 API다. 배송 건 전체만 취소한다.

```http
POST /api/v1/shipments/byOrderNo/shipment-20261008-000001/cancel
X-Api-Key: <COURIER_API_KEY>
Content-Type: application/json

{ "cancelRequestedAt": "2026-10-08T15:01:40+09:00" }
```

- `cancelRequestedAt`: 구매자가 취소를 누른 시각. 시간대 표기 필수(없으면 `400 INVALID_FIELD_ERROR`). 택배사가 받은 시각보다 미래면 받은 시각으로 자른다.
- 판정(누른 시각 기준): 기사가 판매자 2km 밖이었으면 취소. 2km 안이어도 **잠긴 뒤 30초(`CANCEL_GRACE_SEC`) 안에 눌렀고 지금 아직 수거 전**이면 취소. 그 밖은 `409 SHIPMENT_NOT_CANCELLABLE`.
- 같은 주문번호를 다시 보내면 **첫 판정을 그대로** 돌려준다(200이든 409든, 두 번째 요청의 `cancelRequestedAt`은 보지 않음). 응답 유실 뒤 취소 큐가 재전송해도 안전하다.

| 상황 | 응답 | 웹훅 |
|---|---|---|
| 판정 통과, 아직 수거 전 | `200`, `status = "CANCELLED"`, `returning = false` | `CANCELLED` |
| 판정 통과, 지금은 이미 수거됨(택배사 장애로 요청 처리가 늦음) | `200`, `status = "RETURNING"`, `returning = true`. 택배사 비용으로 반송 | `CANCELLED` → `RETURNING` → (수거에 걸린 시간 뒤) `RETURNED` |
| 판정 불통과 | `409 SHIPMENT_NOT_CANCELLABLE` | 없음. 배송은 계속 진행 |
| 예약이 아직 없음 | `200`, `status = "CANCELLED"`, `trackingNo = null`. 취소 기록을 남긴다 | 없음 |
| 주문번호 형식 틀림 / 본문 틀림 | `400 INVALID_FIELD_ERROR` | - |
| `X-Api-Key` 오류 | `401 UNAUTHORIZED` | - |

응답 `data`: `{ courierOrderNo, trackingNo, status, returning, cancelledAt, returnedAt }`.

- 취소 결과는 응답만으로 충분하지만 `CANCELLED` 웹훅도 보낸다(2026-11-17 결정). market이 배송 내역(`shipment_tracking`)을 모든 단계에서 웹훅 하나로 쌓게 하려는 것이고, 같은 결과를 두 번 받아도 "앞으로만 반영 + 중복 무시"라 무해하다.

- 예약 전 취소 기록이 있는 주문번호로 예약이 늦게 오면 `409 ORDER_ALREADY_CANCELLED`(배송 건을 만들지 않음).
- 반송 중·반송 완료 건은 원래 단계(간선 등)로 진행하지 않는다.
- 취소된 건은 자동 진행과 admin 진행(`409 INVALID_STATE_TRANSITION`)이 모두 멈추고, `CANCELLED` 뒤로 새 웹훅이 생기지 않는다. 자동 진행은 배송 건마다 타이머를 잡지 않고 워커가 실행 시점에 상태를 다시 읽으므로, 취소 직전에 잡혀 있던 진행이 남지 않는다.
- 취소된 건을 같은 `Idempotency-Key`·같은 본문으로 다시 예약하면 새로 만들지 않고 취소된 기존 건을 `200`으로 돌려준다(`status = "CANCELLED"`).
- 취소 판정과 자동 진행은 둘 다 `BEGIN IMMEDIATE` 트랜잭션 안에서 상태를 다시 읽고 바꾸므로, 동시에 일어나도 둘 다 성공하는 경우가 없다.
- 송장번호 취소 API(`POST /api/v1/shipments/{trackingNo}/cancel`)는 2026-11-17에 없앴다(2km 판정을 하지 않아 정책과 어긋났다). 이제 `404 RESOURCE_NOT_FOUND`.

### 에러 코드

`BAD_REQUEST_DATA`, `INVALID_FIELD_ERROR`, `INVALID_IDEMPOTENCY_KEY`, `UNAUTHORIZED`, `RESOURCE_NOT_FOUND`,
`SHIPMENT_NOT_FOUND`, `WEBHOOK_EVENT_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`, `SHIPMENT_NOT_CANCELLABLE`,
`ORDER_ALREADY_CANCELLED`, `INVALID_STATE_TRANSITION`, `WEBHOOK_EVENT_NOT_DEAD`, `INTERNAL_ERROR`

## 웹훅 (택배사 → 서버)

```http
POST {WEBHOOK_URL}          ← 서버 수신 경로: /api/v1/webhooks/courier
X-Api-Key: <WEBHOOK_API_KEY>
Content-Type: application/json

{
  "eventId": "evt_6d071fa0-...",
  "courierOrderNo": "shipment-20261008-000001",
  "trackingNo": "404000000001",
  "status": "NEAR_5KM",
  "occurredAt": "2026-10-08T15:03:00+09:00",
  "remainingDistanceMeters": 5000,
  "locationName": "강남우체국"
}
```

- `RESERVED` 다음 단계(`NEAR_5KM` ~ `DELIVERED`)마다, 그리고 주문번호 취소가 확정되면 `CANCELLED`(반송이면 `RETURNING`, 이후 `RETURNED`)를 보낸다. 본문은 `ApiResponse`로 감싸지 않는다.
- `remainingDistanceMeters`는 위 상태 표에서 값이 있는 단계에만 싣는다. `locationName`은 항상 싣고, 지점을 모르면 `null`.
- `occurredAt`은 그 단계에 도달한 시각이다. 스케줄러가 늦게 반영해도 원래 시각을 쓴다.
- 상태 전이와 outbox 적재는 같은 트랜잭션이라, 택배사가 죽어도 이벤트가 사라지지 않는다.

### 재전송 규칙

JustCommit 수신부는 처리했거나 무시해도 되는 건(중복, 순서 꼬임, 모르는 `courierOrderNo`)에 200, 키 문제에 401, 서버 에러에 5xx를 준다. 상태는 앞으로만 반영하고 중복은 무시하므로, 같은 이벤트를 여러 번 보내거나 순서가 뒤바뀌어도 안전하다.

| 응답 | 처리 |
|---|---|
| 2xx | 성공(`SENT`) |
| 5xx, 연결 실패, 타임아웃(`WEBHOOK_TIMEOUT_MS`, 기본 5초) | 재전송 예약, warn 로그 |
| 4xx (401, 400, 408, 429 포함) | 재전송하지 않음(`DEAD`), error 로그. 설정이나 데이터 문제라 다시 보내도 같다 |

- 재전송 간격: 1분 → 5분 → 30분 → 2시간 → 6시간. 처음 전송 1번 + 재전송 최대 5번이다. `WEBHOOK_RETRY_DELAYS_SEC`로 바꿀 수 있다(예: 로컬에서 `5,5,5,5,5`).
- 재전송은 처음 저장한 내용을 그대로 보낸다. `eventId`, `occurredAt`이 같고 새 이벤트를 만들지 않는다.
- 이벤트마다 재전송 시각을 따로 예약한다. 같은 배송 건이라도 앞 이벤트의 재전송이 뒤 이벤트를 막지 않으므로, 서버는 순서가 뒤바뀐 이벤트를 받을 수 있다.
- 한 번에 여러 단계가 밀렸을 때는 같은 배송 건의 이벤트를 앞 응답을 받은 뒤 다음 순서로 보낸다(정상일 때 도착 순서 유지). 다른 배송 건끼리는 동시에 보내므로 응답이 느린 건이 다른 건을 기다리게 하지 않는다.
- 5번 재전송이 모두 실패하면 `DEAD`로 실패 목록(DB, 재시작해도 유지)에 남기고 error 로그를 찍는다. `GET /api/v1/admin/webhooks?status=DEAD`로 보고 `POST /api/v1/admin/webhooks/{eventId}/retry`로 다시 보낸다. 서버의 polling 대사가 최종 안전망이다.

## 인증

방향별로 키를 따로 쓴다. 한쪽 키가 새도 반대 방향은 안전하다. 운영과 개발은 다른 값을 쓴다.

| 키 | 보내는 쪽 | 검증하는 쪽 |
|---|---|---|
| `COURIER_API_KEY` | 서버 | 택배사 |
| `WEBHOOK_API_KEY` | 택배사 | 서버 |
| `ADMIN_API_KEY` | 관리자/테스트 | 택배사 |

## 서버(JustCommit) 쪽 구현 가이드

1. `shipment` 행에 `courier_order_no`를 **먼저 저장한 뒤** 예약 API를 부른다. 응답의 `trackingNo`를 `tracking_no`에 저장한다.
2. `tracking_no`가 비어 있는 행은 응답이 유실된 것이다. **같은 키로 다시 예약**하면 같은 송장이 돌아온다.
3. 웹훅은 `courierOrderNo`로 행을 찾고, `eventId`로 중복을 무시하고, 현재보다 앞선 상태만 반영한다.
4. 5분마다 `DELIVERED`/`CANCELLED`가 아닌 건을 `GET /api/v1/shipments/{trackingNo}`로 조회해 맞춘다. 웹훅 유실의 최종 안전망이다.
5. `NNNNNN`은 서버 배송 ID를 쓰므로 키 생성에 별도 동시성 처리가 필요 없다.
6. 주소 같은 필수값은 서버에서 막기로 했으므로 `failure_reason` 컬럼은 필요 없다. 택배사는 방어용으로만 `400`을 준다.

## 구현

- Node 24 + TypeScript + Express 5 + zod
- DB: Node 내장 `node:sqlite` (네이티브 빌드 없음). 테이블 `shipments`, `webhook_outbox`
- 워커 두 개가 같은 프로세스에서 돈다: 자동 진행(`PROGRESS_TICK_MS`, 경로 계획의 시각표 따라잡기), outbox 전송(`OUTBOX_TICK_MS`)
- 거리: `src/routing/` (하버사인, 시각표, 경로 계획, 카카오 주소 검색, 지점 표 읽기)
- admin 진행은 다음 단계가 지금 도달하도록 진행 기준 시각(`progress_origin_at`)을 당긴다. 이후 단계도 같은 간격으로 이어진다.
- 배포: 운영 EC2에 JustCommit과 함께 둔다. compose는 레포별로 분리(`docker-compose.prod.yml`)하고 외부 Docker 네트워크 `replant-net`으로만 통신한다. replant-net 별칭 `404-express`(JustCommit → `http://404-express:3000`), 웹훅은 `http://replant-app:8080/api/v1/webhooks/courier`, 포트 3000 비공개, Caddy 없음, `mem_limit` 128m. SQLite 파일은 `courier-data` 볼륨

## 나중에

- 관리자 UI (배송 목록, 강제 진행, DEAD 재전송). 모두 admin API를 부르는 화면이면 된다.
- 바코드: 송장번호를 Code128로 출력하고, 스캔하면 `advance`를 호출한다.
