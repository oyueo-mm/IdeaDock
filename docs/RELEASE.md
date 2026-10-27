# 실제 서비스 연결 진행표

> 초기 Supabase/Vercel 준비 기록입니다. 현재 배포는 [GitHub Pages 안내](PAGES.md)를 따릅니다.

2026-10-27 기준. UI/UX와 기존 기능은 보존합니다. 아래 체크는 실제 검증을 마친 뒤에만 완료로 변경합니다.

## 로컬 준비

- [x] 코드/문서/환경변수 예시의 Supabase 설정 이름 대조
- [x] 민감정보 패턴 검사 도구 준비. 실제 값은 출력하지 않음
- [x] `.env*`, `.vercel`, Supabase 임시 인증/연결 파일이 Git에서 제외됨을 확인
- [x] 첨부가 있는 충돌 복사본의 ID·Storage 경로 재사용 문제 수정 및 회귀 테스트 추가
- [x] GitHub main 일반 커밋·푸시 완료. 강제 push 없음

첫 소스 커밋: [`64fbabe`](https://github.com/oyueo-mm/IdeaDock/commit/64fbabef783e6dbe1a8e3b58a82372cfdebe9890). 업로드된 main SHA와 로컬 SHA가 같은지 확인했습니다. GitHub 계정의 noreply 이메일을 사용했습니다.

이번 연결 준비 검사: Git 후보 파일 37개에서 민감정보 패턴 미검출, 환경변수 이름 일치, 로컬 테스트 26개 통과, 타입 검사·프로덕션 빌드 통과. `.env.local`은 아직 없어 실제 API 검증은 미실행입니다.

GitHub CI: [첫 main 실행](https://github.com/oyueo-mm/IdeaDock/actions/runs/40488944253) **전체 통과**. 깨끗한 Linux 환경에서 `npm ci`, 타입 검사, 단위/DB 테스트, 빌드, 데스크톱/모바일 E2E까지 성공한 상태를 확인했습니다. 이는 클라우드 미연결 상태의 검사이며 실제 Supabase/Google/Vercel 검증을 포함하지 않습니다.

## 사용자 계정에서 진행할 순서

1. **Supabase 프로젝트 생성:** `IdeaDock` 전용 새 프로젝트를 생성합니다. DB 비밀번호는 비밀번호 관리자에 저장합니다. 다른 프로젝트를 선택하지 않습니다.
2. **앱 설정:** `.env.local`에 `NEXT_PUBLIC_SUPABASE_URL`과 `NEXT_PUBLIC_SUPABASE_ANON_KEY`(publishable key 권장)를 입력합니다. 값은 채팅이나 Git에 넣지 않습니다. 프로젝트 URL만 전달하면 연결 대상을 확인할 수 있습니다.
3. **접근 연결:** 직접 SQL Editor를 사용하거나, 로컬 터미널에서 `npx.cmd supabase login`을 실행하거나, Supabase 앱을 설치·계정 연결합니다. 인증 비밀값을 대신 공유하지 않습니다.
4. **마이그레이션:** 전용 프로젝트 ref를 대조하고 `db push --dry-run` 후 `db push`를 실행합니다. SQL Editor 방식이면 초기 SQL 전체를 한 번만 실행합니다. 두 방식을 중복 적용하거나 `db reset --linked`를 실행하지 않습니다. 기존 테이블이 있다면 적용을 멈추고 이력을 먼저 대조합니다.
5. **Storage·RLS:** `idea-images`가 private, 장당 5MB, PNG/JPEG/WebP/GIF 제한인지 확인합니다. 5개 테이블의 RLS 활성화와 사용자별 정책을 확인합니다. 테이블/RPC/Storage 정책은 같은 마이그레이션에 포함되어 별도 public 버킷을 만들 필요가 없습니다.
6. **Google OAuth:** Google 웹 OAuth 클라이언트를 만들고, Supabase가 안내하는 `/auth/v1/callback`을 승인 URI에 추가합니다. Client Secret은 Supabase Provider 설정에만 넣습니다. 테스트 게시 상태면 로그인할 계정을 테스트 사용자로 등록합니다. 앱의 실제 origin을 Supabase Site URL/Redirect URLs에 등록합니다.
7. **실제 API 보안 검사:** 전용 테스트 사용자 두 개를 만들고 `.env.local`의 테스트 변수에 입력한 후 `npm.cmd run test:security`를 실행합니다. 데이터가 생기는 테스트지만 임의 UUID의 자기 fixture만 정리합니다. 이 검사는 Google 로그인 자체를 검증하지 않습니다.
8. **Vercel:** GitHub의 `oyueo-mm/IdeaDock`를 Import하고 Next.js, Node 24.x, 설치 `npm ci`, 빌드 `npm run build`, Production Branch `main`을 확인합니다. 공개 앱 변수 2개만 Production과 필요한 Preview에 넣습니다. 테스트 계정 비밀번호나 DB 비밀번호는 등록하지 않습니다. GitHub 연동 전 Vercel이 해당 저장소에 접근하도록 본인 계정에서 승인해야 합니다.
9. **Production:** 최초 배포 주소를 Supabase Site URL/Redirect URLs에 등록하고, 환경변수 변경 후 재배포합니다. CLI를 쓰면 연결된 Vercel 프로젝트를 확인한 후 `npx.cmd vercel --prod`를 실행합니다. 배포 URL과 커밋 SHA를 기록합니다.

## 실제 서비스 인수 검사 — 현재 전부 미실행

- [ ] 실제 Google 로그인, 새로고침 후 세션, 로그아웃
- [ ] 제목만 생성 → 본문/태그/링크 편집 → 새로고침 후 재조회
- [ ] 완료/미완료·고정 상태의 서버 저장
- [ ] 휴지통 이동·복원 후 다른 세션에서도 같은 상태
- [ ] 이미지 업로드·붙여넣기·서명 URL·확대·삭제, 타 계정 접근 차단
- [ ] 같은 계정으로 실제 두 기기 접속 → 한 기기의 변경이 15초 주기 내 다른 기기에 반영
- [ ] 두 기기에 같은 아이디어를 열고, 두 번째 기기의 polling 전에 서로 다른 내용을 저장 → 충돌 안내 확인
- [ ] 충돌 시 내 초안 보존을 선택 → 원본 서버 버전과 별도 복사본의 본문/태그/링크/이미지 모두 재조회
- [ ] 네트워크 오류 중 초안 보존 → 연결 복구·저장 재시도
- [ ] Production URL에서 위 핵심 흐름 재확인

브라우저 컨텍스트 두 개의 자동 검사는 세션 간 동작만 검증하며, 실제 두 물리 기기 검증과 구분합니다. Google OAuth는 계정 소유자가 직접 동의해야 합니다. 외부 연결 전에는 로컬/모의 테스트 결과만 보고합니다.

## 데이터 보호

- 초기 마이그레이션은 새 전용 DB에만 적용합니다. DB reset, 강제 push, 기존 데이터 삭제는 사용하지 않습니다.
- 테스트 전에 실제 기록은 앱 설정의 JSON 백업으로 내려받습니다. 배포 롤백은 DB 롤백을 대신하지 않습니다.
- 충돌 복사 중 Storage 오류가 나면 원본 초안을 유지합니다. 중간에 복사된 미참조 파일이 남을 수 있으나 기존 파일을 자동 삭제하지 않습니다.
- 테스트용 사용자/비밀번호와 테스트 데이터만 정리하고, 실제 사용자의 데이터나 OAuth 동의를 임의로 제거하지 않습니다.
- 실제 환경변수·인증 연결 전에는 OAuth·Storage·동기화·Production 성공을 선언하지 않습니다.

상세 명령과 공식 문서: [SETUP.md](SETUP.md)
