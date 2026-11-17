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

## 운영 배포 (EC2, JustCommit과 같은 서버)

JustCommit과 같은 EC2에 두되 compose는 레포별로 따로 띄우고, 외부 Docker 네트워크 `replant-net`으로만 연결한다. 404-express는 포트를 공개하지 않는다.

| 방향 | 주소 |
| --- | --- |
| JustCommit → 404-express | `COURIER_BASE_URL=http://404-express:3000` (replant-net 별칭 `404-express`) |
| 404-express → JustCommit 웹훅 | `WEBHOOK_URL=http://replant-app:8080/api/v1/webhooks/courier` (Replant Spring 컨테이너의 replant-net 별칭) |

1. 네트워크 만들기 (EC2에서 처음 한 번, JustCommit과 공유):

   ```bash
   docker network create replant-net
   ```

2. `.env` 채우기: `.env.example`을 복사해 값을 넣는다. 필수는 `COURIER_API_KEY`, `WEBHOOK_API_KEY`, `WEBHOOK_URL`이고, 비어 있으면 기동하지 않는다. 두 키는 JustCommit `.env`와 같은 값이어야 한다. 키는 서버에서 직접 만들고 커밋하지 않는다.

   ```bash
   cp .env.example .env
   openssl rand -hex 32   # 키 만들기 (두 번 실행해 각각 사용)
   ```

3. 띄우기:

   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```

- 메모리 한도는 128MB다(`mem_limit`, V8 힙은 `NODE_OPTIONS=--max-old-space-size=80`). 로컬에서 띄웠을 때 약 28MB를 썼다.
- 데이터는 `courier-data` 볼륨의 `/data/courier.db`에 있다. `down -v`는 볼륨까지 지우므로 운영에서 쓰지 않는다.
- `docker-compose.standalone.yml`(Caddy로 80/443을 공개하는 단독 배포)은 404-express만 따로 공개 서버에 띄울 때 쓴다. 운영 EC2에서는 Replant Nginx와 80/443이 충돌하므로 쓰지 않는다. 기본 이름 `docker-compose.yml`이 없으므로 `-f` 없이 `docker compose up`을 실행하면 아무것도 뜨지 않는다.

## 상태 확인

`GET /health`는 인증 없이 `200 {"status":200,"message":"ok"}`를 준다. 컨테이너 HEALTHCHECK도 이 경로를 쓴다.

```bash
# EC2에서, replant-net 안의 다른 컨테이너 입장에서 연결 확인
docker run --rm --network replant-net curlimages/curl -s http://404-express:3000/health
```

```bash
# 컨테이너 상태 (healthy인지)
docker compose -f docker-compose.prod.yml ps
```

## 빠른 확인

```bash
curl -X POST https://$DOMAIN/api/v1/shipments \
  -H "X-Api-Key: $COURIER_API_KEY" \
  -H "Idempotency-Key: shipment-20261008-000001" \
  -H "Content-Type: application/json" \
  -d '{"sender":{"name":"a","phone":"1","address":"x"},"receiver":{"name":"b","phone":"2","address":"y"},"itemSummary":"monstera"}'
```

## 배송 취소

주문번호와 구매자가 취소를 누른 시각으로 보낸다. 판정은 택배사가 한다.

```bash
curl -X POST https://$DOMAIN/api/v1/shipments/byOrderNo/{courierOrderNo}/cancel \
  -H "X-Api-Key: $COURIER_API_KEY" -H "Content-Type: application/json" \
  -d '{"cancelRequestedAt":"2026-11-17T15:00:00+09:00"}'
```

| 상황 | 응답 |
| --- | --- |
| 누른 시각에 기사가 판매자 2km 밖 (또는 잠긴 뒤 30초 안 + 아직 수거 전) | 200 `CANCELLED`, `CANCELLED` 웹훅 |
| 위와 같은데 택배사 장애로 이미 수거됨 | 200 `RETURNING`, `returning: true`, 이후 `RETURNED` 웹훅 (택배사 비용 반송) |
| 그 밖 | 409 `SHIPMENT_NOT_CANCELLABLE` |
| 예약 전 | 200 (`trackingNo: null`), 늦게 온 같은 주문번호 예약은 409 `ORDER_ALREADY_CANCELLED` |

- 같은 주문번호를 다시 보내면 첫 판정을 그대로 돌려준다.
- 자세한 계약은 [docs/design.md](docs/design.md#주문번호-취소-2km-판정).

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
