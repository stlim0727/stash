# 공개 전 보안 변경 적용 계획

2026-10-05 · 브랜치 `security/public-launch-hardening` · 운영 DB/함수 적용 완료

## 구현한 변경

- API 키 테이블의 클라이언트 권한과 쓰기 정책 제거. 키 목록·폐기는 등록 사용자 인증을 확인한 Edge Function으로 유지한다. 직접 키 해시 삽입·폐기 취소가 불가능해진다.
- `public-api`는 `ENABLE_PUBLIC_API`가 정확히 `true`일 때만 데이터 요청을 처리한다. 기본값은 OFF이고 OpenAPI 문서는 계속 공개한다. 기존 발급 스위치와 별도로 동작한다.
- 피드백 함수는 비밀키 누락 시 503, 잘못된 키는 401. JSON은 실제 수신 바이트와 5초 deadline으로 제한한다. 피드백 한도는 기존 1.5M 문자 스크린샷을 수용하는 2 MiB, AI 요청은 256 KiB, 키 생성은 4 KiB다.
- AI의 사용자별 quota는 모든 호출자에 대해 fail closed다. 잘못된 quota 응답도 허용하지 않는다. 배치 작업은 실패 횟수를 늘리지 않고 대기 상태로 복귀한다.
- 유료 호출 직전에 service-role 전용 전역 quota를 추가했다. 초기 rolling 한도는 **시간당 60회·24시간당 1,000회**이며 DB의 `ai_runtime_limits`에서 조정/중지한다. 실패한 외부 호출도 전역 예약을 유지해 반복 429/timeout으로 무한 재시도하지 못하게 한다. 사용자 quota와 전역 quota 둘 다 통과해야 한다.
- Gemini 사용자 prompt는 16,384 문자, 출력은 512 토큰으로 제한한다. 이 한도는 호출·토큰 노출을 줄이며 화폐 단위의 정확한 지출 보장은 아니다. 모델 가격·생각 토큰·공급자 청구 지연을 반영한 금액 예산은 별도 설정이 필요하다.
- 큐 claim은 트랜잭션 advisory lock으로 직렬화하고 한 번에 최대 40개만 처리한다. 아직 활성 lease인 작업은 다시 선택하지 않는다. lease 만료 후 분산 작업의 정확히 한 번 실행을 보장하는 변경은 아니다.
- AI 결과 UPDATE에서도 부모 북마크 소유권을 확인한다.
- 업로드 이미지의 저장 주소는 구버전 호환을 위해 기존 public 참조를 유지한다. 화면은 기존 public URL과 authenticated 주소를 소유자 인증으로 5분짜리 signed URL로 바꿔 표시한다. 30초 전에 갱신하고 계정 변경·세션 만료 시 이전 이미지를 숨긴다. 서명은 북마크·동기화·export에 저장하지 않는다.
- 이미지 비공개 전환과 새 SVG 업로드 제외 SQL을 준비했다. 클라이언트도 같은 MIME 허용 목록을 검사하며 SVG 등 제외 형식은 기기에 보존하고 영구 업로드 실패로 분류해 반복 재시도를 멈춘다. 기존 이미지·북마크 행은 보존한다. 기존 공개 복사본과 CDN 캐시는 정책 변경으로 회수할 수 없다.

## 운영 확인과 검증 결과

운영 DB를 읽기 전용으로 확인해 `api_keys`의 자기 행 ALL 정책과 클라이언트 DML GRANT, AI 결과 UPDATE의 북마크 소유권 조건 누락, 공개 이미지 버킷을 확인했다. 실제 사용자 자료나 키 해시는 조회하지 않았다. 운영 `chat`과 `ai-enrich-debug` 함수도 소스를 확인했으며 두 함수는 이미 중지 상태다.

통과한 검증:

- 전체 Node 테스트와 Edge Function 테스트.
- 컴포넌트 61개 묶음·899개 테스트(새 이미지 보호 테스트 4개 포함).
- 모바일 TypeScript, 함수 4개의 Deno TypeScript, CI lint와 diff 공백 검사.
- Expo 웹 export.
- 실제 핸들러를 mock fetch와 실행: 사용자/trigger/worker quota 오류·500·잘못된 응답·전역 거부 시 Gemini 호출 0회. 양쪽 명시적 승인 시 공급자 호출 가능. 대기 작업의 attempts는 보존.
- PGlite 로컬 PostgreSQL에서 기존 직접 키 발급을 재현한 뒤 수정된 SQL의 key CRUD/read 거부, AI 관계 격리, 내부 RPC 거부, 전역 시간/일 한도·중지·설정 누락 거부, 큐 40개 상한·활성 lease 보호, Storage 소유자 SELECT·private/SVG 설정 검증.

컴포넌트 runner는 테스트 종료 후 한 worker를 강제 종료했다는 경고를 남겼지만 899개 테스트는 모두 통과했다. 운영 Storage HTTP/CDN, 실제 기기, 동시 DB 연결의 claim 경쟁, 아래에 기록한 운영 smoke 이외의 검증은 아직 수행하지 않았다. PGlite는 한 연결만 사용하므로 그 결과를 동시성 시험으로 표현하지 않는다.

로컬 SQL 검증 재현:

```sh
# PGlite 0.3.14를 격리된 임시 디렉터리에 설치한 뒤 실행한다.
node scripts/verify-public-launch-sql.mjs /tmp/keepory-security-db/node_modules/@electric-sql/pglite/dist/index.js
```

## 적용 순서

사용자가 DB 마이그레이션 2개와 함수 4개 적용을 명시적으로 승인한 뒤 아래 1–3단계를 수행했다. 이전에 거부된 마이그레이션·fixture DDL rollback 방식은 사용하지 않았다. 이미지와 웹·네이티브 클라이언트 출시는 아직 수행하지 않았다.

### 2026-10-05 운영 적용 증거

- 정식 migration history: `20261005091733_public_launch_access_hardening`, `20261005091739_ai_global_budget`. 로컬 파일명도 운영 이력과 맞췄다.
- 함수 ACTIVE: `public-api` v20, `api-keys` v13(JWT 검증 ON), `feedback-bridge` v10, `ai-enrich` v30.
- 무인증: public API 데이터 403, OpenAPI 200, 키 관리·피드백·AI 401. 피드백 secret이 설정돼 있음을 거부 응답으로 확인했으며 외부 Sentry 보고서는 전송하지 않았다.
- 임시 등록 계정: 키 목록 200, 키 발급 OFF 403, 직접 api_keys 읽기 403, 전역 budget RPC 직접 호출 403, 북마크 저장 201. 기존 사용자 자료는 조회하지 않았다.
- 일시적 AI 중지에서 함수 429 `ai_paused`; 설정은 enabled=true로 복원했다. 시험 사용자와 북마크 잔존 0건을 확인했다.
- anon/authenticated의 API 키 읽기·삽입과 새 budget/claim 실행 권한은 false, service_role은 true. 전역 한도 60/시간·1000/24시간을 확인했다.
- 운영 트랜잭션에서 daily_call_limit=0일 때 budget RPC가 `global_budget_limit`으로 거부함을 확인하고 rollback했다.
- 공개 이미지 버킷 전환과 클라이언트 출시는 보류 상태다. 정상 피드백의 실제 외부 전달, 이미지 HTTP/CDN, 동시 DB claim 검증은 별도 수행해야 한다.

### 운영 advisor 후속 항목

새 private tables와 api_keys의 RLS 정책 없음 INFO는 클라이언트 접근을 차단하려는 의도와 일치한다. 기존 RPC `_ai_enrichment_slot`, `request_ai_enrichment_slot_for`, `refund_ai_enrichment_slot_for`의 클라이언트 실행 권한 문제는 후속 진행 요청에 따라 정식 migration `20261005092956_ai_quota_rpc_access.sql`로 운영에서 해결했다. PUBLIC/anon/authenticated 실행을 제거하고 service_role 실행을 유지했다. 함수 본문·정상 사용자 self-quota 경로는 변경하지 않았다. [SECURITY DEFINER 권한 점검](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).

후속 검증 결과:

- 로컬 DB에서 타인 한도 예약과 무인증 환불을 먼저 재현했다. 수정 후 두 client 역할의 세 RPC 호출이 거부되고 ledger가 바뀌지 않는다.
- 임시 등록 계정으로 운영 세 RPC 호출은 모두 403. 본인 `request_ai_enrichment_slot()`은 200/allowed, service_role 예약은 200/allowed, 환불은 204다. self 예약 1건만 남는 ledger도 확인한 뒤 시험 계정을 삭제했다.
- 운영 권한 행렬에서 세 RPC는 anon/authenticated=false, service_role=true. self-quota RPC의 기존 권한은 유지된다.
- 재실행 advisor에서 문제의 세 RPC는 두 SECURITY DEFINER 경고 그룹 모두에서 사라졌다. 나머지 경고는 trigger/self-quota/기존 클라이언트 RPC 검토 항목이다.
- 임시 시험 계정 잔존 0건, 전역 AI enabled=true/60시간당/1000일당 설정을 확인했다. 전역 중지·provider 호출·외부 피드백 전달은 이번 후속 시험에서 하지 않았다.


그 밖에 [유출 비밀번호 보호 OFF](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), [public 스키마 pg_net](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public), [RLS 반복 평가 34건](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan), [외래키 인덱스 6건](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys)이 남는다. anonymous 접근 경고는 익명 우선 제품의 소유권 정책과 함께 개별 검토해야 한다. Trigger 함수와 정상 클라이언트 RPC의 SECURITY DEFINER 경고도 무조건 일괄 차단하지 않는다.

적용/후속 순서:

1. 운영 프로젝트 `stzutoejnhzxzhjsjtsi`에 `20261005091733_public_launch_access_hardening.sql`, `20261005091739_ai_global_budget.sql`을 **각각 정식 마이그레이션으로 적용**하고 migration history/advisors/권한을 확인한다. 검토가 거부한 대규모 rollback 방식으로 먼저 실행하지 않는다.
2. `public-api`, `api-keys`, `feedback-bridge`, `ai-enrich` 함수를 이 브랜치 파일로 배포한다. AI의 새로운 RPC가 먼저 존재해야 한다. public API·키 발급 flag는 OFF 유지, 피드백 secret은 정상 설정을 확인한다. 설정 값은 로그/문서에 기록하지 않는다.
3. synthetic 계정으로 새 함수와 직접 REST 권한을 smoke한다. 시험 데이터 정리 절차를 정하고 기존 사용자 자료는 건드리지 않는다. 일시적으로 AI만 중지/재개해 유료 호출 게이트를 확인한다.
4. `ProtectedImage`를 포함한 웹·네이티브 클라이언트를 먼저 출시하고 실제 signed URL 생성·표시·만료·계정 전환을 확인한다.
5. 비공개 이미지 전환 정책을 확정한 뒤 `supabase/deferred-migrations/private_bookmark_images.sql`의 준비 SQL로 공식 CLI에서 새 마이그레이션을 생성해 적용한다. 이 SQL은 자동 적용 폴더 밖에 두어 main 병합만으로 이미지 정책이 먼저 바뀌지 않게 했다. 구버전은 public 주소를 직접 표시하므로 영향을 받는다. 업데이트 안내/버전 정책과 CDN 캐시 처리까지 포함해 수행한다.
6. 소유자 읽기 성공, 무인증/타인 읽기 실패, 업로드·기존 이미지·삭제·offline 동작을 실제 Storage HTTP에서 검증한다. 이전 공개 URL과 캐시 상태를 별도 확인한다.

운영 승인 범위에는 DB 마이그레이션 2개와 Edge Function 4개 적용을 명시한다. 이미지 전환은 클라이언트 출시와 호환 검증을 거친 별도 단계다.

## 이번 변경으로 종료하지 않는 항목

전역 화폐 예산·계정 생성 CAPTCHA·직접 REST/Storage 총량 및 egress 제한·키 scope/만료·공개 API 재개 조건·파일 실제 형식/픽셀 검증·클라이언트 URL 내부망 방어·CSP·관측 개인정보·공급망·백업 복구는 [위협 모델](../architecture/public-launch-threat-model.md)에 남아 있다. 이 브랜치가 적용됐다는 이유만으로 모든 출시 게이트가 충족됐다고 판단하지 않는다.

SQL·함수 변경은 유료 AI 가용성을 줄일 수 있지만 캡처·로컬 저장 경로를 차단하지 않는다. 한도·중지 상태 변경은 운영자만 수행하며 보수적인 기본값으로 시작한다.

## 후속 클라이언트 변경: 자동 미리보기 네트워크

`preview-network.ts`는 HTTP(S), 기본 웹 포트, 자격증명 없는 공개 주소만 자동 요청하도록 검사한다. localhost/내부 도메인·사설/loopback/link-local/CGNAT IPv4·IP 우회 표기·IPv6 literal을 거부한다. 북마크 저장·명시적으로 링크 열기는 변경하지 않는다. HTML, discovery oEmbed, provider 요청과 단축 링크 HEAD에 적용하고 OG/favicon/oEmbed 이미지 주소도 검사한다. 기존 저장된 내부망 이미지 주소는 ProtectedImage에서 숨기며 파일 로컬 이미지는 계속 표시한다.

manual redirect는 다음 요청 전에 Location을 재검사하며 최대 5회, cycle은 거부한다. 브라우저의 opaque redirect는 미리보기 실패로 처리해 일부 웹 단축 링크의 자동 미리보기가 감소할 수 있다. 네이티브 `preview-fetch.native.ts`는 `expo/fetch`를 명시적으로 사용한다. 설치된 Expo SDK 56 Android NativeRequest의 manual-mode followRedirects=false 구현을 확인했다. global fetch가 RN XHR 구현으로 바뀌는 설정에도 자동 추적을 의존하지 않는다. [Expo fetch 문서](https://docs.expo.dev/versions/latest/sdk/expo/), [OWASP 리다이렉트·DNS 방어 지침](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

이 변경은 DNS 조회·IP pinning·DNS rebinding 방어가 아니다. 공개 도메인이 사설 IP를 반환하거나 재해석되는 문제는 resolver-aware proxy/transport와 egress 제한이 필요하다. React Native Image 및 기존 favicon 표시의 DNS/리다이렉트 네트워크 격리도 아직 보장하지 않는다. 실제 기기에서 공개→내부망 redirect 수신 0건을 확인해야 한다. 새 클라이언트는 아직 운영에 출시하지 않았다.

검증 완료: 모바일 Node 115개 테스트 파일, 변경된 메타데이터/네트워크 회귀 테스트, 이미지 컴포넌트 5개 테스트, TypeScript/lint, Expo 웹 export와 Android Hermes bundle export. Android export는 설치·실기기 네트워크 시험이 아니다.

회귀 검증은 IP 별칭/자격증명/금지 scheme/내부망 주소, 사설 redirect의 다음 요청 0건, 상대 redirect/loop/최대 hop, opaque redirect 거부, 정상 메타데이터, private thumbnail 제외, signed image/계정 전환/로컬 이미지 보존을 포함한다.

## 남은 출시 작업의 의존 관계

### 웹 헤더 및 배포 의존성 후속 조치 (2026-10-06)

`public/_headers`에 모든 static asset/SPA 경로용 CSP(`base-uri 'none'`,
`object-src 'none'`, `frame-ancestors 'none'`), DENY framing, nosniff,
no-referrer, camera/microphone/geolocation 차단을 추가했다. 외부 북마크로
이동하거나 이미지를 요청할 때 페이지 URL의 전달을 줄인다. 이 CSP는
script-src를 제한하지 않으므로 스크립트 주입 방어 완료로 표시하지 않는다.
Expo inline bootstrap 및 동적 스타일과 호환되는 script/style 정책과 실제
Cloudflare 응답·브라우저 검증은 남아 있다.
[Workers Static Assets 헤더 지침](https://developers.cloudflare.com/workers/static-assets/headers/).

배포 설치는 `pnpm install --frozen-lockfile`로 고정하여 manifest/lockfile
불일치 시 배포를 중단한다. 의존성 취약점 점검, Actions SHA 고정 및
빌드 자격증명 접근 검토는 별도 남은 항목이다.

로컬 검증: 루트 `pnpm lint`, shell 구문 및 diff 검사 통과. Expo 웹 export
성공과 export의 `_headers`가 원본과 바이트 단위로 일치함을 확인했다.
이는 배포 서버가 헤더를 실제 반환하는지에 대한 증거는 아니다.

후속 CSP는 `script-src 'self' 'wasm-unsafe-eval'`도 적용한다. Inline
script/handler, 외부·data script, JavaScript eval/new Function을 허용하지
않으며 Markdown에 필요한 WebAssembly 컴파일만 허용한다. 연결·이미지·
동적 스타일 출처 제한은 별도 검증이 필요하다. Turnstile 도입 시 공식
challenge 출처를 명시적으로 추가하고 관련 브라우저 검증도 확장한다.

`node scripts/verify-web-security.mjs /absolute/path/to/export`는 실제
Chrome에서 export의 헤더를 적용한 loopback 서버로 홈·설정·개인정보·
삭제 안내의 렌더링과 hydration을 확인했다. 공격 fixture 9종의 실행 차단,
외부 script 요청 0건, base 변경·object·iframe 차단, 정상 동일 출처 script
및 WebAssembly 실행을 검증했다. 임시 브라우저 프로필은 삭제하며 외부
네트워크/쓰기 요청은 차단한다. GitHub CI의 웹 export 직후에도 실행한다.
이 결과는 실제 Cloudflare의 헤더 적용 검증을 대신하지 않는다.

GitHub workflow Actions 8종(총 24개 사용 위치)은 2026-10-06 GitHub API로
조회한 기존 major 태그의 실제 전체 commit SHA로 고정했다. 일반 CI·
Firebase cleanup·Supabase 점검·Play 제출의 기본 GitHub 토큰은
`contents: read`이며 checkout 자격증명을 작업 디렉터리에 남기지 않는다.
Sentry mirror는 `issues: write`를 유지한다. APK 작업은 Release와 dev 태그
게시가 필요하여 기존 `contents: write` 및 checkout push 자격증명을 유지한다.
루트 lint가 mutable action 참조를 거부하고 Dependabot이 Actions/npm의
주간 갱신 PR을 생성하도록 설정했다. 외부 Actions 자체와 transitive
Actions, 임의 npx/curl 설치 및 CircleCI secret 격리는 추가 검토 대상이다.
[GitHub Actions 보안 지침](https://docs.github.com/en/actions/reference/security/secure-use).

| 항목 | 현재 상태 | 다음 적용 조건 |
| --- | --- | --- |
| 이미지 비공개 | 서명 클라이언트 및 deferred SQL 준비 | 호환 클라이언트 배포와 실기기/Storage HTTP 확인 후 버킷 전환 |
| CAPTCHA | 기존 Turnstile 사이트 키와 도전·GoTrue 토큰 전달 구현, 클라이언트 기본 활성 | 실제 웹/기기 도전·서버 실패/재사용 검증 및 호환 배포 후 Auth에서 활성화 |
| REST/Storage 총량 | 북마크 개수 제한은 운영 비활성, 파일 용량 제한은 미구현 | 계정/프로젝트 한도 확정·활성화, 파일은 업로드 승인·원본 우회 차단 포함 |
| 미리보기 내부망 | literal URL와 manual redirect 방어 구현 | 클라이언트 배포·실기기 확인·DNS/이미지 transport 격리 |
| 화폐 예산 | AI 호출 60/시간·1000/24시간 | 공급자 프로젝트 billing cap/alert와 운영 kill switch 연결 |

CAPTCHA를 지금 켜면 token 없이 로그인하는 현재 클라이언트가 실패할 수 있다. 클라이언트 제한만 추가해도 Supabase 원본 API로 우회할 수 있으므로 총량 방어 완료로 표시하지 않는다. 이미 저장된 데이터를 제거하거나 임의의 quota 값을 운영에 적용하지 않았다.

## 후속 운영 변경: 북마크 개수 제한

`20261005113906_bookmark_capacity_limits.sql`을 정식 운영 migration으로 적용했다. 초기 `enabled=false`, 계정·프로젝트 한도는 NULL이다. 현재는 집계만 수행하며 새 저장을 제한하지 않는다. 적용 시 기존 북마크 3,637개를 보존하고 전역/사용자 집계를 초기화했다. 사용자별 내용이나 URL은 조회하지 않았다.

`bookmarks` AFTER trigger가 실제 행 수를 private usage ledger에 반영한다. 계정 유형은 서버 `auth.users.is_anonymous`로 확인하며, 임의 클라이언트 metadata를 신뢰하지 않는다. 행 잠금으로 프로젝트→계정 순서를 직렬화하고, 동시 요청이 stale count로 한도를 초과하지 않도록 한다. 클라이언트는 설정/집계를 직접 읽거나 쓸 수 없으며 `get_bookmark_capacity()`로 본인 used/limit만 읽는다. 활성화되면 초과 INSERT는 HTTP 429 `bookmark_capacity_limit`으로 거부된다. 이미 저장된 행 수정과 삭제는 허용하고, trash도 개수에 포함한다. 영구 삭제·계정 삭제는 집계를 줄인다. 기존 ID의 upsert는 중복 차감하지 않고 소유자 이동은 목적 계정 한도를 검사한다. 실패한 bulk 요청은 모든 행/집계를 rollback한다.

운영 smoke: 임시 등록 사용자 상태 RPC 200, 원장/설정 SELECT와 설정 PATCH 403, bulk 저장 201, 수정·삭제 정상, own used 0→2→0. 시험 계정 잔존 0건, 전역 및 사용자 집계가 실제 북마크 행 수와 모두 일치한다. Auth 삭제 외에 기존 사용자 자료는 변경하지 않았다. 새로운 private 테이블의 RLS 정책 없음 INFO와 self status RPC의 SECURITY DEFINER 경고는 의도한 접근 모델과 함께 검토했다. [권한 점검 지침](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).

검증: PGlite의 기존 행 보존·계정/프로젝트 cap·bulk rollback·upsert·소유자 이동·한도 하향·삭제/cascade·비활성 집계. 추가로 **격리 PostgreSQL 17.10의 20개 독립 연결**에서 계정 cap=1 및 서로 다른 계정의 project cap=1 모두 정확히 한 요청만 허용했다. 열린 첫 트랜잭션의 rollback 후 대기 요청이 허용되고 row/사용자/project ledger가 일치함도 확인했다. 이 시험은 운영 DB를 사용하지 않는다.

```sh
node scripts/verify-bookmark-capacity-concurrency.mjs \
  /tmp/keepory-security-pg/node_modules/@embedded-postgres/linux-x64/native \
  /tmp/keepory-security-pg/node_modules/pg/lib/index.js
```

격리 도구 버전: `@embedded-postgres/linux-x64@17.10.0-beta.17`(PostgreSQL binary 17.10), `pg@8.16.3`. 앱 의존성과 lockfile은 변경하지 않았다. 바이너리의 hydration script로 상대 symlink를 복원한 뒤 실행했다. 시험 서버는 127.0.0.1만 listen하며 종료/fixture 디렉터리 삭제까지 수행한다.

활성화 전에는 익명·등록·프로젝트 한도를 모두 정하고 최대 기존 usage, bulk import 제품 정책, 429 표시/재시도 UX를 확인한다. 설정 행 잠금으로 모든 신규 북마크 거래가 직렬화되므로 활성화 여부와 무관하게 쓰기 지연을 관측해야 한다. 단일 호출/본문 크기·테이블별 bytes·태그/폴더/feedback·가입률·저장 파일·egress는 이 개수 제한의 보장 범위 밖이다. 다계정 공격은 project cap까지 필요하며 해당 값도 아직 미설정이다.

파일 용량 한도는 업로드 전 예약·검증된 실제 크기·재시도/교체/삭제 정산·프로젝트 cap·기존 직접 upload RLS 경로 차단을 함께 구현해야 한다. `storage.objects` 직접 DML이나 강제 트리거로 Storage 본체와 메타데이터를 어긋나게 만들지 않는다. [Supabase Storage 스키마 운영 지침](https://supabase.com/docs/guides/storage/schema/design). CAPTCHA 또한 공급자 사이트 설정과 호환 도전 UI가 필요하다. [Supabase CAPTCHA 적용 순서](https://supabase.com/docs/guides/auth/auth-captcha).


### PR #896 이미지 리뷰 후속 수정

- 구버전의 plain Image가 인증 헤더 없이도 읽을 수 있도록 업로드 결과는 기존 `/object/public/` 참조를 저장한다. 새 ProtectedImage는 해당 참조를 소유자 signed URL로 바꾼다. 버킷 비공개 전환은 호환 클라이언트 배포 및 버전 정책 확인 후 시행한다.
- SVG/JXL 등 예정된 버킷 허용 목록 밖의 MIME은 업로드 전에 영구 오류로 분류한다. 원본 MIME과 기기의 durable 파일은 보존하며 상세 화면의 동기화 오류에 기기 보존 및 PNG/JPEG로 다시 저장하는 방법을 남긴다. 강제 동기화도 해당 행을 재시도하지 않는다.
- 연속된 서명 실패도 60초→120초→240초→최대 300초 간격으로 계속 복구를 시도하며 unmount/계정·세션 변경 시 이전 요청과 타이머를 정리한다. 서명 요청이 성공하면 다음 갱신의 일시적 실패에 대한 재시도 간격을 초기화한다. 이미지 디코딩 오류의 재시도는 별도 관리하여 성공한 서명 때문에 무한 이미지 재요청이 발생하지 않는다.
- 회귀 검증: 구버전 public 참조, 반복되는 갱신 실패 및 연속 실패 후 복구·재시도 간격 상한·unmount 타이머 정리, 디코딩 오류의 재시도 상한, 실제 store의 SVG 파일 보존·네트워크 업로드 0건·오류 노출·강제 재시도 제외를 확인했다.

2026-10-06 추가 리뷰: 갱신 실패 시 이미 표시된 signed image를 지우지
않고 기존 URL을 유지하며 백그라운드 backoff를 계속한다. 서명 만료는
Storage가 새 다운로드에서 집행하며, 이미 디코딩된 이미지를 클라이언트
시계만으로 버리지 않는다. 첫 서명 실패와 decode 오류에서는 새 공개
읽기 경로를 사용하지 않는다. 계정·참조 URL·세션 credential 변경은 기존
이미지를 즉시 숨기고 상태를 비운다. 이전 credential의 늦은 응답도
폐기한다. 컴포넌트 회귀는 만료 시점 이후 부모 재렌더에서도 이미지
유지·새 서명으로 복구·credential 전환 후 늦은 완료 차단을 포함한다.


### 실제 Storage 및 미리보기 후속 검증 (2026-10-05)

공개 publishable 키와 시험 계정 JWT로 기존 운영 버킷에서 1픽셀 PNG를 검증했다. 소유자 업로드·서명 생성·서명 다운로드는 200이며 파일 바이트가 일치한다. 타인의 서명 생성·덮어쓰기는 400, 삭제는 200이지만 삭제 행 0건이며 소유자의 파일은 그대로 남았다. 무인증 public 다운로드와 타인의 authenticated 다운로드는 모두 200이다. 현재 public 버킷은 authenticated 경로에서도 공개 읽기를 허용하므로 서명 표시 자체를 비공개 보호로 보지 않는다. 정책 변경 후 반드시 실제 Storage HTTP를 다시 검증해야 한다.

시험 파일과 두 계정은 finally에서 삭제 후 부재를 확인했다. 별도 DB 조회에서도 시험 계정·시험 객체 잔존 0건을 확인했다. 기존 사용자 자료와 버킷 설정은 변경하지 않았다.

PR 미리보기 커밋 `517d47a`의 배포 성공을 확인하고 격리 Chrome으로 홈·설정 화면을 렌더링했다. 설정의 커밋 표시가 일치하고 Runtime exception은 0건이다. GET/HEAD/OPTIONS 외 요청을 차단한 읽기 전용 시험으로, 로그인·실제 이미지 표시·native 동작의 증거는 아니다. 이후 연속 서명 실패 수정의 별도 회귀 테스트와 CI를 수행하며, 이 브라우저 증거를 이후 커밋의 검증으로 확장하지 않는다.


### PR #896 네트워크·프롬프트 추가 리뷰 대응

- `home.arpa` apex도 하위 도메인과 함께 차단한다. 대소문자·마지막 점 변형과 redirect에 대한 회귀 시험에서 내부 주소 요청 0건을 확인했다.
- IPv4 192.0.0.0/24와 192.0.2.0/24 차단은 세 번째 옥텟까지 검사한다. 기존 192.168.0.0/16 차단은 유지하면서 과도하게 차단하던 192.0.1.x, 192.0.3.x, 192.2.x 등을 허용한다. 이 분류는 네트워크 도달 가능성이나 DNS rebinding 방어를 보증하지 않는다. [IANA 특수 목적 IPv4 등록부](https://www.iana.org/assignments/iana-ipv4-special-registry).
- Gemini 프롬프트의 고정 지침·언어 설정·필드 구분자 공간을 먼저 확보하고 남은 공간을 메타데이터 값에 배분한다. 짧은 값의 남는 공간은 긴 값에 재배분하여 전체 16,384자 한도를 유지한다. 큰 vocabulary 목록의 조립도 제한하고 Unicode surrogate 경계에서 문자를 분리하지 않는다. 기존 사용자 데이터는 바꾸지 않는다.
- 각 메타데이터가 50,000자인 경우에도 기존 컬렉션·태그와 한국어 지침이 남는지, 모든 필드·vocabulary가 매우 커도 고정 지침과 512 output token 한도가 유지되는지 provider 전송 본문으로 검증했다. 유료 API는 테스트에서 호출하지 않았다.

AI 함수 후속 배포: `ai-enrich` v31 ACTIVE. 원격 소스 readback의 provider가 검증한 로컬 파일과 일치하고 무인증 HTTP 요청은 401이다. JWT 자체 검증·프로젝트 AI 예산·사용자 quota 경로는 그대로 유지했다. 이 smoke에서는 유료 모델 호출과 사용자 자료 변경을 하지 않았다.


### Turnstile 단계적 연결

사용자가 생성한 기존 위젯의 공개 Site Key는 `0x4AAAAAAFPASxaYl2wtIAFc`이다.
`captcha.ts`에 기본값으로 포함해 웹·APK 빌드에 추가 CI 변수가 필요하지 않다.
`EXPO_PUBLIC_TURNSTILE_SITE_KEY`로 다른 환경의 공개 키를 지정할 수 있다.
클라이언트 도전은 기본 활성이고, `EXPO_PUBLIC_TURNSTILE_ENABLED=false`는
보호하지 않는 별도 개발용 Auth 환경에서만 사용한다. 운영 위젯은
`keepory.app`만 허용하고 개발/미리보기는 별도 위젯·Auth 환경을 사용한다.
Secret Key는 저장소나 채팅에 넣지 않으며 Supabase Auth의
Authentication → Bot and Abuse Protection → CAPTCHA에 직접 등록한다.
사용자는 Secret Key 등록을 완료했다고 알려왔다. 운영 Auth 음성 smoke에서
누락 토큰은 `400 captcha_failed / no captcha_token found`, 위조 토큰은
`400 captcha_failed / invalid-input-response`로 거부되어 서버 활성화가
확인됐다. **호환 클라이언트 배포 전의 활성화는 잘못된 순서다. 현재 출시
버전의 익명 가입이 실패할 수 있어 보호 스위치를 우선 비활성화해야 한다.**
사용자가 보호 스위치를 비활성화한 뒤 토큰 없는 잘못된 가입 입력은
`422 weak_password`를 반환했다. CAPTCHA 거부가 해제됐고 계정은 만들지
않았다. 해당 운영 리뷰를 해결 처리했다. Secret Key는 유지하고 호환 버전 배포·실제 성공 검증·구버전 처리
완료 후에만 다시 활성화한다. 검증 요청은 유효하지 않은 이메일·암호를 사용했고 계정을 만들지
않았다. 실제 성공 및 토큰 재사용 거부는 아직 검증하지 않았다.

웹은 명시적 도전 대화상자를, 네이티브는 시스템 인증 브라우저와
`https://keepory.app/captcha.html`을 사용한다. 네이티브 콜백은
`stash://captcha/callback`으로 고정하고 매번 생성한 256비트 nonce를 확인한다.
토큰과 nonce는 URL fragment에 전달하며 호스팅 페이지는 외부 스크립트를
읽기 전에 fragment를 주소에서 제거한다. 토큰을 저장하거나 재사용하지
않으며 GoTrue에는 `gotrue_meta_security.captcha_token`으로 전달한다.
취소·시간 초과·잘못된 콜백은 가입을 중단한다. 로그아웃과 공급자 전환,
언마운트 시 대기 중인 도전을 취소하고 늦은 도전 응답을 무시한다.

배포 순서는 호스팅 페이지/CSP 배포, 플래그와 사이트 키를 포함한 웹·네이티브
호환 버전 배포, 실제 기기 검증 및 구버전 처리 결정, Auth 서버 CAPTCHA
활성화 순이다. 서버 활성화 전에 유효/누락/오류/만료/재사용 토큰을 검증하고,
오프라인 캡처와 도전 실패 후 저장 항목 유지도 확인한다. 로컬 단위 테스트는
실제 Cloudflare 도전 성공이나 Supabase 서버 검증을 증명하지 않는다.


가입 검증은 기존 Supabase Auth가 Cloudflare Siteverify를 호출하는 경로다.
추가 Worker나 프록시를 배포하지 않고 브라우저에서 Siteverify를 호출하지
않는다. [Supabase CAPTCHA 설정](https://supabase.com/docs/guides/auth/auth-captcha).
Spin 예제의 별도 action/hostname 검증과 동일하다고 주장하지 않는다:
[GoTrue CAPTCHA 응답 타입](https://github.com/supabase/auth/blob/master/internal/security/captcha.go)은
success/error-codes/hostname을 포함하고 action 필드를 노출하지 않는다.
운영 위젯의 hostname 제한을 유지하고 로컬/미리보기 호스트를 같은 운영
위젯에 추가하지 않는다. 실제 성공·누락·오류·토큰 재사용 검증이 완료되기
전에는 운영 방어 완료로 표시하지 않는다.


로컬 검증: 익명 가입 대기/취소/언마운트/늦은 응답/강제 갱신과 네이티브
nonce·콜백·시간 초과·abort 회귀, GoTrue 실제 요청 body·토큰 비저장,
CAPTCHA 실패 중 로컬 캡처·내구성 큐 유지가 통과했다. 격리 Chrome은 실제
웹 어댑터와 exported captcha 페이지에 공급자 대역을 사용하여 대화상자
성공·오류·만료·취소·abort·스크립트/렌더 실패·정리 및 CSP를 확인했다.
대역 검증을 실제 Cloudflare 성공 검증으로 간주하지 않는다.


### PR #896 추가 운영 리뷰 대응 (2026-10-06)

이미지 서명의 영구 HTTP 4xx 오류(401/408/409/425/429 제외)는 재시도를
멈추고 호출자의 오류 처리로 전달한다. 일시적 오류는 기존 제한된 backoff를
유지하고 세션 변경 시 새 요청을 허용한다. 22개 이미지 컴포넌트 회귀가 통과했다.

AI 전역 예산 거부 시 `retry_not_before`를 저장하고 다음 처리 묶음부터
전역 예산 예약을 건너뛴다. 이미 확보한 사용자 quota는 환불하고 attempts는
증가시키지 않는다. claim RPC는 예약 시각까지 해당 항목을 제외한다.
40개 항목 배치 회귀와 PostgreSQL 17의 대기/재개·리스·접근 권한 시험이
통과했다. `20261006125417_ai_queue_budget_backoff`를 운영에 먼저 적용한 뒤
`ai-enrich` v32 ACTIVE로 배포했다. 배포 후 무인증 HTTP 요청은 401이다.
실제 유료 모델 호출은 이 검증에 포함하지 않았다.


### CircleCI 체크 실패 정정 및 테스트 종료 수정

커밋 `fdef765`의 GitHub Actions는 통과했지만 CircleCI checks는 실패했다.
전체 CI 통과라는 이전 보고를 철회했다. CircleCI 전체 로그에서 63개 스위트·
958개 테스트 통과 후 `reset-library.test.tsx`의 늦은 동기화가 Jest 환경
종료 뒤 `Platform.OS`를 읽으며 ReferenceError를 발생시킨 것을 확인했다.
SVG 캡처 회귀는 자동 동기화의 durable 오류와 완료를 기다리고, 초기
동기화도 큐 편집 여부와 관계없이 완료를 기다리도록 수정했다. 이 reset
회귀에서는 별도 열린 작업 진단으로 확인한 Sentry SDK의 반복 타이머를
불러오지 않도록 관측 경계를 mock했다. 10개 회귀는 detectOpenHandles
검사에서 열린 작업 없이 종료 코드 0으로 완료했다. 두 CI
제공자의 현재 커밋 상태를 함께 확인하기 전까지 병합하지 않는다.
