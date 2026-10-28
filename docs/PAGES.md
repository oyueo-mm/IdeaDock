# GitHub Pages 배포

공식 주소: **https://oyueo-mm.github.io/IdeaDock/**

이 문서가 현재 배포 기준입니다. 과거 Vercel 기록은 이력으로만 보존하며 Vercel 배포 설정·명령·전용 보호 스크립트는 제거했습니다. 전역 CLI나 다른 Vercel 프로젝트는 변경하지 않습니다. Supabase 의존성은 기존 데이터 조사·복구를 위해 유지합니다. Google Drive 데이터·이미지·백업은 삭제하거나 초기화하지 않습니다.

## 정적 실행 구조

`next.config.ts`는 `output: 'export'`, `basePath: '/IdeaDock'`, `trailingSlash: true`, `images.unoptimized: true`를 사용합니다. `next build`가 `out/`에 HTML·JS·CSS를 생성합니다. Next가 basePath를 정적 JS/CSS에 반영하므로 별도 CDN용 assetPrefix는 필요하지 않습니다. 빌드 뒤 HTML의 Next 리소스 주소가 `/IdeaDock/_next/` 아래에 있고 실제 파일도 존재하는지 검사합니다. `.nojekyll`도 포함합니다.

정적 호스팅에서 실행할 수 없는 `headers()`는 제거했습니다. GitHub Pages에 같은 Next 서버 보안 헤더가 적용된다고 주장하지 않습니다. 기존 이미지는 Drive에서 받아 브라우저 blob URL로 표시하므로 이미지 최적화 서버가 필요 없습니다. Google OAuth와 Drive API는 브라우저에서 직접 호출하고 토큰은 메모리에만 보관합니다. 앱 API 서버·Client Secret·Refresh Token 저장소는 추가하지 않습니다.

아이디어 주소는 `/IdeaDock/#idea=...`이며 fragment는 서버 라우팅을 요구하지 않습니다. 뒤로 가기와 닫기는 pathname을 유지합니다. localStorage/IndexedDB는 origin별로 분리되므로 localhost 체험 데이터가 Pages에 자동 복사되지 않습니다. 같은 계정으로 로그인하면 기존 Drive 데이터는 조회됩니다. 체험 데이터는 기존 환경에서 백업한 후 승인된 가져오기 절차를 사용합니다.

## 로컬 검증

Node.js 24에서:

```powershell
npm.cmd ci
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run test:e2e:drive
# 모의 OAuth 빌드가 남지 않게 실제 환경으로 다시 만듭니다.
npm.cmd run build
npm.cmd start -- --hostname localhost --port 3000
```

개발 서버와 정적 서버를 같은 포트에 동시에 실행하지 않습니다. 위 정적 서버와 `npm run dev` 모두 `http://localhost:3000/IdeaDock/`을 사용합니다. 자동 브라우저 검사는 기본 4173/4174 포트의 정적 서버를 사용하며, 다른 프로젝트가 사용 중이면 `IDEADOCK_E2E_PORT`로 전용 포트를 지정할 수 있습니다.

v0.2는 기존 회귀를 유지하고 폴더·Word·v1/v2 백업·계정 격리·폴더 저장 선행 검사를 추가하여 단위·회귀 80개입니다. 기본 브라우저 29개와 모의 Drive 12개를 별도로 실행합니다. 마우스 전용 2개는 모바일에서, 터치 전용 1개는 데스크톱에서 의도적으로 제외합니다. 로그인 전·후 빈 상태, 패널 너비, 폴더 선택·드래그·복원, Word 미리보기·재시도, 이미지 썸네일과 저장 실패·충돌을 검증합니다. 모의 OAuth Client ID가 공개 릴리스에 포함되지 않도록 검사합니다. 자세한 호환성·제약은 [v0.2 안내](V02.md)를 확인하세요.

## GitHub Settings

관리자 API로 다음을 설정했습니다. 별도 비밀 정보를 전달할 필요는 없습니다.

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables**의 `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. 실제 로컬 연결에 사용한 공개 Client ID를 등록했습니다. 값은 문서·커밋·로그에 출력하지 않습니다. 이 식별자는 공개 브라우저 번들에 포함되며 Client Secret이 아닙니다.
3. `NEXT_PUBLIC_STORAGE_BACKEND=drive`, `NEXT_PUBLIC_GOOGLE_DRIVE_SPACE=drive`는 workflow에 고정합니다. Client Secret·Google 액세스 토큰·Refresh Token을 Actions Variables/Secrets나 저장소에 넣지 않습니다. 배포용 `GITHUB_TOKEN`과 OIDC는 GitHub가 제공하는 단기 CI 권한이며 앱에 포함되지 않습니다.
4. `github-pages` Environment에 별도 보호 규칙을 추가하면 main 배포를 허용합니다. 수동 승인 규칙이 있으면 사용자의 승인이 있어야 게시됩니다.

권한 변경으로 설정이 초기화되면 위 메뉴에서 동일하게 설정하면 됩니다. 커스텀 도메인은 사용하지 않습니다.

## 기능 브랜치와 공식 릴리스

저장소의 Pages 사이트는 하나이므로 테스트가 공식 사이트를 덮어쓰지 않도록 분리합니다.

- **기능 브랜치·PR:** `IdeaDock CI`가 타입·단위·정적 빌드·브라우저 검사를 실행하고 `static-site` artifact를 보관합니다. 공개 Pages 배포는 하지 않습니다.
- **main:** 같은 검사를 실행하고 모의 테스트 후 실제 Actions Variable로 다시 빌드한 정적 artifact를 올립니다.
- **게시:** `Deploy GitHub Pages`가 성공한 main push CI만 받습니다. 저장소·workflow 경로·현재 원격 main SHA·CI 성공을 확인해 오래된 산출물이나 다른 브랜치를 배포하지 않습니다. artifact의 실제 OAuth 설정도 재검사한 뒤 공식 Pages Actions로 게시합니다.
- **재시도:** `Deploy GitHub Pages → Run workflow`에서 main과 현재 main의 성공한 CI run ID를 입력합니다. 동일한 SHA 검사와 게시 경계를 적용합니다.

main 병합 전 원격 상태와 기능 브랜치의 최신 CI를 확인합니다. 강제 푸시와 CI 우회 병합은 하지 않습니다. 기능 브랜치의 산출물은 로컬에서 확인하며 공식 Pages 주소에 테스트 사이트를 게시하지 않습니다.

## Google Cloud 승인 원본

OAuth 웹 클라이언트의 **승인된 JavaScript 원본**:

```text
https://oyueo-mm.github.io
http://localhost:3000
```

`/IdeaDock/`, `/#idea=...`, 와일드카드는 넣지 않습니다. 사용자가 공개 원본 추가를 완료했다고 확인했습니다. GIS token model에는 앱 서버 callback이나 Client Secret이 필요하지 않습니다. 기존 Cloud 프로젝트·OAuth 클라이언트·Drive API·`drive.file` 권한을 유지하여 기존 폴더와 데이터의 접근 관계를 보존합니다.

## 공개 검증

공개 호스트의 HTTP·JS/CSS, 실제 로그인·기존 아이디어 조회·새 테스트 저장·수정·이미지 업로드·재조회·두 독립 세션의 동기화를 확인합니다. 실제 물리적인 PC·휴대폰, Safari/WebKit, 두 번째 Google 계정, 장시간 절전·오프라인은 별도 실기기 항목입니다. [검증 기록](VALIDATION.md)에 실행 여부를 구분합니다.

공식 문서: [Next.js Static Export](https://nextjs.org/docs/app/guides/static-exports), [GitHub Pages Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
