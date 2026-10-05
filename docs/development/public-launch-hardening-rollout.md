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

| 항목 | 현재 상태 | 다음 적용 조건 |
| --- | --- | --- |
| 이미지 비공개 | 서명 클라이언트 및 deferred SQL 준비 | 호환 클라이언트 배포와 실기기/Storage HTTP 확인 후 버킷 전환 |
| CAPTCHA | 익명 signup body에는 token 없음 | 공급자 사이트 설정·도전 UI·token 전달·실패 시 로컬 저장 유지 검증 후 Auth에서 활성화 |
| REST/Storage 총량 | 개별 RLS/객체 15MiB만으로 총량은 막지 못함 | 계정별/프로젝트별 저장 예산과 bulk 정책 결정 후 원본 경로에서 동시성 포함 강제 |
| 미리보기 내부망 | literal URL와 manual redirect 방어 구현 | 클라이언트 배포·실기기 확인·DNS/이미지 transport 격리 |
| 화폐 예산 | AI 호출 60/시간·1000/24시간 | 공급자 프로젝트 billing cap/alert와 운영 kill switch 연결 |

CAPTCHA를 지금 켜면 token 없이 로그인하는 현재 클라이언트가 실패할 수 있다. 클라이언트 제한만 추가해도 Supabase 원본 API로 우회할 수 있으므로 총량 방어 완료로 표시하지 않는다. 이미 저장된 데이터를 제거하거나 임의의 quota 값을 운영에 적용하지 않았다.
