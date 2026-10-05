# 공개 전 보안 변경 적용 계획

2026-10-05 · 브랜치 `security/public-launch-hardening` · 운영 적용 전

## 구현한 변경

- API 키 테이블의 클라이언트 권한과 쓰기 정책 제거. 키 목록·폐기는 등록 사용자 인증을 확인한 Edge Function으로 유지한다. 직접 키 해시 삽입·폐기 취소가 불가능해진다.
- `public-api`는 `ENABLE_PUBLIC_API`가 정확히 `true`일 때만 데이터 요청을 처리한다. 기본값은 OFF이고 OpenAPI 문서는 계속 공개한다. 기존 발급 스위치와 별도로 동작한다.
- 피드백 함수는 비밀키 누락 시 503, 잘못된 키는 401. JSON은 실제 수신 바이트와 5초 deadline으로 제한한다. 피드백 한도는 기존 1.5M 문자 스크린샷을 수용하는 2 MiB, AI 요청은 256 KiB, 키 생성은 4 KiB다.
- AI의 사용자별 quota는 모든 호출자에 대해 fail closed다. 잘못된 quota 응답도 허용하지 않는다. 배치 작업은 실패 횟수를 늘리지 않고 대기 상태로 복귀한다.
- 유료 호출 직전에 service-role 전용 전역 quota를 추가했다. 초기 rolling 한도는 **시간당 60회·24시간당 1,000회**이며 DB의 `ai_runtime_limits`에서 조정/중지한다. 실패한 외부 호출도 전역 예약을 유지해 반복 429/timeout으로 무한 재시도하지 못하게 한다. 사용자 quota와 전역 quota 둘 다 통과해야 한다.
- Gemini 사용자 prompt는 16,384 문자, 출력은 512 토큰으로 제한한다. 이 한도는 호출·토큰 노출을 줄이며 화폐 단위의 정확한 지출 보장은 아니다. 모델 가격·생각 토큰·공급자 청구 지연을 반영한 금액 예산은 별도 설정이 필요하다.
- 큐 claim은 트랜잭션 advisory lock으로 직렬화하고 한 번에 최대 40개만 처리한다. 아직 활성 lease인 작업은 다시 선택하지 않는다. lease 만료 후 분산 작업의 정확히 한 번 실행을 보장하는 변경은 아니다.
- AI 결과 UPDATE에서도 부모 북마크 소유권을 확인한다.
- 업로드 이미지의 새 저장 주소는 stable authenticated URL이다. 화면은 기존 public URL과 새 주소를 소유자 인증으로 5분짜리 signed URL로 바꿔 표시한다. 30초 전에 갱신하고 계정 변경·세션 만료 시 이전 이미지를 숨긴다. 서명은 북마크·동기화·export에 저장하지 않는다.
- 이미지 비공개 전환과 새 SVG 업로드 제외 SQL을 준비했다. 기존 이미지·북마크 행은 보존한다. 기존 공개 복사본과 CDN 캐시는 정책 변경으로 회수할 수 없다.

## 운영 확인과 검증 결과

운영 DB를 읽기 전용으로 확인해 `api_keys`의 자기 행 ALL 정책과 클라이언트 DML GRANT, AI 결과 UPDATE의 북마크 소유권 조건 누락, 공개 이미지 버킷을 확인했다. 실제 사용자 자료나 키 해시는 조회하지 않았다. 운영 `chat`과 `ai-enrich-debug` 함수도 소스를 확인했으며 두 함수는 이미 중지 상태다.

통과한 검증:

- 전체 Node 테스트와 Edge Function 테스트.
- 컴포넌트 61개 묶음·899개 테스트(새 이미지 보호 테스트 4개 포함).
- 모바일 TypeScript, 함수 4개의 Deno TypeScript, CI lint와 diff 공백 검사.
- Expo 웹 export.
- 실제 핸들러를 mock fetch와 실행: 사용자/trigger/worker quota 오류·500·잘못된 응답·전역 거부 시 Gemini 호출 0회. 양쪽 명시적 승인 시 공급자 호출 가능. 대기 작업의 attempts는 보존.
- PGlite 로컬 PostgreSQL에서 기존 직접 키 발급을 재현한 뒤 수정된 SQL의 key CRUD/read 거부, AI 관계 격리, 내부 RPC 거부, 전역 시간/일 한도·중지·설정 누락 거부, 큐 40개 상한·활성 lease 보호, Storage 소유자 SELECT·private/SVG 설정 검증.

컴포넌트 runner는 테스트 종료 후 한 worker를 강제 종료했다는 경고를 남겼지만 899개 테스트는 모두 통과했다. 운영 Storage HTTP/CDN, 실제 기기, 동시 DB 연결의 claim 경쟁, live deployment smoke는 아직 수행하지 않았다. PGlite는 한 연결만 사용하므로 그 결과를 동시성 시험으로 표현하지 않는다.

로컬 SQL 검증 재현:

```sh
# PGlite 0.3.14를 격리된 임시 디렉터리에 설치한 뒤 실행한다.
node scripts/verify-public-launch-sql.mjs /tmp/keepory-security-db/node_modules/@electric-sql/pglite/dist/index.js
```

## 적용 순서

운영 적용은 자동 승인 검토에서 거부됐다. 거부 대상은 운영 DB에 마이그레이션·fixture를 트랜잭션으로 실행하는 요청이었다. 검토 사유는 운영 스키마/권한/함수 변형의 위험과 정확한 실행 방식에 대한 명시적 승인 부재다. 운영 마이그레이션·함수·버킷·웹 앱을 변경하지 않았다.

승인 후 적용할 구체적 단위:

1. 운영 프로젝트 `stzutoejnhzxzhjsjtsi`에 `20261005070404_public_launch_access_hardening.sql`, `20261005070406_ai_global_budget.sql`을 **각각 정식 마이그레이션으로 적용**하고 migration history/advisors/권한을 확인한다. 검토가 거부한 대규모 rollback 방식으로 먼저 실행하지 않는다.
2. `public-api`, `api-keys`, `feedback-bridge`, `ai-enrich` 함수를 이 브랜치 파일로 배포한다. AI의 새로운 RPC가 먼저 존재해야 한다. public API·키 발급 flag는 OFF 유지, 피드백 secret은 정상 설정을 확인한다. 설정 값은 로그/문서에 기록하지 않는다.
3. synthetic 계정으로 새 함수와 직접 REST 권한을 smoke한다. 시험 데이터 정리 절차를 정하고 기존 사용자 자료는 건드리지 않는다. 일시적으로 AI만 중지/재개해 유료 호출 게이트를 확인한다.
4. `ProtectedImage`를 포함한 웹·네이티브 클라이언트를 먼저 출시하고 실제 signed URL 생성·표시·만료·계정 전환을 확인한다.
5. 비공개 이미지 전환 정책을 확정한 뒤 `supabase/deferred-migrations/private_bookmark_images.sql`의 준비 SQL로 공식 CLI에서 새 마이그레이션을 생성해 적용한다. 이 SQL은 자동 적용 폴더 밖에 두어 main 병합만으로 이미지 정책이 먼저 바뀌지 않게 했다. 구버전은 public 주소를 직접 표시하므로 영향을 받는다. 업데이트 안내/버전 정책과 CDN 캐시 처리까지 포함해 수행한다.
6. 소유자 읽기 성공, 무인증/타인 읽기 실패, 업로드·기존 이미지·삭제·offline 동작을 실제 Storage HTTP에서 검증한다. 이전 공개 URL과 캐시 상태를 별도 확인한다.

운영 승인 범위에는 DB 마이그레이션 2개와 Edge Function 4개 적용을 명시한다. 이미지 전환은 클라이언트 출시와 호환 검증을 거친 별도 단계다.

## 이번 변경으로 종료하지 않는 항목

전역 화폐 예산·계정 생성 CAPTCHA·직접 REST/Storage 총량 및 egress 제한·키 scope/만료·공개 API 재개 조건·파일 실제 형식/픽셀 검증·클라이언트 URL 내부망 방어·CSP·관측 개인정보·공급망·백업 복구는 [위협 모델](../architecture/public-launch-threat-model.md)에 남아 있다. 이 브랜치가 적용됐다는 이유만으로 모든 출시 게이트가 충족됐다고 판단하지 않는다.

SQL·함수 변경은 유료 AI 가용성을 줄일 수 있지만 캡처·로컬 저장 경로를 차단하지 않는다. 한도·중지 상태 변경은 운영자만 수행하며 보수적인 기본값으로 시작한다.
