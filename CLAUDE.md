@AGENTS.md

# Claude Code 추가 규칙

- 상태·웹훅·멱등 규칙처럼 계약에 닿는 설계 변경은 구현 전에 `grilling` 스킬로 사용자와 결정을 맞춘다. 이 저장소의 첫 설계도 그렇게 정했다.
- 동작을 바꾸는 코드는 `test/`에 실패하는 테스트를 먼저 추가한다. 시간은 `test/helpers.ts`의 `setup().tick()`으로 움직인다.
