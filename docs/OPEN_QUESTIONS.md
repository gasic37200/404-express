# 미결 질문

확정되면 design.md나 OPERATIONS.md로 옮기고 여기서 지운다.

## 확인 필요

- **courierOrderNo의 6자리 상한**: `NNNNNN`이 서버 배송 ID라서, 배송 ID가 999999를 넘으면 `^shipment-\d{8}-\d{6}$` 검사에 걸려 400이 난다. 데모 규모에서는 문제없다는 추정이며, 서버 쪽 키 생성 방식은 확인하지 않았다.
- **도서산간 우편번호 출처**: 특정 택배사 공식 표가 아니라 쇼핑몰 플랫폼들이 공통으로 쓰는 기준표다(2026-11-18 확인). 원문 `28826`을 `58826`의 오기로 보고 고쳤다(추정). 제주 섬은 추자도·우도만 넣었고 마라도·가파도 등은 확인하지 못했다.
- **SQLite 백업**: 운영 데이터는 `courier-data` 볼륨에만 있다. 백업 주기와 방법이 정해지지 않았다.

## 결정됨

- **배송비 요금표 계약** (2026-11-18): 기본 3,000원 + 지역 할증 하나(제주 +3,000, 도서산간 +5,000; 도서산간 → 제주 → 없음 순으로 판정, 크기별 기본 요금이 생겨도 할증을 더할 수 있게 할증으로 둠). 404-express가 요금표가 바뀔 때 `SHIPPING_FEES_CHANGED` 웹훅에 요금표 전체를 실어 보내고, `GET /api/v1/shippingFees`는 market 버전 대사용. 바꾸기는 `PUT /api/v1/admin/shippingFees`. design.md "배송비 요금표"에 반영.
- **운영 웹훅 주소** (2026-10-16, Replant PR #165): Spring 컨테이너가 replant-net에 별칭 `replant-app`으로 참여한다. 운영 `.env`는 `WEBHOOK_URL=http://replant-app:8080/api/v1/webhooks/courier`.
- **배포 위치** (2026-10-16): Oracle 단독 배포 대신 JustCommit과 같은 운영 EC2에 둔다(B안). compose는 레포별 분리, 외부 네트워크 `replant-net`, 서비스 이름 `404-express`, 포트 비공개.
- **JustCommit 서버의 웹훅 수신 경로** (2026-10-13): `/api/v1/webhooks/courier`. design.md 웹훅 절과 `.env.example`에 반영했다.

## 에이전트 추정·임의 결정 (사용자 확인 전)

- **`node:sqlite` 사용**: 합의는 better-sqlite3였는데, 네이티브 빌드를 피하려고 Node 24 내장 모듈로 바꿨다. 사용자에게 보고했지만 명시적 승인은 받지 않았다.
- **종료 중 웹훅 전송**: SIGTERM 때 워커 타이머만 멈추고, 이미 전송 중인 웹훅은 기다리지 않는다. 전송은 성공했는데 SENT 기록 전에 DB가 닫히면 다음 기동 때 같은 `eventId`로 다시 보낸다. 서버가 `eventId`로 중복을 무시하면 문제없다는 판단이다.
