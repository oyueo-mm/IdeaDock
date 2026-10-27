# 이전 Supabase 설정 참고

현재 Google Drive 및 GitHub Pages 설정은 [Pages 안내](PAGES.md)를 사용하세요. 아래는 레거시 데이터 조사·복구를 위한 참고 기록입니다.

현재 Supabase/Vercel 프로젝트는 생성하거나 연결하지 않았습니다. 아래 과정은 사용자의 계정에서 실행해야 합니다. 다른 프로젝트의 데이터베이스를 재사용하지 마세요.

## 1. GitHub

대상 저장소: https://github.com/oyueo-mm/IdeaDock

로컬 파일을 검토한 뒤 PowerShell에서 실행합니다. `.env.local`과 `.vercel`, `node_modules`는 커밋 대상이 아닙니다.

```powershell
git status
git add .
git commit -m "Build IdeaDock v0.1"
git branch -M main
# origin이 없는 경우에만 실행
git remote add origin https://github.com/oyueo-mm/IdeaDock.git
git push -u origin main
```

이미 origin이 있으면 `git remote -v`로 위 주소인지 확인하세요. 원격 변경이 생겼다면 먼저 fetch 후 검토하세요. 강제 push는 사용하지 않습니다.

## 2. 전용 Supabase 프로젝트 생성

1. https://supabase.com/dashboard 에 로그인하고 **New project**를 선택합니다.
2. 프로젝트 이름은 `IdeaDock`, 리전은 사용 위치와 가까운 곳을 선택합니다. DB 비밀번호는 비밀번호 관리자에 보관합니다.
3. 프로젝트가 준비되면 Project Settings → API 또는 Connect에서 **Project URL**과 **publishable key / legacy anon key**를 확인합니다.
4. `.env.example`을 `.env.local`로 복사하고 다음 두 값만 앱용으로 설정합니다.

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_IDEADOCK_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
```

이 두 값은 브라우저가 사용하는 공개 설정입니다. 데이터 보호는 RLS와 인증으로 수행합니다. `service_role`, secret key, DB 비밀번호, Google client secret은 `NEXT_PUBLIC_` 변수에 넣지 마세요. 이 앱에는 service role이 필요하지 않습니다.

새 프로젝트는 **publishable key**를 권장합니다. 코드의 `NEXT_PUBLIC_SUPABASE_ANON_KEY`는 기존 변수명을 유지하며 publishable key도 그대로 받을 수 있습니다. 실제 값은 `.env.local`과 Vercel 환경변수에만 입력하세요. `npm.cmd run preflight`는 값 자체를 출력하지 않고 Git 업로드 후보의 자격증명 패턴, 환경변수 이름 일치, 로컬 설정 유무·키 종류를 확인합니다. 패턴 검사는 모든 비밀정보를 탐지한다는 보장이 아닙니다.

5. SQL Editor에서 `supabase/migrations/202610270001_initial.sql` 전체를 **한 번** 실행합니다. CLI 방식과 SQL Editor 방식 중 하나만 선택하세요.
6. 테이블 5개, `idea_documents` 뷰, `list_ideas` / `save_idea` 함수, 비공개 `idea-images` 버킷이 생성됐는지 확인합니다.

CLI를 선호한다면 Node 24 환경에서:

```powershell
npx.cmd supabase init
npx.cmd supabase login
npx.cmd supabase link --project-ref YOUR_IDEADOCK_PROJECT_REF
npx.cmd supabase db push --dry-run
npx.cmd supabase db push
```

또는 준비된 스크립트를 실행합니다. CLI 로그인과 프로젝트 선택은 대화형으로 진행하며, 인증 값을 파일이나 명령 인자로 전달하지 않습니다.

```powershell
powershell -File scripts/cloud-setup.ps1 -Action LinkDatabase -ProjectRef YOUR_IDEADOCK_PROJECT_REF
powershell -File scripts/cloud-setup.ps1 -Action Migrate -ProjectRef YOUR_IDEADOCK_PROJECT_REF
```

`Migrate`는 연결된 프로젝트 ref가 명시한 ref와 같은지 검사합니다. 이 스크립트는 프로젝트를 자동 생성하거나 DB를 reset하지 않습니다. Supabase CLI의 `db reset --linked`는 사용하지 마세요.

## 3. Google 로그인

1. Google Cloud Console에서 IdeaDock용 OAuth 동의 화면과 **웹 애플리케이션** OAuth 클라이언트를 만듭니다. 테스트 게시 상태라면 로그인할 Google 계정을 테스트 사용자로 추가합니다.
2. 승인된 리디렉션 URI에 Supabase가 안내하는 `https://YOUR_IDEADOCK_PROJECT_REF.supabase.co/auth/v1/callback`을 등록합니다.
3. Supabase → Authentication → Sign In / Providers → Google에서 해당 Client ID와 Client Secret을 입력하고 활성화합니다. Secret은 Supabase 설정에만 저장합니다.
4. Authentication → URL Configuration에서 Site URL을 실제 앱 주소로 설정합니다. 개발 중에는 `http://localhost:3000`을 사용합니다.
5. Redirect URLs에 `http://localhost:3000`과 확정된 Vercel 배포 주소를 추가합니다. `127.0.0.1`로 접속한다면 해당 origin도 추가합니다. 임의의 모든 도메인을 허용하는 와일드카드는 사용하지 않습니다.
6. `.env.local`을 설정한 뒤 개발 서버를 재시작합니다. Google 로그인 → 제목 한 줄 작성 → 새 브라우저/기기에서 같은 계정으로 로그인 → 데이터 조회·편집을 확인합니다.

## 4. 공식 배포

공식 배포는 GitHub Pages입니다. [Pages 설정과 배포 절차](PAGES.md)를 따릅니다. 이 문서의 나머지는 보존한 레거시 Supabase 설정 참고용입니다.

## 5. 실제 RLS·Storage 통합 테스트

전용 프로젝트에 서로 다른 테스트 사용자 2개를 Authentication → Users에서 생성하고 이메일을 확인된 상태로 설정합니다. 테스트용 이메일/비밀번호 로그인을 활성화합니다. 실제 개인 계정 비밀번호를 사용하지 마세요. `.env.local`에 아래 테스트 전용 변수만 추가합니다.

```dotenv
SUPABASE_TEST_USER_A_EMAIL=...
SUPABASE_TEST_USER_A_PASSWORD=...
SUPABASE_TEST_USER_B_EMAIL=...
SUPABASE_TEST_USER_B_PASSWORD=...
```

```powershell
npm.cmd run test:security
```

스크립트는 임의 UUID를 가진 자기 테스트 레코드와 이미지 하나를 만들고, 5개 테이블의 타 사용자/비인증 접근, Storage 교차 접근, 버전 충돌, 잘못된 URL과 트랜잭션 롤백을 검사합니다. 자기 fixture만 정리합니다. 설정이 없으면 **NOT RUN**, 종료 코드 2로 끝나며 성공으로 처리하지 않습니다. 테스트 후 테스트 계정과 임시 비밀번호를 제거할 수 있습니다.

## 공식 문서

- [Supabase CLI 워크플로](https://supabase.com/docs/guides/local-development/cli-workflows)
- [Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Vercel CLI 배포](https://vercel.com/docs/projects/deploy-from-cli)
- [Vercel 환경변수](https://vercel.com/docs/cli/env)
