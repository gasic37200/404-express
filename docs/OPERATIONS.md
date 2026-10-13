# 운영 상태

목표 설계는 [design.md](design.md)에 있다. 이 파일은 **실제로 구현·배포·검증된 것**만 적는다.

## 요약

| 단계 | 상태 |
| --- | --- |
| 설계 | 완료 (2026-10-08 사용자와 합의, design.md) |
| 구현 | 완료: 예약·조회·취소·admin 진행·웹훅 outbox·자동 진행 |
| 로컬 검증 | 완료 (아래 기록) |
| 커밋·push | 미실행 |
| Oracle 배포 | 미실행 |
| 운영 검증 (JustCommit 서버와 연동) | 미실행. 서버 쪽 `market/shipment`는 아직 `package-info.java`만 있다 (2026-10-08 확인) |
| 관리자 UI·바코드 | 미착수 (나중에) |

## 기록

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
