# Keepory 공개 전 공격 분류와 방어 계획

2026-10-05 · 코드 기준 `3bf8c5f` · 상태: 정적 검토와 대응 설계 완료, 구현·운영 검증 전

## 구현 진행 상태

2026-10-05 후속 작업: F01/F05 운영 정책·권한과 F04 공개 버킷을 읽기 전용으로 확인했다. `security/public-launch-hardening` 브랜치에 API 권한, webhook 인증, 사용자/전역 AI quota, 큐 claim, 비공개 이미지 클라이언트와 마이그레이션을 구현하고 로컬 테스트를 통과했다. **운영 적용은 자동 승인 검토에서 거부돼 아직 실행하지 않았다.** [구현 내역·검증·적용 순서](../development/public-launch-hardening-rollout.md)를 기준으로 이어간다.

## 결론과 범위

현재 근거만으로 대중 공개 준비가 완료됐다고 판정할 수 없다. 아래 P0 항목을 해결하거나 해당 기능을 서버에서 차단한 뒤 공개한다. 운영 침해를 발견했다는 뜻은 아니다. 코드에서 확인한 위험과 운영 설정 미확인을 구분한다.

모든 공격을 미리 열거하거나 완전한 방어를 보장할 수는 없다. 공격자·진입점·신뢰 경계·피해를 기준으로 24개 주요 공격군을 분류하고, 변경마다 갱신한다. 앱·웹·DB·Storage·AI·관측 도구·CI·운영 계정을 포함한다. 결제·공개 공유·협업은 제공 전에 별도 모델을 추가한다.

이번 작업은 로컬 코드·마이그레이션 검토와 기존 테스트 실행이다. 운영 DB 권한·함수 버전·비밀키 설정·CAPTCHA·WAF·백업·응답 헤더는 확인하지 않았다. 운영 데이터 조회·공격 재현·부하 시험·배포 변경은 수행하지 않았다. 이 문서의 대책은 아직 적용 완료가 아니다.

## 보호 대상과 신뢰 경계

- 보호 대상: 개인 북마크·노트·이미지·폴더, 계정·세션·API 키, 미동기화 자료, 가용성, AI/DB/Storage/로그 비용, 배포 권한.
- 공격자: 미로그인 봇, 익명·다계정 사용자, 정상 가입 후 악용하는 사용자, 탈취 세션 소유자, 악성 콘텐츠 제공자, 공급망·운영 계정 공격자.
- 경로: 웹/네이티브 → Supabase Auth → 직접 PostgREST/RPC·Storage·Realtime. 별도 Edge Functions → service role DB·Gemini·Sentry·Expo Push.
- Cloudflare는 정적 웹 호스팅이다. 웹 도메인 WAF가 Supabase 원본 요청을 모두 보호한다고 가정하면 안 된다.
- UI·개발자 모드·클라이언트 버전 검사·클라이언트 quota는 권한 통제가 아니다. service role 경로는 RLS에 의존하지 말고 객체 소유권을 직접 검사해야 한다.
- URL 메타데이터 수집은 검토한 `apps/mobile/src/domain/page-metadata.ts`에서 클라이언트가 수행한다. 현재 확인된 것은 단말 내부망 접근·추적 위험이며 서버의 임의 URL fetch 취약점이 입증된 것은 아니다.

## 우선 발견사항

P0 = 공개 전 해결 또는 영향 기능 서버 차단. P1 = 공개 전 검증, 미충족이면 영향 기능 제한. P2 = 지속 개선. CVSS 점수가 아닌 출시 우선순위다.

| ID | 우선순위·근거 | 위험과 대책 | 완료 조건 |
| --- | --- | --- | --- |
| F01 | P0 · `20260622075624_api_keys.sql`, `api-keys/issuance.ts`, `public-api/index.ts` | 자기 API 키 행에 `FOR ALL` 정책이 있다. DB DML 권한도 열려 있다면 발급 OFF를 우회해 키 해시를 직접 등록하거나 폐기를 취소할 수 있다. 클라이언트 INSERT/UPDATE 정책·권한 제거, 서버 발급/폐기만 허용, 공개 API 자체에도 기본 OFF 스위치 필요 | 익명·등록 사용자 직접 생성/해시 교체/폐기 취소 실패. API OFF에서는 기존 키도 거부. 운영 권한 재조회. 다른 사용자 키 생성이 가능하다는 주장은 아님 |
| F02 | P0 · `feedback-bridge/index.ts`, `config.toml` | 비밀키가 비어 있으면 인증 검사를 건너뛰며 gateway JWT 검사도 OFF다. DSN 설정 시 무인증 Sentry 전달·비용·알림 오염 가능. 비밀키 없으면 처리 중지, 크기/스키마/빈도 제한·보고서 중복 방지 | DSN ON/OFF × 비밀키 없음/오류/정상 시험. 무인증 외부 전송 0회. 운영 비밀키 누락 여부는 미확인 |
| F03 | P0 · `ai-enrich/index.ts:claimEnrichmentQuotaSlot`, `request-auth.ts` | 배치 quota RPC 오류·예외에서 `eligible: true`, `allowed` 누락도 허용. 동기 경로는 등록 사용자 제한기 장애 시 허용. 명시적 승인만 유료 호출, 사용자+전역 예산 예약·토큰/동시성/재시도 상한·kill switch 필요 | 오류·timeout·잘못된 응답에서 유료 호출 0회. AI는 보류해도 로컬 캡처는 성공. 동기/trigger/배치 모두 동일 게이트 |
| F04 | P0 · `20260819071500_bookmark_images_storage_bucket.sql` | `public=true`, 15 MiB/파일, SVG 포함, 사용자 ID 경로 쓰기 정책. 알려진 URL로 개인 스크린샷 읽기·익명 업로드/egress 악용 가능. 비공개 버킷+인증/짧은 서명 URL, 총량 제한·실내용 검증·재인코딩·SVG 기본 불허 제안 | 종전 공개 읽기 제품 결정을 재검토하고 기록. 기존 URL/객체/CDN 캐시 이전, 만료·offline 시험. 결정·대응 전 민감 이미지 업로드 제한 |
| F05 | P1 · `20260611000000_initial_schema.sql` | AI enrichment UPDATE 정책은 INSERT와 달리 `bookmark_id` 소유권 검사가 없다. 후속 정책 교체를 찾지 못했다. 연결 열 변경 금지 또는 소유권 검사 보강 | A의 enrichment를 B의 북마크로 연결하는 UPDATE/UPSERT 거부. 운영 재현 전이며 읽기 유출을 입증한 것은 아님 |
| F06 | P1 · `public-api/index.ts` | service role을 쓰며 키별 rate limit·scope·만료 검사가 없다. JSON·태그 배열 상한 필요. UUID/필터 및 일부 소유권 검사는 존재 | 재개 전 읽기/쓰기/삭제 scope, 만료·폐기, 키+사용자+전역 제한, 필드/본문/페이지 상한과 deadline |
| F07 | P1 · `20260723150000_pending_ai_enrichment_queue.sql` | claim SQL의 선택 단계에 SKIP LOCKED, UPDATE 단계에 현재 상태 재검사가 보이지 않는다. 동시 트랜잭션 중복 claim 여부 검증 필요 | 동시 worker 시험, 원자적 lease·token·완료 조건·유료 호출 중복 억제. 분산 장애에서 무조건 정확히 한 번 실행을 보장한다고 설명하지 않음 |

존재하는 방어: 주요 테이블 소유자 RLS·관계 검사, 관리용 뷰 권한 회수, 사용량 원장 클라이언트 INSERT 제거, quota advisory lock, 서버 호출 비밀키 분기, API UUID/필터 검사, 네이티브 SecureStore, 메타데이터 크기·시간 제한. 운영 적용 여부는 별도 검증한다.

## 공격 분류와 대응

| 공격군 | Keepory에서의 피해 | 예방·완화 | 탐지·인수 시험 |
| --- | --- | --- | --- |
| 1. 계정 탈취·인증 우회 | OAuth callback 가로채기, 세션 재사용, 계정 연결 혼동 | PKCE·시작 요청/callback 결합·정확한 redirect allowlist, 민감 변경 재인증, 세션 폐기 | 잘못된 verifier·callback 재사용·계정 연결 시험, 로그인 이상 징후 |
| 2. 익명·다계정 봇 | 가입 반복으로 AI·업로드 한도 초기화 | 가입 CAPTCHA 서버 검증, IP/계정/전역 제한, 신규 계정 유료 작업 제한 | 가입률 대비 비용, 대량 계정의 전역 예산 우회 시험. IP만으로 영구 차단하지 않음 |
| 3. BOLA/IDOR | 타인 북마크·폴더·이미지 접근 | 모든 객체와 연결 관계 소유권 검사, RLS+최소 GRANT | A/B/익명/무인증/만료 세션의 CRUD·UPSERT·관계·목록 행렬 |
| 4. 권한 상승·mass assignment | user_id·bookmark_id·queue 상태·키 폐기 상태 조작 | 허용 필드, 민감 열 쓰기 제한, RPC EXECUTE 최소화·고정 search_path | 직접 REST/RPC 변조. user_metadata를 권한 근거로 사용하지 않는지 확인 |
| 5. 세션·키 유출 | 브라우저 JS·번들·로그·진단 첨부에서 토큰 획득 | SecureStore 유지, 웹 XSS 차단, 키 해시·scope·만료·폐기, 로그 마스킹 | artifact/첨부 secret scan, 폐기 후 거부. 웹 localStorage는 JS 실행 침해에 취약 |
| 6. XSS·HTML/Markdown 주입 | 저장 콘텐츠·SVG에서 스크립트/피싱 UI 실행 | 원문 HTML 비활성, escape/sanitize, 링크 scheme 허용목록, CSP, opener 분리 | 저장→동기화→상세→export 악성 fixture |
| 7. CSRF·클릭재킹·CORS | 로그인/삭제 유도, iframe 속임수 | cookie 경로 CSRF 방어, callback 검증, frame-ancestors, 최소 CORS | bearer API의 wildcard CORS 자체를 인증 우회로 단정하지 않음. CORS는 봇 차단 수단이 아님 |
| 8. SQL·필터·명령 주입 | PostgREST 조건·로컬 SQL·운영 스크립트 변조 | 파라미터 SQL, UUID 검사, URLSearchParams, 사용자 입력 shell 실행 금지 | 특수문자·인코딩·중첩 필터에서도 소유권 조건 유지 |
| 9. URL 내부망 접근·SSRF | 자동 preview가 단말 내부 주소 접근, 미래 서버 fetch는 내부망 유출 | scheme/주소/포트 제한·redirect마다 재검증. 서버 도입 시 DNS·연결 대상까지 통제하는 egress 계층 | IPv4/IPv6·DNS rebinding·redirect·대체 IP 표기 시험. 문자열 차단만으로 충분하지 않음 |
| 10. URL 추적·피싱 | 외부 이미지/preview가 IP·열람 시점·referrer 수집 | 자동 로딩 제어, referrer 최소화, URL query/fragment 로그 제외, 대상 명확한 외부 열기 | 실제 요청·헤더 확인. 프록시 도입 시 자체 SSRF/비용 통제 추가 |
| 11. 악성 파일·가져오기 | MIME 위장·SVG·거대 이미지/HTML/JSON으로 메모리·CPU 고갈 | 실제 형식·크기·픽셀·개수·중첩 제한, 재인코딩, chunk/cancel | 압축 크기 대비 과대 디코딩, 잘못된 인코딩, 중단 후 DB 정상성 |
| 12. Storage 악용 | 스크린샷 유출, 불법 호스팅, 핫링크 비용 | F04, 계정 총량·전송량 통제, 신고/삭제 정책 | 무인증 URL·타인 경로·upsert, 업로드/egress 급증 |
| 13. DDoS·애플리케이션 DoS | Auth·REST·검색·DB 연결·Realtime 고갈 | 관리형 DDoS 방어, 경로별 제한, query timeout·페이지/배열 상한·인덱스·동시성 제한 | Supabase 원본 직접 호출, p95·DB 연결·429/5xx·queue age |
| 14. 비용 소진 | AI·Storage·로그·이메일 비용 증폭 | 사용자+전역 원자적 예산 예약·hard stop, 원가별 상한, 공급자 제한 | 공급자 비용과 원장 대조, 50/80% 경보·상한 전 차단. 알림은 차단이 아님 |
| 15. 프롬프트 주입 | 악성 제목/본문이 분류·폴더 제안 오염 | 외부 텍스트 비신뢰 분리, 입력 길이·결과 schema·허용 ID 검증, 모델 비밀/도구 권한 금지 | 다국어/난독화 지시에도 권한·사용자 원문 변경 불가 |
| 16. AI 정보 노출 | 노트·URL·폴더명이 공급자/로그에 전달 | 전송 최소화·사용자 제어·보존 설정 확인·계정별 context 격리 | gemini-provider는 user notes도 입력에 포함. 실제 전송 필드와 제품 안내 일치 확인 |
| 17. replay·경쟁·큐 오염 | 중복 청구·상태 조작·오래된 결과 덮어쓰기 | idempotency·lease·서버 소유 상태, 원자적 quota, generation 비교, 제한된 retry+jitter | 동시 worker·중복 webhook·응답 유실·삭제 후 늦은 완료 |
| 18. 동기화·계정 경계 | A→B 캐시 노출, reset/pull 경합 자료 손실 | 계정별 캐시 경계·만료 시 숨김·tombstone·복구 | A→B·익명→실계정·offline·재시작·reset 경합. 미동기화 캡처 보존 |
| 19. 모바일·기기 공격 | 악성 share intent/deep link, 분실·백업 데이터 유출 | URI/MIME 검증, 최소 권한, 안전한 서명·업데이트, 로컬 암호화/백업 정책 | 실제 기기 release 빌드·공유·백업·로그 시험. 루팅 탐지에 서버 보안을 의존하지 않음 |
| 20. 관측·피드백·알림 악용 | 이벤트 폭탄, 비밀 첨부, 위조 보고서·AI triage 지시 주입 | 서버 마스킹·크기/빈도 제한, 비신뢰 표시, 지원 도구 권한 분리 | Sentry→GitHub·push까지 검사, 토큰/원문 노출과 전송량 |
| 21. 공급망·CI 탈취 | 악성 패키지/Action·PR secret 유출·오염 APK/OTA | lockfile·취약점/secret scan·Action SHA pin, 최소 CI 권한, PR과 배포 secret 격리 | artifact/source commit 대조, SBOM 검토, 서명키·복구 배포 확인 |
| 22. 운영·DNS·공급자 | 운영자 피싱·도메인 탈취·유휴 preview·서비스 장애 | 운영 MFA·권한 회수·registrar lock·환경 분리·preview 관리, 장애 시 로컬 저장 유지 | 관리자 감사 로그·DNS 변경 감시·공급자 장애 주입 |
| 23. 삭제·복구·증거 파괴 | 대량 삭제·orphan 이미지·백업 미복구 | 민감 삭제 재인증·복구 옵션, 객체 수명주기, 분리된 백업·감사 기록 | 격리 환경 복원, 관계/이미지 일치, 영향 범위 추적 |
| 24. 제품·신뢰 악용 | 브랜드 사칭·피싱 링크·신고 스팸·향후 보상/결제 사기 | 신고·차단·보안 연락처, 외부 대상 표시, 새 기능 별도 모델 | 반복 악용 지표, security.txt·책임 있는 제보 처리 |

## 실행 순서와 출시 게이트

담당은 역할 제안이며 개인 배정 전이다. 아래 작업은 검토 가능한 구현 단위로 나눈 계획이다.

| 순서 | 담당·작업 | 통과 기준 |
| --- | --- | --- |
| 1 | 백엔드: API 키 DB 권한·API OFF | F01 우회 거부, 정상 목록/폐기 유지, 운영 migration·권한 재조회 |
| 2 | 백엔드: webhook 인증 필수화 | F02 조합 시험 통과, 무인증 외부 전송 0회, 정상 trigger 전달 |
| 3 | 백엔드/운영: 비용 게이트 | F03 전 경로 차단, 캡처 유지, 전역 kill switch 증거 |
| 4 | 제품/백엔드/클라이언트: 이미지 보호 | 접근 정책 결정, 기존 객체 이전·서명 갱신·offline 검증. 미완료면 영향 업로드 차단 |
| 5 | 백엔드: 권한·관계·queue | F05/F07 검증·수정, 아래 격리 행렬 통과 |
| 6 | 백엔드/운영: 요청·저장·큐 상한 | 직접 REST·bulk RPC·Storage까지 제한, 원자적 거부, 정상 캡처 보존 |
| 7 | 클라이언트/운영: 렌더·기기·관측·CI | XSS·세션·deep link·로그·서명·secret 시험, 미충족 P1 영향 기능 제한 |
| 8 | 운영: 출시 증거 | 배포 revision, 권한 snapshot, 테스트 결과, 차단/복구 연습, 사고 담당자 기록 |

한도 초안(현재 설정이 아니며 사용 패턴·비용 측정으로 조정):

- 익명 사용자는 로컬 캡처를 유지하고 클라우드 유료 작업은 기본 제한. AI 체험은 별도 작은 전역 예산으로 운용한다.
- 등록 사용자 AI 시작점: 20회/일, 동시 2개, 대기 100개. 기존 500회 수준 quota와의 제품 영향을 검토한다. bulk import 저장과 AI 처리를 분리한다.
- JSON API 256 KiB/요청과 별도 문자열·태그·폴더·batch 항목 상한. import는 제한된 chunk, 이미지는 별도 크기·픽셀·계정 총량 상한을 사용한다.
- 전역 일 예산 B를 정하고 호출 전 최대 예상 비용을 원자 예약한다. 잔여보다 큰 작업은 보류. 정산·예약 만료·refund·중복 차감 시험이 필요하다. 공급자 청구 지연을 감안해 B는 지불 가능한 금액보다 낮게 둔다.
- IP 제한은 보조 수단이다. 신뢰할 프록시가 설정한 헤더만 사용하고 이동통신 NAT의 정상 사용자 영향을 측정한다.

## 보안 인수 시험

격리 시험 프로젝트에서 synthetic 사용자 A/B, 익명 U, 무인증, 만료 세션, 폐기 키를 사용한다. service role은 fixture 준비에만 사용한다. 부하·파괴 시험은 운영에서 실행하지 않는다.

1. 실제 pg_policies, table/column grants, function EXECUTE, default privileges, exposed schemas, views, Storage·Realtime 정책을 수집한다. 파일 존재로 배포를 추정하지 않는다.
2. 각 자산의 SELECT/list/INSERT/UPDATE/DELETE/UPSERT/RPC에 타인 user/parent/tag/collection/bookmark ID를 조합한다. 권한 없는 행 노출·변경 모두 0. RLS의 200/빈 배열도 내용으로 판정한다.
3. 발급 OFF에서 직접 API 키 쓰기·해시 변경·폐기 취소·API 호출을 시험한다. DB와 함수 양쪽에서 거부돼야 한다.
4. 일반 사용자의 내부 quota/refund/claim/dispatch RPC·admin view 접근을 거부한다. 사용자용 SECURITY DEFINER RPC에는 소유권·입력량 시험을 적용한다.
5. 동기/trigger/배치 동시 호출, quota 500·timeout·잘못된 응답·공급자 429·중복 완료를 주입한다. 공급자 호출·예산 예약·청구·refund를 대조한다.
6. 알려진 타인 이미지 URL·목록·경로 변조·upsert·MIME 위장·SVG·과대 픽셀·총량 초과를 시험한다. 목표 비공개 정책에서 타인/무인증 읽기 0, 서명 만료 후 거부.
7. 악성 렌더/공유 fixture, 계정 전환·세션 만료·실제 기기 백업·deep link 시험을 수행한다.
8. 웹 외 Supabase 원본 REST/Auth/Functions/Storage/Realtime도 시험한다. preview의 운영 DB·OAuth 허용목록·관측 설정 공유 여부를 확인한다.
9. AI 중지→저장 지속→제한된 큐 재개, 백업 복원·키 회전·세션 폐기를 연습한다. 초기 복구 목표 제안은 RPO 24시간/RTO 4시간이며 실제 요구·측정으로 확정한다.

이번 실행 결과: `pnpm test:functions` Node runner 9개 파일 통과. 클라이언트 `oauth`, `secure-session-core`, `markdown`, `page-metadata`, `sentry-report` 5개 파일 통과. 기존 회귀 테스트 통과이며 F01~F07 재현이나 운영 RLS 안전성을 증명하지 않는다.

## 관측·사고 대응·지속 관리

- 수집: 가입률, endpoint별 요청량·p95·권한 거부·429/5xx, 사용자/전역 AI 비용, Storage 용량/egress, queue 수/최대 나이, 피드백·로그 전송량. 토큰·원문·전체 URL 대신 최소 식별자만 기록.
- 경보: 예산 50/80% 알림, 상한 전에 예약 거부. AI 제한기 실패·격리 실패·인증 우회 징후 즉시 대응. 공개 직후 정상 증가와 구분해 트래픽 기준 조정.
- 차단: AI·업로드·피드백·API 독립 kill switch. 가능한 한 로컬 저장·열람·안전한 동기화 유지. 앱 업데이트가 필요한 스위치를 비상 수단으로 삼지 않음.
- 사고 초기: 담당자 지정 → 영향 기능 차단 → 시간·revision·기록 보존 → 관련 키 회전/세션 폐기 → 영향 범위 확인. 로그·원장을 먼저 삭제하지 않음.
- 복구: 격리 환경 검증 → 최소 기능 재개 → 비용·접근 관찰 → 실제 범위와 적용 의무에 따른 사용자 통지 판단 → 재발 방지 테스트.
- 변경마다 보안 회귀, 매주 의존성/secret scan·비용 검토, 매월 권한/endpoint 재고, 분기별 복구 연습. 제보 연락처와 대응 담당자 유지.

## 근거와 참고

코드 경로는 `/home/stlim/keepory` 기준이다. 위에서 명시한 파일 외 `supabase/config.toml`, `supabase/functions/ai-enrich/gemini-provider.ts`, `apps/mobile/src/supabase/session-storage{,.native}.ts`, `wrangler.toml`, `.github/workflows/ci.yml`, `20260804191500_admin_dashboard_views.sql`, `20260716140000_ai_enrichment_calls_server_only.sql`, `20260807120000_bulk_attach_bookmark_tags_and_collections.sql`, `20261002140000_collection_management_rpcs.sql`을 검토했다.

2026-10-05 확인한 자료:

- [OWASP API Security Top 10](https://api-security.owasp.org/editions/2023/en/0x11-t10/): 객체 권한·자원 소비·업무 흐름·외부 API 신뢰 분류 참고.
- [Supabase API 보호](https://supabase.com/docs/guides/api/securing-your-api): grants와 RLS의 계층 구분, PostgREST 사전 검사는 Storage/Realtime에 자동 적용되지 않음.
- [Supabase 익명 로그인](https://supabase.com/docs/guides/auth/auth-anonymous): 익명 세션도 authenticated 역할 사용.
- [Supabase Storage buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals): public 읽기와 쓰기 접근 제어의 구분.
- [OWASP SSRF 방어](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html): URL·주소·redirect·DNS·네트워크 다층 통제.
- [OWASP 프롬프트 주입 방어](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html): 비신뢰 입력·권한 분리·출력 검증.

Supabase changelog markdown은 웹 도구의 content-type 오류로 읽지 못했다. 실제 구현 시 최신 변경 내역과 배포 버전을 다시 확인한다.


### 2026-10-05 운영 후속: AI 한도 RPC 권한

운영 점검에서 임의 user_id를 받는 `_ai_enrichment_slot`, `request_ai_enrichment_slot_for`, `refund_ai_enrichment_slot_for`의 클라이언트 실행 권한을 발견했다. 타인 quota 소진과 환불을 통한 사용자별 제한 우회 문제다. 정식 `20261005092956_ai_quota_rpc_access.sql` 적용으로 세 함수를 service_role 전용으로 제한했다. 로컬 취약점 재현·역할별 회귀 검사와 운영 임시 계정 HTTP 검사에서 클라이언트 403, 본인 한도 및 서버 예약·환불 정상 동작을 확인했다. 상세 증거와 남은 출시 항목은 [운영 적용 기록](../development/public-launch-hardening-rollout.md)에 있다.


### 2026-10-05 후속: 원본 REST의 북마크 개수 제한

계정별/프로젝트별 북마크 개수 제한과 private usage ledger를 운영에 **비활성 상태**로 적용했다. 기본 한도는 아직 선택하지 않았고 기존 행은 보존했다. PostgreSQL 17.10의 20개 독립 연결 경쟁 및 rollback 검증을 통과했다. 이 기능은 북마크 개수만 다루며 저장 파일 bytes, 다른 테이블, 가입률, egress 제한을 해결하지 않는다. 집계 비용·클라우드 quota UX·제품 한도를 검토한 뒤 활성화한다. [상세 운영 기록](../development/public-launch-hardening-rollout.md).
