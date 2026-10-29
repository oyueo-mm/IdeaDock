# Cloudflare Pages 시험 배포 (장기 자동 로그인)

공식 운영 주소는 계속 **https://oyueo-mm.github.io/IdeaDock/** (GitHub Pages)입니다. 이 문서는 서버 세션 로그인을 시험할 별도 주소 **https://ideadock.pages.dev/IdeaDock/**(프로젝트 이름에 따라 다름)를 만드는 절차입니다. 무료 `pages.dev` 주소만 사용하며 유료 도메인은 필요하지 않습니다. 설계와 보안 검토는 [로그인 유지](AUTH.md#서버-세션-로그인-cloudflare-pages)에 있습니다.

## 구성

| 경로                                     | 내용                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/IdeaDock/`                             | GitHub Pages와 같은 정적 앱. `NEXT_PUBLIC_AUTH_MODE=server`로 빌드                           |
| `/api/auth/*`                            | Pages Functions(`functions/api/auth/[[route]].ts` → `server/auth/handler.ts`)                |
| D1 `ideadock-auth`                       | 계정별 암호화된 Refresh Token·Access Token 캐시, 해시된 세션 ID. 아이디어 데이터는 없음      |
| Secrets                                  | `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`(32바이트), `GOOGLE_CLIENT_ID`                 |
| `wrangler.toml`                          | `APP_ORIGIN`, D1 바인딩, 출력 폴더 `dist-cloudflare`                                         |
| `npm run build:cloudflare`               | `dist-cloudflare/IdeaDock/`(앱), `_routes.json`(함수는 `/api/*`만), `_redirects`, `_headers` |
| `.github/workflows/cloudflare-trial.yml` | 수동 실행 전용 배포. GitHub Pages workflow와 완전히 분리                                     |

`build:cloudflare`는 GitHub Pages용 `out/`을 `dist-cloudflare/`로 옮기므로 이 산출물이 GitHub Pages로 게시될 수 없습니다. CI는 마지막에 일반 `npm run build`로 공식 산출물을 다시 만듭니다.

## 1. Cloudflare 준비 (사용자 작업)

Cloudflare 계정과 Wrangler 로그인이 필요합니다. 아래 명령은 저장소 루트에서 실행합니다.

```powershell
npx.cmd wrangler login
npx.cmd wrangler pages project create ideadock --production-branch production
npx.cmd wrangler d1 create ideadock-auth
```

1. `d1 create`가 출력한 `database_id`를 `wrangler.toml`에 넣습니다.
2. 프로젝트 이름이 이미 사용 중이라 주소가 `https://<다른 이름>.pages.dev`가 되면 `wrangler.toml`의 `APP_ORIGIN`을 그 주소(경로 없이)로 바꿉니다.
3. 스키마를 적용합니다.

   ```powershell
   npx.cmd wrangler d1 migrations apply ideadock-auth --remote
   ```

4. 비밀 값을 등록합니다. 값은 프롬프트에 붙여넣고 저장소·문서·채팅에 남기지 않습니다.

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # TOKEN_ENCRYPTION_KEY 생성
   npx.cmd wrangler pages secret put TOKEN_ENCRYPTION_KEY --project-name ideadock
   npx.cmd wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name ideadock
   npx.cmd wrangler pages secret put GOOGLE_CLIENT_ID --project-name ideadock
   ```

   `GOOGLE_CLIENT_ID`는 공개 값이지만 저장소에 넣지 않으려고 같은 방식으로 등록합니다. **암호화 키를 바꾸거나 잃으면** 저장된 토큰을 풀 수 없어 모든 사용자가 한 번 다시 로그인합니다. Drive 데이터에는 영향이 없습니다.

## 2. Google Cloud 설정 (사용자 작업)

기존 Cloud 프로젝트와 **기존 OAuth 웹 클라이언트를 그대로** 사용합니다. 새 클라이언트를 만들지 않습니다. `drive.file`로 IdeaDock이 만든 파일 접근 권한은 같은 앱(클라이언트)에 묶여 있으므로 이것이 기존 Drive 데이터 호환의 조건입니다.

1. **API 및 서비스 → 사용자 인증 정보 → 기존 OAuth 2.0 클라이언트 ID**
   - 승인된 JavaScript 원본에 `https://ideadock.pages.dev` 추가 (기존 `https://oyueo-mm.github.io`, `http://localhost:3000`은 유지)
   - 승인된 리디렉션 URI에 `https://ideadock.pages.dev/api/auth/callback` 추가
   - 같은 화면의 **클라이언트 보안 비밀번호**를 위 `GOOGLE_CLIENT_SECRET`으로 등록. 기존 정적 사이트는 비밀번호를 쓰지 않으므로 영향이 없습니다. 비밀번호를 새로 발급(교체)하면 Cloudflare Secret도 함께 바꿉니다.
2. **OAuth 동의 화면 → 게시 상태**
   - **테스트** 상태에서는 Google이 Refresh Token을 **7일 후 만료**시킵니다. 이 경우 7일마다 `Google 다시 로그인`이 표시됩니다(데이터는 그대로).
   - 장기 로그인을 쓰려면 **프로덕션으로 게시**합니다. 사용 범위(`openid email profile drive.file`)는 Google이 민감하지 않은 범위로 분류하지만, 콘솔이 요구하는 브랜드 확인 절차가 있으면 따릅니다.
3. Drive API 사용 설정과 `drive.file` 범위는 그대로 둡니다.

## 3. 배포

로컬에서:

```powershell
npm.cmd run build:cloudflare
npx.cmd wrangler pages deploy dist-cloudflare --project-name ideadock --branch production
```

또는 GitHub **Actions → Deploy Cloudflare Pages trial → Run workflow**. 저장소에 `cloudflare-trial` Environment를 만들고 Secrets `CLOUDFLARE_API_TOKEN`(Pages 편집 권한만), `CLOUDFLARE_ACCOUNT_ID`를 넣어야 실행됩니다. 이 workflow는 GitHub Pages 배포·`github-pages` Environment를 건드리지 않습니다.

미리보기 브랜치 주소(`<branch>.ideadock.pages.dev`)는 `APP_ORIGIN`과 달라 로그인이 거부됩니다. 시험은 `production` 브랜치 주소로 합니다.

배포 후 확인:

```powershell
curl.exe -I https://ideadock.pages.dev/IdeaDock/                  # 200
curl.exe -s -X POST https://ideadock.pages.dev/api/auth/token     # {"reason":"csrf"}
```

## 4. 기존 데이터 이전 절차

새 주소는 다른 원본이라 브라우저의 IndexedDB·localStorage가 **자동으로 옮겨지지 않습니다.** 두 종류의 데이터를 구분합니다.

| 데이터                                         | 위치                       | 새 주소에서                                                 |
| ---------------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| 동기화된 아이디어·폴더·이미지·리비전           | 사용자 Google Drive        | 같은 Google 계정으로 로그인하면 그대로 보임(복사 불필요)    |
| 미저장 초안(`Drive에 저장되지 않은 변경 사항`) | 기존 주소의 기기 IndexedDB | 보이지 않음. 기존 주소에서 먼저 동기화하거나 백업 필요      |
| 체험 모드 데이터                               | 기존 주소의 localStorage   | 보이지 않음. 기존 주소에서 JSON 백업 → 새 주소에서 가져오기 |

권장 순서(기기마다):

1. 기존 GitHub Pages 주소에서 **Drive 다시 연결** 후 상단의 `Drive에 저장되지 않은 변경 사항` 알림이 사라질 때까지 기다립니다.
2. 같은 화면에서 **데이터 관리 → JSON 백업**으로 백업 파일을 받아 둡니다(이미지 포함, 원본 보존).
3. 새 주소에서 같은 Google 계정으로 로그인하고 아이디어·폴더·이미지 수와 최근 수정 내용을 기존 주소와 비교합니다.
4. 1단계에서 동기화할 수 없던 초안이나 체험 데이터만 새 주소의 **JSON 가져오기**로 복원합니다. 가져오기는 미리보기 후 실행되며 기존 Drive 데이터를 덮어쓰지 않습니다.
5. 기존 주소는 그대로 사용할 수 있습니다. 두 주소가 같은 Drive를 쓰며, 동시에 고친 아이디어는 기존 충돌 처리로 복사본이 보존됩니다.

자동 이전·삭제는 하지 않습니다. 공식 주소를 Cloudflare로 바꾸는 것은 실제 계정에서 아래 실기기 항목을 확인한 뒤 별도로 결정합니다.

## 5. 검증

### 자동 (모의 환경, CI 포함)

| 명령                       | 범위                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm test`                 | `tests/auth-server.test.ts`: 코드 흐름·PKCE·state·세션·갱신·동시 갱신·권한 취소·Testing 7일·CSRF·암호화 (24개) |
| `npm run test:e2e:server`  | 실제 핸들러 + node:sqlite(D1 대용) + 모의 Google·Drive로 브라우저 흐름 8개 × 데스크톱·모바일                   |
| `wrangler pages dev`(수동) | 실제 Workers 런타임·로컬 D1에서 라우팅·리디렉션·state 거부·세션 조회·CSRF 거부 확인                            |

시간 경과(1시간, 7일, 30일, 60일 미사용, 400일)는 서버 시계를 앞당겨 **모의**합니다. 실제 시간이 지나야 하는 검증은 아래 실기기 항목입니다.

### 실기기 확인 항목 (실제 계정·실제 시간)

배포한 시험 주소에서 확인하고 [검증 기록](VALIDATION.md)에 결과를 남깁니다.

- [ ] PC Chrome: 첫 로그인 → 기존 아이디어·폴더·이미지 수가 GitHub Pages와 같음
- [ ] PC Chrome: F5, 브라우저 완전 종료 후 재실행에서 로그인 화면·팝업 없이 열림
- [ ] PC Chrome: 1시간 이상 열어 둔 뒤 편집 → 재로그인 없이 Drive 저장
- [ ] PC Chrome: 7일·30일 뒤 재접속 시 자동 로그인 (프로덕션 게시 상태에서)
- [ ] Android 삼성 인터넷: 시험 주소를 **홈 화면에 추가/설치** → PWA 실행 시 로그인 유지
- [ ] 삼성 인터넷 PWA: 로그인 버튼이 PWA 창 안(또는 Custom Tab)에서 Google 화면을 열고 앱으로 돌아오는지
- [ ] 삼성 인터넷 PWA: 앱 종료(최근 앱에서 제거) 후 재실행, 휴대폰 재부팅 후 재실행 시 자동 로그인
- [ ] 삼성 인터넷: "인터넷 사용 기록 삭제 → 쿠키" 후에는 다시 로그인 요구, 기기 초안은 유지
- [ ] 삼성 인터넷 비밀 모드: 창을 닫으면 세션이 사라지는 것이 정상
- [ ] 비행기 모드에서 편집 → 해제 후 자동 동기화, `Google 다시 로그인`이 뜨지 않음
- [ ] Google 계정 → 보안 → 서드파티 액세스에서 IdeaDock 권한 삭제 → 다음 편집 시 `Google 다시 로그인`, 초안 보존
- [ ] 설정 → 로그아웃 후 재실행 시 로그인 화면, 다른 기기는 계속 로그인
- [ ] 설정 → 모든 기기에서 로그아웃 → 다른 기기도 다음 실행에서 로그인 요구
- [ ] 두 번째 Google 계정으로 전환 → 첫 계정의 아이디어가 보이지 않음
- [ ] OAuth 동의 화면이 Testing일 때 7일 뒤 `Google 다시 로그인` (프로덕션 전환 전 확인용)
