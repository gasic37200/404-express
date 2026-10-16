# 404-express 설계

JustCommit(식물 중고거래) 서버가 쓰는 **가짜 택배사**. 당근 택배를 모방한다.
판매자가 문앞에 두면 택배사가 수거하고, 배송 중 → 배송 완료로 진행한다.

## 상태

| 코드 | UI 이름 | 설명 |
|---|---|---|
| `RESERVED` | 택배 예약 | 예약 완료, 송장 발급 (발송 전) |
| `PICKED_UP` | 접수 완료 | 수거 완료 |
| `IN_TRANSIT` | 배송 중 | 허브 이동 중 |
| `DELIVERED` | 배송 완료 | 도착 |
| `CANCELLED` | 접수 취소 | 수거 전에 취소됨 |

- `RESERVED → PICKED_UP → IN_TRANSIT → DELIVERED` 순서로만 진행한다. 취소는 `RESERVED`에서만 된다.
- 기본은 시간 기반 자동 진행이다: 수거 3분 / 배송 중 2분 / 배송 완료 2분 (`*_DELAY_SEC`).
- 택배 1건 = 서버의 판매자 주문(구매자·판매자 묶음) 1건. 택배사는 품목을 모른다.
  부분 취소는 서버 내부 일이고, 묶음 전체가 취소될 때만 서버가 취소 API를 부른다.

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
| POST | `/api/v1/shipments/{trackingNo}/cancel` | `X-Api-Key` | 취소 |
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

### 취소

`POST /api/v1/shipments/{trackingNo}/cancel` (본문 없음). 배송 건 전체만 취소한다.

| 상황 | 응답 |
|---|---|
| `RESERVED` | `200`, `data.status = "CANCELLED"`, `data.cancelledAt` 채움 |
| 이미 `CANCELLED` | `200`, 처음 취소와 같은 결과(`cancelledAt`도 처음 값). 타임아웃 뒤 다시 보내도 안전 |
| `PICKED_UP` 이후 | `409 SHIPMENT_NOT_CANCELLABLE` |
| 없는 송장번호 | `404 SHIPMENT_NOT_FOUND` |
| `X-Api-Key` 오류 | `401 UNAUTHORIZED` |

- 취소는 동기 응답으로 끝나며 CANCELLED 웹훅을 보내지 않는다.
- 취소된 건은 자동 진행(수거 → 배송 중 → 완료)과 admin 진행(`409 INVALID_STATE_TRANSITION`)이 모두 멈추고, 새 웹훅도 생기지 않는다. 자동 진행은 배송 건마다 타이머를 잡지 않고 워커가 실행 시점에 상태를 다시 읽으므로, 취소 직전에 잡혀 있던 진행이 남지 않는다. 취소 전에 쌓여 재전송 대기 중이던 이벤트는 그대로 나갈 수 있다(서버가 무시한다).
- 취소된 건을 같은 `Idempotency-Key`·같은 본문으로 다시 예약하면 새로 만들지 않고 취소된 기존 건을 `200`으로 돌려준다(`trackingNo` 포함, `status = "CANCELLED"`). 서버는 예약 응답이 유실된 READY 건을 취소할 때 이렇게 `trackingNo`를 얻은 뒤 취소한다.
- 취소와 자동 수거가 겹치면 먼저 처리된 쪽만 성공한다. 둘 다 `BEGIN IMMEDIATE` 트랜잭션 안에서 상태를 다시 읽고 바꾸므로, 취소가 먼저면 수거되지 않고 수거가 먼저면 취소는 `409`다. 둘 다 성공하는 경우는 없다.

### 에러 코드

`BAD_REQUEST_DATA`, `INVALID_FIELD_ERROR`, `INVALID_IDEMPOTENCY_KEY`, `UNAUTHORIZED`, `RESOURCE_NOT_FOUND`,
`SHIPMENT_NOT_FOUND`, `WEBHOOK_EVENT_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`, `SHIPMENT_NOT_CANCELLABLE`,
`INVALID_STATE_TRANSITION`, `WEBHOOK_EVENT_NOT_DEAD`, `INTERNAL_ERROR`

## 웹훅 (택배사 → 서버)

```http
POST {WEBHOOK_URL}          ← 서버 수신 경로: /api/v1/webhooks/courier
X-Api-Key: <WEBHOOK_API_KEY>
Content-Type: application/json

{
  "eventId": "evt_6d071fa0-...",
  "courierOrderNo": "shipment-20261008-000001",
  "trackingNo": "404000000001",
  "status": "PICKED_UP",
  "occurredAt": "2026-10-08T15:03:00+09:00"
}
```

- `PICKED_UP`, `IN_TRANSIT`, `DELIVERED`일 때만 보낸다. 본문은 `ApiResponse`로 감싸지 않는다.
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
- 이벤트마다 재전송 시각을 따로 예약한다. 같은 배송 건이라도 앞 이벤트의 재전송이 뒤 이벤트를 막지 않으므로, 서버는 순서가 뒤바뀐 이벤트를 받을 수 있다. 전송은 동시에 하므로 응답이 느린 이벤트가 다른 이벤트를 기다리게 하지 않는다.
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
- 워커 두 개가 같은 프로세스에서 돈다: 자동 진행(`PROGRESS_TICK_MS`), outbox 전송(`OUTBOX_TICK_MS`)
- 배포: 운영 EC2에 JustCommit과 함께 둔다. compose는 레포별로 분리(`docker-compose.prod.yml`)하고 외부 Docker 네트워크 `replant-net`으로만 통신한다. replant-net 별칭 `404-express`(JustCommit → `http://404-express:3000`), 웹훅은 `http://replant-app:8080/api/v1/webhooks/courier`, 포트 3000 비공개, Caddy 없음, `mem_limit` 128m. SQLite 파일은 `courier-data` 볼륨

## 나중에

- 관리자 UI (배송 목록, 강제 진행, DEAD 재전송). 모두 admin API를 부르는 화면이면 된다.
- 바코드: 송장번호를 Code128로 출력하고, 스캔하면 `advance`를 호출한다.
