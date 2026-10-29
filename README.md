# IdeaDock

빠르게 기록하고, 다시 찾아보고, 하나씩 완성하는 개인 아이디어 작업 공간입니다.

공식 배포 플랫폼은 GitHub Pages입니다. 배포·OAuth 설정은 [Pages 안내](docs/PAGES.md), 이전 검증 기록은 [릴리스 준비](docs/RELEASE_READINESS.md)를 확인하세요.

## 실행

Node.js 24.x와 npm을 사용합니다. Windows PowerShell에서 실행 정책 때문에 `npm`이 차단되면 아래처럼 `npm.cmd`를 사용하세요.

```powershell
npm.cmd ci
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm.cmd run dev
```

http://localhost:3000/IdeaDock/ 에 접속합니다. 기본 저장 시스템은 **Google Drive + IndexedDB**입니다. `.env.local`에 `NEXT_PUBLIC_GOOGLE_CLIENT_ID`를 설정하면 Google 계정으로 연결할 수 있습니다. 연결 전에는 **체험 모드 열기**로 기존 UI와 편집 기능을 확인할 수 있습니다. 체험 데이터는 기존과 같은 localStorage 키에 보관하며 로그인 후에도 자동 업로드·삭제하지 않습니다.

Google OAuth 설정, 데이터 조사·이전·재시도·복구는 [안전한 이전 안내](docs/MIGRATION.md)를 확인하세요. 기존 Supabase 연결과 레거시 저장 코드는 유지합니다. [기존 설정 안내](docs/SETUP.md)는 Supabase 데이터 조사 및 롤백 시 사용합니다. 현재 배포 결과는 Pages 안내와 검증 기록을 참고하세요.

## 구현된 기능

v0.2의 데이터 호환성, 탐색기 조작과 Word 가져오기 절차는 [v0.2 안내](docs/V02.md)를 확인하세요.

- 사이드바의 새 아이디어로 즉시 생성하고 상세 패널 제목에서 편집
- 계층형 폴더, 하위 폴더, 클릭 가능한 경로, 이름 변경·이동·휴지통·복원
- Ctrl/Shift 선택, 빈 공간 사각형 선택, 폴더/아이디어 다중 이동, 드래그 대상 강조, 컨텍스트 메뉴
- 목록 영역의 Ctrl+A/Delete/F2/Escape, 모바일 길게 누르기 및 명시적 이동 버튼
- Word(.docx) 원문·이미지 가져오기 미리보기, 분리/합치기, 중복 검토, 승인·복구 백업·재시도
- 데스크톱 3단 레이아웃, 양쪽 패널 독립 접기·펼치기, 마우스/키보드 크기 조절, 기기별 설정 기억
- 모바일 전체 화면 편집과 브라우저 뒤로 가기
- 태그 탐색, 완료/미완료/고정/휴지통 필터, 4가지 정렬
- 완료 체크, 고정, 휴지통 이동·복원. 완료해도 제목과 본문에 취소선이나 흐림을 적용하지 않음
- Tiptap JSON 편집: 문단, 제목, 강조, 목록, 체크리스트, 링크, undo/redo
- 여러 웹사이트/GitHub 링크의 이름·URL 추가·편집·삭제·복사·새 탭 열기
- 이미지 업로드·드롭·붙여넣기, 첫 이미지 목록 썸네일, 본문 이미지, 확대와 삭제, 최대 12장/장당 5MB
- 스틸 블루 색상, 시스템/라이트/다크 테마, `Esc`로 상세·대화상자 닫기. 브라우저의 `Ctrl+N`, `Ctrl/Cmd+K`는 가로채지 않음
- Google OAuth 연결 코드, 사용자별 데이터, 700ms 자동 저장, 로컬 초안, 15초 주기 동기화
- 버전 충돌 감지와 서버 버전 불러오기/내 초안 복사본 보존
- 저장 오류 알림·재시도, 로컬 초안 복구, 사이드바 데이터 관리의 JSON 백업·가져오기·기존 데이터 찾기
- localStorage·기존 IndexedDB·Supabase 조사, JSON 가져오기 미리보기 및 수정
- 이미지 포함 복구 백업, 사용자 승인 후 Drive 이전, 반복 실행 중복 방지, 실패 후 재시도와 서버 재조회 검증
- v1 백업 읽기 유지, 폴더·소속 관계·출처를 포함하는 v2 백업

체험 모드는 브라우저 저장 공간을 고려해 이미지 장당 1MB로 제한합니다. 영구적 오프라인 모드나 여러 기기의 오프라인 자동 병합은 구현 범위에 포함하지 않았습니다.

## 구조와 기술

Next.js App Router / TypeScript / React / Tailwind CSS 4 / Lucide / Tiptap / Supabase JS를 사용합니다. 실제 설치 버전은 `package-lock.json`에 고정되어 있습니다.

```text
src/app/                   페이지, 메타데이터, 디자인 토큰/반응형 스타일
src/components/dock.tsx    목록·탐색·상세 UI
src/components/editor.tsx  Tiptap 편집과 비공개 본문 이미지
src/lib/use-ideas.ts       인증, 초안, 자동 저장, 버전 충돌, 동기화
src/lib/drive.ts           Google OAuth, Drive API, 삭제하지 않는 변경 이력
src/lib/local-db.ts        계정별 IndexedDB 초안, 체크포인트, 복구 백업
src/lib/discovery.ts       레거시 데이터 읽기 전용 조사
src/lib/migration.ts       백업, 승인 검사, 이전·검증·체험 복구, Import 확장 구조
src/lib/use-legacy-ideas.ts 기존 Supabase 저장·충돌 처리 (롤백용 보존)
src/lib/model.ts           데이터 타입, 검색·정렬, 입력 검증
supabase/migrations/       테이블, 뷰, RPC, RLS, Storage 버킷/정책
scripts/                   실제 클라우드 보안 검사와 CLI 연결/배포 도우미
tests/                     모델, 자동 저장, PostgreSQL 정책, E2E
docs/                      설정 절차와 검증 결과
```

본문은 실행 가능한 HTML 문자열 대신 Tiptap JSON을 저장합니다. 링크는 HTTP/HTTPS만 허용합니다. 파일은 PNG/JPEG/WebP/GIF만 허용하고 SVG는 받지 않습니다.

## 저장과 보안

기본 모드는 Google Identity Services와 drive.file 권한으로 사용자가 선택한 Google 계정의 일반 Drive에 IdeaDock 폴더를 만들고 문서 변경 이력과 이미지 원본을 저장합니다. 접근 토큰은 탭 단위 `sessionStorage`에 최대 1시간만 보관하므로 같은 탭의 새로고침에서는 연결이 유지됩니다. 앱을 다시 실행하면 마지막 계정의 기기 캐시가 바로 열리고, **Drive 다시 연결** 한 번으로 계정 선택 없이 재연결합니다. 정적 호스팅의 한계와 보안 검토는 [로그인 유지](docs/AUTH.md)에 있습니다. 재실행 후에도 자동으로 로그인되는 서버 세션 방식은 별도 [Cloudflare Pages 시험 배포](docs/CLOUDFLARE.md)로 제공합니다(`npm run build:cloudflare`, 공식 주소는 GitHub Pages 유지). 기기의 IndexedDB에는 계정별 초안과 업로드 재시도 정보가 남습니다. 저장 충돌이 나면 덮어쓰지 않고 복사본으로 보존할 수 있습니다. 이전한 아이디어는 원래 ID와 `provenance`를 갖고 새 아이디어와 구분됩니다.

아래 PostgreSQL 및 Storage 설명은 `NEXT_PUBLIC_STORAGE_BACKEND=legacy`로 선택하는 기존 모드에 해당합니다. 실제 데이터 검증 전까지 제거하지 않습니다.

`Ideas`, `Tags`, `IdeaTags`, `IdeaLinks`, `IdeaImages`를 정규화한 PostgreSQL 테이블로 저장합니다. `idea_documents`는 RLS를 유지하는 `security_invoker` 뷰입니다. `list_ideas` / `save_idea` RPC도 호출자 권한으로 실행합니다.

`save_idea`는 버전이 일치하는 경우에만 아이디어와 태그/링크/이미지 메타데이터를 하나의 트랜잭션으로 저장합니다. 버전이 달라지면 덮어쓰지 않고 충돌 화면을 표시합니다. 사용자는 서버 버전을 불러오거나 자신의 초안을 별도 아이디어로 남길 수 있습니다. 서버 변경 조회는 15초 간격으로 이루어지며 Realtime 구독은 사용하지 않습니다.

이미지 원본은 비공개 Storage 버킷에서 `사용자 UUID/아이디어 UUID/파일 UUID` 경로로 관리하고, 표시할 때 1시간 유효한 서명 URL을 발급합니다. 업로드 실패는 본문 데이터를 변경하지 않습니다. 모든 개인 테이블과 파일 경로에 사용자별 RLS 정책을 적용합니다. 앱에 관리용 secret key는 사용하지 않습니다.

로컬 초안은 계정 ID별로 분리됩니다. 로그아웃/계정 전환 시 화면 데이터를 비우고, 미저장 서버 변경이 있는 상태에서는 로그아웃을 막아 안내합니다. 초안은 새로고침 복구를 위해 기기에 남으므로 공용 기기에서는 백업/동기화 완료 후 해당 사이트의 브라우저 저장 데이터를 삭제하세요. 오프라인 편집의 강한 보장은 없으며 저장 실패 시 탭을 닫기 전에 상태와 백업을 확인할 수 있습니다.

## 검증

```powershell
npm.cmd run build
npm.cmd run typecheck
npm.cmd test
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run test:e2e:drive # 모의 OAuth/Drive, 승인·재시도·별도 브라우저 조회
npm.cmd run build
npm.cmd run bench # 로딩 성능 측정(모의 Drive). 결과 해석은 docs/PERFORMANCE.md
# 전용 Supabase 프로젝트와 테스트 계정 2개 연결 후:
npm.cmd run test:security
```

GitHub Actions가 타입 검사, 단위/DB 테스트, 빌드와 데스크톱·모바일 Chromium E2E를 수행합니다. 실제 Google OAuth 및 Supabase Storage 통합 테스트는 외부 프로젝트가 필요하므로 별도입니다. 자동 접근성 검사는 수동 키보드/스크린 리더 검증이나 WCAG 인증을 대신하지 않습니다.

로딩 성능 측정과 개선 내용은 [성능 기록](docs/PERFORMANCE.md)에 있습니다. 실행 결과와 확인하지 못한 항목은 [검증 기록](docs/VALIDATION.md)과 [이전 안내](docs/MIGRATION.md)를 참고하세요. 모의 API 검증은 실제 Google OAuth·Drive 또는 실제 두 기기 검증을 의미하지 않습니다.

## 남은 작업

- Google OAuth/Drive 설정과 실제 계정 데이터 이전 검증, 배포 환경 검증
- 실제 두 기기 동기화·동시 편집 및 Storage API 교차 계정 검증
- 삭제한 첨부 파일과 사용하지 않는 태그의 정기 정리 작업. 현재는 데이터 보호를 위해 Storage 원본을 자동 영구 삭제하지 않음
- Word 가져오기는 원본 보존·미리보기·사용자 확인 과정을 갖춰 v0.2에서 구현
- 장기 오프라인 지원, 수정 이력, 자동 병합은 후속 버전

GitHub 저장소: https://github.com/oyueo-mm/IdeaDock

공식 Pages 주소: https://oyueo-mm.github.io/IdeaDock/
