# 운영 상태

목표 설계는 [design.md](design.md)에 있다. 이 파일은 **실제로 구현·배포·검증된 것**만 적는다.

## 요약

| 단계 | 상태 |
| --- | --- |
| 설계 | 완료 (2026-10-08 사용자와 합의, design.md) |
| 구현 | 완료: 예약·조회·취소·admin 진행·웹훅 outbox·자동 진행 |
| 로컬 검증 | 완료 (아래 기록) |
| 커밋·push | `770b02e`까지 push 완료 (2026-10-16) |
| Oracle 배포 | 미실행 |
| 운영 검증 (JustCommit 서버와 연동) | 미실행. 서버 쪽 예약 연동은 PR #103으로 머지됨, 웹훅 수신·재시도 스케줄러는 아직 없음 (2026-10-14 확인) |
| 관리자 UI·바코드 | 미착수 (나중에) |

## 기록

### 2026-10-16 배송 취소 동작 점검 (JustCommit #161 대비)

- 코드 변경 없음. 요구한 동작(상태별 응답, 취소 후 자동 진행·웹훅 중단, 같은 키 재예약 시 취소된 건 200, 취소·수거 동시 처리)이 이미 지켜지는 것을 확인하고 `test/cancel.test.ts`(10개)로 고정했다.
- `npm run typecheck` 오류 없음, `npm test` 38개 통과.
- 로컬 E2E (`npx tsx src/main.ts`, 기본 수거 지연 3분, 가짜 수신기):
  - 예약 → 바로 취소: 201 → 200 CANCELLED. 3분 20초 기다린 뒤에도 CANCELLED, `pickedUpAt=null`, 해당 건 웹훅 0건.
  - 같은 송장 두 번째 취소: 200, `cancelledAt` 동일.
  - 같은 `Idempotency-Key`로 재예약: 200, 같은 `trackingNo`, CANCELLED.
  - 수거 이후 취소: 409 `SHIPMENT_NOT_CANCELLABLE`.
- 동시 처리는 프로세스 하나 안에서 순서를 바꿔 가며 테스트했다. 실제로 두 요청을 동시에 보내는 부하 테스트는 미실행. 근거는 둘 다 `BEGIN IMMEDIATE` 안에서 상태를 다시 읽는다는 것이다.

### 2026-10-16 웹훅 재전송 규칙 변경

- 재전송 간격 1분 → 5분 → 30분 → 2시간 → 6시간(최대 5번, `WEBHOOK_RETRY_DELAYS_SEC`로 변경 가능). 4xx는 모두 재전송하지 않는다(이전에는 408·429를 재전송). 배송 건별 FIFO를 없애고 이벤트별로 독립 재전송하며, 전송은 동시에 한다.
- `npm run typecheck` 오류 없음, `npm test` 28개 통과.
- 로컬 E2E (`npx tsx src/main.ts`, `WEBHOOK_RETRY_DELAYS_SEC=5,5,5,5,5`, 200/401을 주는 가짜 수신기):
  - 수신기를 끈 채 진행 → `fetch failed` warn 로그 2번 → 수신기를 켜자 3번째 시도에서 같은 `eventId`·`occurredAt`으로 200, `SENT`.
  - 잘못된 `WEBHOOK_API_KEY` → 401 한 번 받고 15초 동안 재전송 없음, error 로그 1줄, `DEAD`(attempts=1).
- 실제 JustCommit 서버와의 확인은 미실행.

### 2026-10-13 메인 서버 1차 연동(JustCommit PR #103) 결정 반영

- 문서만 고쳤다(코드 변경 없음): 웹훅 수신 경로를 `/api/v1/webhooks/courier`로 확정했다. `courierOrderNo`의 `NNNNNN`은 서버 배송 ID 6자리다.
- 참고: 메인 서버는 내부에서 `RESERVED`를 `BOOKED`라는 이름으로 받는다. 택배사 계약은 그대로다.
- `npm run typecheck` 오류 없음, `npm test` 21개 통과.

### 2026-10-08 첫 구현 로컬 검증

- `npm run typecheck`: 오류 없음.
- `npm test`: 2개 파일, 21개 테스트 통과. 다루는 범위: 멱등 예약(201/200/409/400), 취소 규칙, admin 진행, 시간 기반 자동 진행, 웹훅 FIFO, 4xx 즉시 DEAD, 10회 후 DEAD와 재전송.
- `docker build -t 404-express:dev .` 성공.
- 컨테이너 E2E: 지연을 2초로 줄여(`*_DELAY_SEC=2`) 띄우고 호스트에 웹훅 수신기를 둔 뒤 예약했다. 결과: 예약 201, 같은 키 재요청 200, 약 6초 뒤 DELIVERED. 웹훅 3건이 PICKED_UP → IN_TRANSIT → DELIVERED 순서로 `X-Api-Key`와 함께 도착했다.
- `docker compose config -q` 통과 (`.env.example`을 임시 `.env`로 복사해서 확인).
- 관찰: Windows Git Bash의 `curl -d`로 한글을 보내면 깨진다. Node `fetch`로 보내면 정상 저장·응답되므로 서버 문제가 아니다.

남은 것: 커밋·push, Oracle 배포(도메인·포트 확인 필요), JustCommit 서버 연동 검증.
