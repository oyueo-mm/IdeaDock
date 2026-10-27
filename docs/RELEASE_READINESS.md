# Drive 전환 릴리스 준비

> 이 문서는 GitHub Pages 전환 이전의 검증·Vercel 중단 이력입니다. 현재 공식 배포와 main 릴리스 정책은 [Pages 안내](PAGES.md)를 따릅니다. 아래 Vercel 설정 및 제한은 현재 실행 절차가 아닙니다.

기능 브랜치: `feat/drive-safe-migration`. main 병합과 Production 배포는 이번 작업 범위가 아닙니다.

## 인증 UX 검토

현재 구현은 Google Identity Services의 token model입니다. `drive.file` 액세스 토큰은 모듈 메모리에만 두고 localStorage·IndexedDB·sessionStorage·쿠키에 기록하지 않습니다. Refresh Token을 요청하거나 보관하지 않습니다. 새로고침하면 메모리 세션이 없어지므로 기존 로그인 버튼을 다시 눌러 인증해야 합니다. Google에 이미 로그인하고 권한을 승인한 계정은 재인증 과정이 줄어들 수 있지만 팝업과 사용자 동작 없이 항상 갱신된다고 보장할 수 없습니다. [Google token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)

| 방식                                           | 장점                                                                                                | 비용·제약                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 현재 브라우저 token model 유지                 | 별도 토큰 서버·DB 없음, 장기 토큰이 앱 브라우저 저장소에 남지 않음, 현행 UI·구조 유지               | 새로고침 및 만료 후 재인증, 인증 전 완전한 오프라인 기동 불가                                                  |
| 메모리의 기존 계정 힌트와 재인증 프롬프트 조정 | 같은 페이지에서 다시 연결할 때 계정 선택 단계를 줄일 여지, 영구 토큰 저장 불필요                    | 새로고침으로 힌트도 없어짐. Google 세션·팝업 정책에 의존하므로 장기 세션 대안은 아님                           |
| Authorization Code + 서버 세션                 | 브라우저에는 불투명 세션 ID만 HttpOnly/Secure 쿠키로 두고 서버에서 토큰 갱신 가능. 새로고침 UX 개선 | OAuth callback·CSRF/state·세션 만료/폐기·Drive 프록시가 필요. 서버 토큰 암호화 저장소 및 갱신 동시성 관리 필요 |

장기 세션을 선택한다면 별도 상시 서버 대신 Vercel의 Next.js 서버 함수로 구현할 수는 있습니다. 다만 서버 함수의 메모리는 지속 저장소가 아니므로 세션과 암호화된 Refresh Token을 보관할 DB/KV, 암호화 키 관리, 운영 모니터링은 별도로 필요합니다. Google Client Secret과 토큰은 서버 전용 환경변수/암호화 저장소에만 두어야 합니다. 브라우저 쿠키에는 토큰 자체가 아니라 임의 세션 식별자만 넣습니다. 세션 쿠키를 쓴다는 이유로 CSRF 방어가 없어지는 것은 아닙니다. [Google code model](https://developers.google.com/identity/oauth2/web/guides/use-code-model)

이번 변경에서는 신규 인증 서버나 장기 세션 기능을 추가하지 않습니다. 현행 로그인 UI와 토큰 메모리 보관을 유지합니다. 장기 세션은 별도 설계·보안 검토가 필요한 후속 결정입니다.

## 이전 대상과 승인 경계

- 두 검증 세션의 체험 localStorage 데이터는 0개이며 사전 백업을 만들었습니다. 다른 브라우저 프로필의 존재 여부를 이 결과만으로 추정하지 않습니다.
- 사용자가 제공한 로컬 URL의 아이디어는 이미 Drive에 존재하며 독립된 두 번째 세션에서도 조회됐습니다. 해당 항목을 체험 데이터로 다시 이전하지 않습니다.
- 현재 Drive 데이터는 이미지 바이트를 포함해 `.local/release-drive-backup.json`에 복구 백업했습니다. 이미지 SHA-256을 확인했습니다. 이 파일은 Git과 Vercel 업로드에서 제외됩니다.
- 확인된 체험 이전 대상은 0개입니다. 실제 체험 데이터가 별도 프로필에서 발견되면 해당 브라우저에서 기존 JSON 백업을 만들고, 기존 미리보기·중복 ID 검사·명시적 이전 승인·서버 문서/이미지 재검증 절차를 사용합니다.
- 사용자 승인 전 체험 데이터를 업로드·삭제하지 않습니다. 이번 작업에서 실제 체험 이전은 실행하지 않았습니다. Supabase는 실제 미연결이라는 사용자 확인에 따라 생략합니다.

## 실제 두 세션 검증

두 세션은 동일 Google 계정을 사용하는 서로 다른 브라우저 컨텍스트입니다. 앱의 액세스 토큰과 IndexedDB는 각각 분리되며, 실제 Google Drive API를 사용합니다. Google 인증 쿠키는 같은 계정 인증을 위해 메모리에서만 전달했고 채팅·로그·Git에 기록하지 않았습니다.

검증 중 생성한 전용 테스트 아이디어 외의 기존 아이디어는 수정하거나 삭제하지 않습니다. 실제 계정은 하나뿐이므로 다른 실제 Google 계정과의 격리는 미실행입니다. 모의 테스트의 계정 전환 보호 검사를 실제 다계정 검증으로 집계하지 않습니다.

실제 실행 결과는 [검증 기록](VALIDATION.md)에 기록합니다. 다음 항목은 PC·휴대폰 실기기에서 별도로 확인해야 합니다.

1. 같은 HTTPS Preview에서 PC 작성 → 휴대폰 로그인·조회·수정 → PC 반영.
2. 모바일 Google 팝업·계정 선택·권한 동의, 브라우저 팝업 차단 및 Safari/WebKit 동작.
3. 휴대폰 카메라/사진 선택, 이미지 붙여넣기, 화면 회전과 키보드, 확대·삭제·복원.
4. 백그라운드·절전 후 복귀, Wi-Fi/모바일 데이터 전환, 실제 장시간 오프라인, 토큰 만료 후 재연결.
5. 실제 두 Google 테스트 계정의 목록·이미지·초안 분리와 로그아웃 후 화면 비우기.

## Preview 배포 경계

Vercel의 `oyueo/ideadock` 전용 프로젝트를 만들고 이 작업 폴더를 연결했습니다. OAuth 공개 설정은 **Preview 환경에만** 등록했습니다. Client Secret·Google 토큰·테스트 계정 비밀번호를 등록하지 않았습니다.

`vercel.json`으로 Next.js 프레임워크와 빌드·설치 명령을 명시했습니다. `.vercelignore`는 `.env*`, `.local/`, 브라우저 프로필, 복구 백업, `.git/`, 로컬 빌드 및 테스트 산출물을 제외합니다. CLI dry-run에서 이 파일들이 업로드되지 않음을 확인했습니다. [Vercel Preview 환경](https://vercel.com/docs/deployments/environments)

### GitHub 결과

앱 변경과 최초 검증 문서는 `e251e3094ca42788f2debf405522646d445535e2`로 커밋하고 [동일 이름의 기능 브랜치](https://github.com/oyueo-mm/IdeaDock/tree/feat/drive-safe-migration)에 일반 푸시했습니다. main은 `429b6c3`으로 유지합니다. 이어서 Preview 보호 장치와 최종 결과 문서를 같은 기능 브랜치에 추가합니다. 원격 CI 결과는 실행 링크에서 확인하며 로컬 통과 결과와 구분합니다.

### Preview 차단과 복구

`vercel deploy --target preview --scope oyueo --yes --json`으로 명시적 Preview를 요청했지만, 서버 결과와 `vercel inspect`에서 **target=production**이 확인됐습니다. 요청한 배포 경계와 달랐으므로 생성된 배포 `dpl_4gZ5vuEzvT7D6nqt2iUnfCtG9r5i` 하나를 즉시 삭제했습니다. 삭제 성공 및 `vercel list ideadock`의 활성 배포 0개를 확인했습니다. main·기존 다른 Vercel 프로젝트·Google Drive 데이터는 변경하지 않았습니다.

Vercel 공식 저장소에도 새 프로젝트 첫 배포가 CLI·REST·비프로덕션 Git 브랜치에서 Production으로 분류되는 보고가 있습니다. 재시도나 Production 부트스트랩은 수행하지 않습니다. 현재 **사용 가능한 Preview URL은 없으며, Google 승인 JavaScript 원본에 새로 추가할 정확한 Preview 주소도 아직 확정할 수 없습니다.** 삭제된 배포 URL이나 Production 별칭을 Preview 원본으로 추가하지 마세요. [Vercel의 동일 문제 보고](https://github.com/vercel/vercel/issues/17069)

`scripts/preview-guard.mjs`를 빌드 앞에 추가했습니다. `VERCEL_ENV=production` 또는 Vercel에서 환경이 불명확한 경우 Next 빌드 전에 실패합니다. 명시적 Preview와 로컬 빌드는 허용합니다. 장래 Production 배포는 별도의 승인 및 이 보호 정책 재검토가 필요합니다. 현재 최종 로컬 검증은 **52개 단위·회귀 테스트, 타입 검사, 빌드, 기본 브라우저 16개 및 모의 Drive 브라우저 4개 통과**입니다. 보호 장치는 별도 단위 테스트로 검사했으며 플랫폼의 잘못된 Production 생성 여부를 시험하기 위한 추가 배포는 하지 않았습니다.

Vercel이 Production 부트스트랩 없이 첫 Preview를 생성할 수 있는 지원 경로를 제공한 뒤 주소를 확정해야 합니다. 이후 Google Cloud OAuth 웹 클라이언트의 **승인된 JavaScript 원본**에는 실제 `https://호스트명`만 추가합니다. 경로·`/#idea=...`·와일드카드를 넣지 않습니다. 현재 token model은 Supabase callback을 사용하지 않습니다. 승인 원본 추가 전에는 Preview의 실제 Google 로그인을 성공으로 기록하지 않습니다. [Vercel 생성 URL](https://vercel.com/docs/deployments/generated-urls)
