# 404-express

JustCommit 식물 중고거래 서비스용 가짜 택배사 API. 설계와 API 계약은 [docs/design.md](docs/design.md)에 있다.

## 로컬 실행

Node 24 이상이 필요하다 (내장 `node:sqlite` 사용).

```bash
npm install
cp .env.example .env   # 값 채우기
npm run dev            # .env를 읽어서 watch 모드로 실행
```

## 테스트

```bash
npm test
```

## 배포 (Oracle 서버)

```bash
cp .env.example .env   # 운영 값, DOMAIN 채우기
docker compose up -d --build
```

Caddy가 `DOMAIN`으로 HTTPS 인증서를 자동 발급한다. 80/443 포트가 열려 있어야 한다.
데이터는 `courier-data` 볼륨의 `/data/courier.db`에 있다.

## 빠른 확인

```bash
curl -X POST https://$DOMAIN/api/v1/shipments \
  -H "X-Api-Key: $COURIER_API_KEY" \
  -H "Idempotency-Key: shipment-20261008-000001" \
  -H "Content-Type: application/json" \
  -d '{"sender":{"name":"a","phone":"1","address":"x"},"receiver":{"name":"b","phone":"2","address":"y"},"itemSummary":"monstera"}'
```

## 웹훅

배송 상태가 `PICKED_UP`, `IN_TRANSIT`, `DELIVERED`로 바뀌면 `WEBHOOK_URL`(JustCommit `/api/v1/webhooks/courier`)로 이벤트를 보낸다. 본문과 헤더 계약은 [docs/design.md](docs/design.md#웹훅-택배사--서버)에 있다.

### 재전송 규칙

| 응답 | 처리 |
| --- | --- |
| 2xx | 성공 |
| 5xx, 연결 실패, 타임아웃(5초) | 재전송 (warn 로그) |
| 4xx (401, 400 등) | 재전송하지 않음 (error 로그). 키·데이터 문제라 다시 보내도 같다 |

- 간격: 1분 → 5분 → 30분 → 2시간 → 6시간, 최대 5번.
- 같은 이벤트(`eventId`, `occurredAt` 그대로)를 다시 보낸다. 새 이벤트를 만들지 않는다.
- 이벤트마다 따로 예약하므로, 한 이벤트의 재전송이 다른 이벤트 전송을 막지 않는다. JustCommit이 중복과 순서 꼬임을 무시하므로 안전하다.
- 5번 모두 실패하면 실패 목록(`DEAD`)에 남고 error 로그를 찍는다. 목록은 DB에 있어 재시작해도 남는다.

로컬에서 간격을 줄이려면 `.env`에 아래처럼 쓴다(초, 쉼표 구분, 개수 = 최대 재전송 횟수):

```bash
WEBHOOK_RETRY_DELAYS_SEC=5,5,5,5,5
```

### 실패 목록 조회와 수동 재전송

`ADMIN_API_KEY`가 설정돼 있을 때만 열린다.

```bash
curl https://$DOMAIN/api/v1/admin/webhooks?status=DEAD -H "X-Admin-Key: $ADMIN_API_KEY"
```

```bash
curl -X POST https://$DOMAIN/api/v1/admin/webhooks/{eventId}/retry -H "X-Admin-Key: $ADMIN_API_KEY"
```

수동 재전송은 시도 횟수를 0으로 돌리고 바로 다시 보낸다. 내용은 처음 이벤트와 같다.
