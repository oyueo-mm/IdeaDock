# IdeaDock

빠르게 기록하고, 다시 찾아보고, 하나씩 완성하는 개인 아이디어 작업 공간입니다.

## 실행

Node.js 24.x와 npm을 사용합니다. Windows PowerShell에서 실행 정책 때문에 `npm`이 차단되면 아래처럼 `npm.cmd`를 사용하세요.

```powershell
npm.cmd ci
Copy-Item .env.example .env.local
npm.cmd run dev
```

http://localhost:3000 에 접속합니다. Supabase 설정 전에는 **체험 모드 열기**로 UI와 편집 기능을 확인할 수 있습니다. 체험 데이터는 이 브라우저에만 저장되며 실제 서버 동기화와 명확히 구분됩니다. 계정으로 로그인하면 체험 데이터가 자동 업로드되지는 않습니다.

전용 Supabase 프로젝트 생성, Google 로그인, GitHub/Vercel 연결, CLI 자동화는 [설정 안내](docs/SETUP.md)에 정리했습니다. 현재 클라우드 프로젝트 생성이나 실제 배포는 수행하지 않았습니다.

## 구현된 기능

- 제목 한 줄과 Enter로 빠른 추가, 즉시 목록 반영
- 데스크톱 3단 레이아웃, 양쪽 패널 독립 접기·펼치기, 마우스/키보드 크기 조절, 기기별 설정 기억
- 모바일 전체 화면 편집과 브라우저 뒤로 가기
- 제목·본문·태그 검색, 완료/미완료/고정/휴지통 필터, 4가지 정렬
- 완료 체크, 고정, 휴지통 이동·복원. 완료해도 제목과 본문에 취소선이나 흐림을 적용하지 않음
- Tiptap JSON 편집: 문단, 제목, 강조, 목록, 체크리스트, 링크, undo/redo
- 여러 웹사이트/GitHub 링크의 이름·URL 추가·편집·삭제·복사·새 탭 열기
- 이미지 업로드·드롭·붙여넣기, 본문 이미지, 확대와 삭제, 최대 12장/장당 5MB
- 시스템/라이트/다크 테마, `Ctrl/Cmd+K`, `N`, `Esc`, 빠른 입력의 `Ctrl/Cmd+Enter`
- Google OAuth 연결 코드, 사용자별 데이터, 700ms 자동 저장, 로컬 초안, 15초 주기 동기화
- 버전 충돌 감지와 서버 버전 불러오기/내 초안 복사본 보존
- 저장 오류 알림·재시도, 로컬 초안 복구, JSON 수동 백업

체험 모드는 브라우저 저장 공간을 고려해 이미지 장당 1MB로 제한합니다. 영구적 오프라인 모드나 여러 기기의 오프라인 자동 병합은 구현 범위에 포함하지 않았습니다.

## 구조와 기술

Next.js App Router / TypeScript / React / Tailwind CSS 4 / Lucide / Tiptap / Supabase JS를 사용합니다. 실제 설치 버전은 `package-lock.json`에 고정되어 있습니다.

```text
src/app/                   페이지, 메타데이터, 디자인 토큰/반응형 스타일
src/components/dock.tsx    목록·탐색·상세 UI
src/components/editor.tsx  Tiptap 편집과 비공개 본문 이미지
src/lib/use-ideas.ts       인증, 초안, 자동 저장, 버전 충돌, 동기화
src/lib/model.ts           데이터 타입, 검색·정렬, 입력 검증
supabase/migrations/       테이블, 뷰, RPC, RLS, Storage 버킷/정책
scripts/                   실제 클라우드 보안 검사와 CLI 연결/배포 도우미
tests/                     모델, 자동 저장, PostgreSQL 정책, E2E
docs/                      설정 절차와 검증 결과
```

본문은 실행 가능한 HTML 문자열 대신 Tiptap JSON을 저장합니다. 링크는 HTTP/HTTPS만 허용합니다. 파일은 PNG/JPEG/WebP/GIF만 허용하고 SVG는 받지 않습니다.

## 저장과 보안

`Ideas`, `Tags`, `IdeaTags`, `IdeaLinks`, `IdeaImages`를 정규화한 PostgreSQL 테이블로 저장합니다. `idea_documents`는 RLS를 유지하는 `security_invoker` 뷰입니다. `list_ideas` / `save_idea` RPC도 호출자 권한으로 실행합니다.

`save_idea`는 버전이 일치하는 경우에만 아이디어와 태그/링크/이미지 메타데이터를 하나의 트랜잭션으로 저장합니다. 버전이 달라지면 덮어쓰지 않고 충돌 화면을 표시합니다. 사용자는 서버 버전을 불러오거나 자신의 초안을 별도 아이디어로 남길 수 있습니다. 서버 변경 조회는 15초 간격으로 이루어지며 Realtime 구독은 사용하지 않습니다.

이미지 원본은 비공개 Storage 버킷에서 `사용자 UUID/아이디어 UUID/파일 UUID` 경로로 관리하고, 표시할 때 1시간 유효한 서명 URL을 발급합니다. 업로드 실패는 본문 데이터를 변경하지 않습니다. 모든 개인 테이블과 파일 경로에 사용자별 RLS 정책을 적용합니다. 앱에 관리용 secret key는 사용하지 않습니다.

로컬 초안은 계정 ID별로 분리됩니다. 로그아웃/계정 전환 시 화면 데이터를 비우고, 미저장 서버 변경이 있는 상태에서는 로그아웃을 막아 안내합니다. 초안은 새로고침 복구를 위해 기기에 남으므로 공용 기기에서는 백업/동기화 완료 후 해당 사이트의 브라우저 저장 데이터를 삭제하세요. 오프라인 편집의 강한 보장은 없으며 저장 실패 시 탭을 닫기 전에 상태와 백업을 확인할 수 있습니다.

## 검증

```powershell
npm.cmd run typecheck
npm.cmd test
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run build
# 전용 Supabase 프로젝트와 테스트 계정 2개 연결 후:
npm.cmd run test:security
```

GitHub Actions가 타입 검사, 단위/DB 테스트, 빌드와 데스크톱·모바일 Chromium E2E를 수행합니다. 실제 Google OAuth 및 Supabase Storage 통합 테스트는 외부 프로젝트가 필요하므로 별도입니다. 자동 접근성 검사는 수동 키보드/스크린 리더 검증이나 WCAG 인증을 대신하지 않습니다.

실행 결과와 확인하지 못한 항목은 [검증 기록](docs/VALIDATION.md)을 참고하세요.

## 남은 작업

- IdeaDock 전용 Supabase/Google OAuth/Vercel 계정 설정과 실제 환경 검증
- 실제 두 기기 동기화·동시 편집 및 Storage API 교차 계정 검증
- 삭제한 첨부 파일과 사용하지 않는 태그의 정기 정리 작업. 현재는 데이터 보호를 위해 Storage 원본을 자동 영구 삭제하지 않음
- Word 가져오기는 원본 보존·미리보기·사용자 확인 과정을 갖춰 v0.2에서 구현
- 장기 오프라인 지원, 수정 이력, 자동 병합은 후속 버전

GitHub 저장소: https://github.com/oyueo-mm/IdeaDock

Vercel 배포 주소: 아직 없음
