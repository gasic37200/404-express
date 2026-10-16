# 404-express 작업 규칙

JustCommit(식물 중고거래) 서버가 호출하는 가짜 택배사 API다. 상대편은 팀원들이 Spring으로 만드는 별도 저장소(`prgrms-be-adv-devcourse/beadv8_8_JustCommit_BE`)이므로, 이 저장소의 API와 웹훅 모양은 **다른 팀과의 계약**이다.

## 시작과 범위

- 먼저 `docs/design.md`(목표 설계와 API·웹훅 계약)와 `docs/OPERATIONS.md`(실제 구현·배포·검증 상태)를 읽는다. design.md에 적혀 있어도 OPERATIONS.md에 없으면 구현·검증되지 않은 것으로 본다.
- 작업 전 `git status --short`로 사용자 변경을 확인하고 보존한다.

## 현재 작업 모드

- 개발 모드: 아직 운영 배포 전이므로 SQLite 스키마를 바꿀 때 기존 DB 파일을 지우고 새로 만들어도 된다. 마이그레이션은 없고 `src/db.ts`의 `CREATE TABLE IF NOT EXISTS`가 스키마의 단일 출처다. 운영 배포 후에는 이 줄을 "기존 데이터를 보존하는 마이그레이션 필요"로 바꾼다.
- 범위 밖: 다중 인스턴스, 대규모 부하, 실제 택배사 연동. 워커는 단일 프로세스 안에서 돈다는 가정으로 짜여 있다(outbox에 임대·잠금이 없다).

## 계약을 지키는 규칙

- API 경로, 요청·응답 필드, 에러 코드, 웹훅 본문·헤더를 바꾸면 같은 변경에서 `docs/design.md`도 고치고, 보고할 때 **"JustCommit 서버 쪽 수정 필요"**를 따로 적는다. 서버 팀은 design.md를 보고 구현한다.
- 응답은 JustCommit의 `ApiResponse` 모양 `{status, code?, message, data?}`을 따른다(`src/http/response.ts`). 새 에러 코드는 `src/http/errors.ts`의 `ErrorCode`와 design.md 에러 코드 목록에 함께 추가한다.
- `Idempotency-Key`는 서버가 만든 `shipment-yyyyMMdd-NNNNNN`이다. 같은 키 + 같은 본문 → 기존 결과 200, 다른 본문 → 409 규칙을 바꾸지 않는다.

## 코드의 함정

- **상태 전이와 웹훅 적재는 한 트랜잭션.** 상태를 바꾸는 코드는 `advanceRow`처럼 같은 `transaction()` 안에서 `enqueueWebhook`을 부른다. 따로 쓰면 프로세스가 중간에 죽을 때 웹훅이 유실된다.
- **`transaction()`에는 동기 함수만 넘긴다.** `node:sqlite`는 동기 API이고, 안에서 `await`하면 BEGIN과 COMMIT 사이에 다른 요청이 끼어든다. 네트워크 호출(웹훅 전송)은 트랜잭션 밖에서 한다(`dispatchDue` 참고).
- **"지금"은 항상 `Clock`으로 받는다.** `Date.now()`를 직접 부르면 시간 기반 테스트(자동 진행, 백오프)를 쓸 수 없다.
- **웹훅은 이벤트별로 독립 재전송한다.** 순서 보장(FIFO)은 일부러 두지 않았다. JustCommit이 앞으로만 반영하고 중복·순서 꼬임을 200으로 무시하기 때문이다. 재전송은 저장된 `payload_json`을 그대로 보낸다. 재전송 때 새 이벤트를 만들면 서버의 `eventId` 중복 제거가 깨진다.
- 송장번호는 `shipments.id`에서 만든다(`404` + 9자리). id를 재사용하거나 행을 지우는 코드를 넣지 않는다.

## 승인 경계

- GitHub push, 운영 EC2 배포(`docker compose -f docker-compose.prod.yml up`), Docker 볼륨·DB 파일 삭제(운영), API 키·`.env` 값 변경은 사용자가 요청한 범위에서만 실행한다.
- 커밋은 사용자가 요청할 때 만든다.

## 보고 규칙

- 결과는 설계, 파일 작성, 로컬 검증, 배포, 운영 검증을 구분해 보고하고, 실행하지 않은 단계는 "미실행"으로 적는다.
- 에이전트의 완료 발언은 검증이 아니다. 명령 출력이나 테스트 결과로 확인한 것만 사실로 쓴다.
- 사용자 결정, 코드에서 확인한 사실, 추정, 미확인을 구분한다. 추정·미확인은 `docs/OPEN_QUESTIONS.md`에 남긴다.

## 기록 위치

| 상황 | 파일 |
| --- | --- |
| 설계·계약 변경 | `docs/design.md` |
| 실제 구현·배포·검증 상태 (날짜, 확인한 명령, 남은 것) | `docs/OPERATIONS.md` |
| 미결 질문, 추정 | `docs/OPEN_QUESTIONS.md` |
| 사람용 실행법 | `README.md` |

## 검증

- 코드를 바꾸면 `npm run typecheck`와 `npm test`를 실행한다.
- `Dockerfile`, `docker-compose*.yml`, `deploy/`를 바꾸면 `docker build`까지 확인한다. 운영 compose 서비스 이름 `404-express`와 네트워크 `replant-net`은 JustCommit 설정(`COURIER_BASE_URL`)과 맞물려 있으니 바꾸면 JustCommit 쪽 수정 필요로 보고한다. compose 검증에는 `.env`가 필요하므로 `.env.example`을 임시로 복사해 `docker compose config -q`를 실행하고 지운다.

## 비밀

- 실제 키는 Git 제외 파일 `.env`에만 둔다. `.env.example`에는 변수 이름과 비밀이 아닌 예시 값만 둔다. 키 값을 출력·문서·로그·커밋에 넣지 않는다.
