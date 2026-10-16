# 미결 질문

확정되면 design.md나 OPERATIONS.md로 옮기고 여기서 지운다.

## 확인 필요

- **Oracle 서버 배포 정보**: 쓸 도메인, 80/443 포트 개방 여부(Oracle Cloud는 보안 목록과 OS 방화벽 둘 다 열어야 한다), Docker 설치 여부.
- **courierOrderNo의 6자리 상한**: `NNNNNN`이 서버 배송 ID라서, 배송 ID가 999999를 넘으면 `^shipment-\d{8}-\d{6}$` 검사에 걸려 400이 난다. 데모 규모에서는 문제없다는 추정이며, 서버 쪽 키 생성 방식은 확인하지 않았다.
- **SQLite 백업**: 운영 데이터는 `courier-data` 볼륨에만 있다. 백업 주기와 방법이 정해지지 않았다.

## 결정됨

- **JustCommit 서버의 웹훅 수신 경로** (2026-10-13): `/api/v1/webhooks/courier`. design.md 웹훅 절과 `.env.example`에 반영했다.

## 에이전트 추정·임의 결정 (사용자 확인 전)

- **`node:sqlite` 사용**: 합의는 better-sqlite3였는데, 네이티브 빌드를 피하려고 Node 24 내장 모듈로 바꿨다. 사용자에게 보고했지만 명시적 승인은 받지 않았다.
- **종료 중 웹훅 전송**: SIGTERM 때 워커 타이머만 멈추고, 이미 전송 중인 웹훅은 기다리지 않는다. 전송은 성공했는데 SENT 기록 전에 DB가 닫히면 다음 기동 때 같은 `eventId`로 다시 보낸다. 서버가 `eventId`로 중복을 무시하면 문제없다는 판단이다.
