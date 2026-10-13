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
