"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownUp,
  ArrowLeft,
  CheckCheck,
  Copy,
  ExternalLink,
  FileText,
  GitBranch,
  Hash,
  ImagePlus,
  Inbox,
  Lightbulb,
  LoaderCircle,
  LogOut,
  Menu,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  Plus,
  RotateCcw,
  Settings2,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useIdeas } from "@/lib/use-ideas";
import { useDialogFocus } from "@/lib/use-dialog-focus";
import {
  Filter,
  Idea,
  IdeaImage,
  IdeaLink,
  selectIdeas,
  validUrl,
  validateImage,
  removeImageContent,
} from "@/lib/model";
import { supabase } from "@/lib/supabase";
import Editor from "./editor";
import IdeaThumbnail from "./idea-thumbnail";
import MigrationPanel, { downloadJson } from "./migration-panel";
import { dataUrl, imageUrl, readImage, uploadDriveImage } from "@/lib/images";
import { prepareBackup } from "@/lib/migration";

type Layout = {
  left: boolean;
  right: boolean;
  leftWidth: number;
  rightWidth: number;
};
const defaultLayout: Layout = {
  left: true,
  right: true,
  leftWidth: 290,
  rightWidth: 420,
};
const nav = [
  { id: "all", label: "전체 아이디어", icon: Inbox },
  { id: "active", label: "미완료", icon: Lightbulb },
  { id: "completed", label: "완료한 아이디어", icon: CheckCheck },
  { id: "pinned", label: "고정한 아이디어", icon: Pin },
  { id: "trash", label: "휴지통", icon: Trash2 },
] as const;
function date(value: string) {
  return new Date(value).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
  });
}
export default function Dock() {
  const store = useIdeas();
  const { ideas, update } = store;
  const [filter, setFilter] = useState<Filter>("all"),
    [tag, setTag] = useState(""),
    [sort, setSort] = useState("updated"),
    [selected, setSelected] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>(defaultLayout),
    [loaded, setLoaded] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [settings, setSettings] = useState(false),
    [theme, setTheme] = useState("system");
  const current = ideas.find((i) => i.id === selected),
    visible = selectIdeas(ideas, filter, tag, "", sort),
    active = ideas.filter((i) => !i.deleted_at),
    tags = Array.from(new Set(active.flatMap((i) => i.tags))).sort();
  const [zoom, setZoom] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [focusTitle, setFocusTitle] = useState<string | null>(null);
  const [demoNotice, setDemoNotice] = useState(false);
  const settingsRef = useRef<HTMLElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  useDialogFocus(settingsRef, settings);
  useDialogFocus(zoomRef, !!zoom);
  useEffect(() => {
    const check = () => setOffline(!navigator.onLine);
    check();
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    return () => {
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
    };
  }, []);
  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("ideadock:layout") || "null",
      );
      if (saved)
        setLayout({
          ...defaultLayout,
          ...saved,
          leftWidth: Math.min(
            320,
            Math.max(180, Number(saved.leftWidth) || defaultLayout.leftWidth),
          ),
          rightWidth: Math.min(
            680,
            Math.max(340, Number(saved.rightWidth) || 420),
          ),
        });
      setTheme(localStorage.getItem("ideadock:theme") || "system");
    } catch {}
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) {
      try {
        localStorage.setItem("ideadock:layout", JSON.stringify(layout));
      } catch {}
    }
  }, [layout, loaded]);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem("ideadock:theme", theme);
    } catch {}
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, loaded]);
  useEffect(() => {
    const pop = () => {
      const id = new URLSearchParams(location.hash.slice(1)).get("idea");
      setSelected(id);
    };
    pop();
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (zoom) {
          setZoom(null);
          return;
        }
        if (settings) {
          setSettings(false);
          return;
        }
        if (mobileNav) {
          setMobileNav(false);
          return;
        }
        setSelected(null);
        history.replaceState(null, "", location.pathname);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [settings, zoom, mobileNav]);
  function open(idea: Idea) {
    setSelected(idea.id);
    setLayout((prev) => ({ ...prev, right: true }));
    history.pushState(null, "", `#idea=${idea.id}`);
  }
  function close() {
    setSelected(null);
    history.replaceState(null, "", location.pathname);
  }
  function add() {
    const idea = store.create("제목 없는 아이디어");
    if (idea) {
      setTag("");
      setFilter("all");
      open(idea);
      setFocusTitle(idea.id);
      setMobileNav(false);
    }
  }
  function resize(side: "left" | "right", start: number, initial: number) {
    const move = (e: PointerEvent) =>
      setLayout((prev) => ({
        ...prev,
        [`${side}Width`]: Math.max(
          side === "left" ? 180 : 340,
          Math.min(
            side === "left" ? 320 : 680,
            initial + (side === "left" ? e.clientX - start : start - e.clientX),
          ),
        ),
      }));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }
  function separator(side: "left" | "right") {
    return (
      <div
        className={`resize-handle ${side}`}
        role="separator"
        aria-label={side === "left" ? "탐색 패널 너비" : "상세 패널 너비"}
        aria-orientation="vertical"
        aria-valuemin={side === "left" ? 180 : 340}
        aria-valuemax={side === "left" ? 320 : 680}
        aria-valuenow={side === "left" ? layout.leftWidth : layout.rightWidth}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          resize(
            side,
            e.clientX,
            side === "left" ? layout.leftWidth : layout.rightWidth,
          );
        }}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
            e.preventDefault();
            setLayout((prev) => ({
              ...prev,
              [`${side}Width`]: Math.max(
                side === "left" ? 180 : 340,
                Math.min(
                  side === "left" ? 320 : 680,
                  (side === "left" ? prev.leftWidth : prev.rightWidth) +
                    (e.key === "ArrowRight" ? 1 : -1) *
                      (side === "left" ? 20 : -20),
                ),
              ),
            }));
          }
        }}
      />
    );
  }
  async function login() {
    try {
      await store.login();
    } catch (error) {
      store.setError(error instanceof Error ? error.message : String(error));
    }
  }
  async function backup() {
    try {
      if (!ideas.length) {
        downloadJson({ ideas: [] }, "ideadock-empty-backup.json");
        return;
      }
      const owner = store.demo ? "demo" : `${store.backend}:${store.user?.id}`;
      const result = await prepareBackup(
        [{ id: owner, label: "현재 작업 공간", ideas }],
        readImage,
        dataUrl,
        null,
      );
      downloadJson(result, `ideadock-recovery-${result.id.slice(0, 12)}.json`);
    } catch (error) {
      store.setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  const authenticated = !!store.user || store.demo;
  return (
    <div
      className="app-shell"
      style={
        {
          "--left-width": `${layout.leftWidth}px`,
          "--right-width": `${layout.rightWidth}px`,
        } as React.CSSProperties
      }
    >
      <a className="skip-link" href="#idea-list">
        아이디어 목록으로 건너뛰기
      </a>
      <aside
        hidden={!layout.left && !mobileNav}
        className={`sidebar ${mobileNav ? "mobile-open" : ""}`}
        aria-label="탐색"
      >
        <div className="brand">
          <span>IdeaDock</span>
          <button
            className="icon-button sidebar-collapse"
            aria-label="왼쪽 패널 접기"
            onClick={() => {
              setLayout((prev) => ({ ...prev, left: false }));
              setMobileNav(false);
            }}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <button
          className="new-idea"
          disabled={!authenticated}
          onClick={add}
          title={
            !authenticated
              ? "Google 로그인 또는 체험 모드에서 사용할 수 있습니다."
              : undefined
          }
        >
          <Plus size={17} />새 아이디어
        </button>
        <div className="nav-caption">라이브러리</div>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={
                filter === item.id && !tag ? "nav-item selected" : "nav-item"
              }
              onClick={() => {
                setFilter(item.id);
                setTag("");
                setMobileNav(false);
              }}
            >
              <item.icon size={17} />
              <span>{item.label}</span>
              {authenticated && (
                <small>
                  {item.id === "trash"
                    ? ideas.filter((i) => i.deleted_at).length
                    : item.id === "all"
                      ? active.length
                      : item.id === "active"
                        ? active.filter((i) => !i.is_completed).length
                        : item.id === "completed"
                          ? active.filter((i) => i.is_completed).length
                          : active.filter((i) => i.is_pinned).length}
                </small>
              )}
            </button>
          ))}
        </nav>
        {authenticated && (
          <>
            <div className="nav-caption tags-heading">
              태그 <Hash size={13} />
            </div>
            <div className="sidebar-tags">
              {tags.length ? (
                tags.map((t, index) => (
                  <button
                    key={t}
                    className={`nav-item ${tag === t ? "selected" : ""}`}
                    onClick={() => {
                      setTag(t === tag ? "" : t);
                      setFilter("all");
                      setMobileNav(false);
                    }}
                  >
                    <span className={`tag-dot color-${index % 5}`} />
                    <span>{t}</span>
                    <small>
                      {active.filter((i) => i.tags.includes(t)).length}
                    </small>
                  </button>
                ))
              ) : (
                <p className="muted sidebar-hint">태그 없음</p>
              )}
            </div>
          </>
        )}
        <div className="sidebar-bottom">
          <MigrationPanel
            account={store.backend === "drive" ? store.user?.id : undefined}
            demo={store.demo}
            pending={store.pendingCount}
            onRefresh={store.backend === "drive" ? store.refresh : store.flush}
            onBackup={backup}
          />
          <button
            className="account"
            aria-label="작업 공간 설정"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={16} />
            계정 및 설정
          </button>
        </div>
      </aside>
      {layout.left && separator("left")}
      {mobileNav && (
        <button
          className="nav-scrim"
          aria-label="탐색 닫기"
          onClick={() => setMobileNav(false)}
        />
      )}
      <main className="main-panel" id="idea-list">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button menu-toggle"
              aria-label="탐색 패널 열기"
              onClick={() => {
                setLayout((prev) => ({ ...prev, left: true }));
                setMobileNav(true);
              }}
            >
              <Menu size={18} />
            </button>
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button"
              aria-label="오른쪽 패널 열기 또는 접기"
              onClick={() =>
                setLayout((prev) => ({ ...prev, right: !prev.right }))
              }
            >
              {layout.right ? (
                <PanelRightClose size={17} />
              ) : (
                <PanelRightOpen size={17} />
              )}
            </button>
          </div>
        </header>
        <div className="main-content">
          {authenticated && (
            <div className="page-title">
              <div>
                <h1>
                  {tag
                    ? `# ${tag}`
                    : filter === "all"
                      ? "아이디어"
                      : nav.find((i) => i.id === filter)?.label}
                </h1>
              </div>
            </div>
          )}
          {!authenticated && (
            <section className="welcome">
              <p>Google Drive에 연결하여 아이디어를 동기화하세요.</p>
              <div className="welcome-actions">
                <button className="primary" onClick={login}>
                  Google로 시작하기
                </button>
                <button
                  className="text-button"
                  title="체험 데이터는 이 브라우저에만 보관되며 Google Drive에 동기화되지 않습니다."
                  onClick={() => {
                    store.startDemo();
                    setDemoNotice(true);
                  }}
                >
                  체험 모드 열기
                </button>
              </div>
            </section>
          )}
          {authenticated && (
            <div className="list-tools">
              <label className="sort-field">
                <ArrowDownUp size={14} />
                <select
                  aria-label="아이디어 정렬"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="updated">최근 수정순</option>
                  <option value="created">최근 생성순</option>
                  <option value="oldest">오래된순</option>
                  <option value="title">제목순</option>
                </select>
              </label>
            </div>
          )}
          <div className="sync-alerts">
            {store.demo && demoNotice && (
              <div className="sync-notice" role="status">
                체험 데이터는 이 브라우저에만 보관되며 Google Drive에 동기화되지
                않습니다.
                <button
                  className="icon-button"
                  aria-label="체험 데이터 안내 닫기"
                  onClick={() => setDemoNotice(false)}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {offline && (
              <div className="sync-notice" role="status">
                오프라인입니다. 연결이 복구되면 동기화를 재시도합니다.
              </div>
            )}
            {authenticated && !store.demo && store.pendingCount > 0 && (
              <div className="sync-notice" role="status">
                Drive에 저장되지 않은 변경 사항 {store.pendingCount}개
              </div>
            )}
            {/확인 필요|재시도|대기 중/.test(store.status) && !store.error && (
              <div className="sync-notice" role="status">
                {store.status}
              </div>
            )}
            {store.error && (
              <div className="error-banner" role="alert">
                <span>{store.error}</span>
                <button onClick={() => void store.flush()}>저장 재시도</button>
                <button
                  aria-label="오류 알림 닫기"
                  onClick={() => store.setError("")}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {store.conflicts.map((id) => (
              <div className="conflict" key={id} role="alert">
                <strong>
                  {ideas.find((i) => i.id === id)?.title} · 동시 편집 충돌
                </strong>
                <p>
                  서버의 변경 내용과 내 초안을 모두 보존하려면 복사본을
                  만드세요.
                </p>
                <button onClick={() => void store.resolve(id, true)}>
                  내 초안을 복사하고 서버 버전 불러오기
                </button>
                <button onClick={() => void store.resolve(id, false)}>
                  서버 버전 사용 · 내 변경 버리기
                </button>
              </div>
            ))}
          </div>
          {!authenticated ? null : !store.ready ? (
            <div className="empty">
              <LoaderCircle className="spin" />
              작업 공간을 불러오는 중…
            </div>
          ) : visible.length ? (
            <div className="idea-list">
              {visible.map((idea) => (
                <article
                  className={`idea-row ${selected === idea.id ? "is-selected" : ""}`}
                  key={idea.id}
                >
                  <input
                    aria-label={`${idea.title} 완료`}
                    className="completion-check"
                    type="checkbox"
                    checked={idea.is_completed}
                    onChange={(e) =>
                      update({ ...idea, is_completed: e.target.checked })
                    }
                  />
                  <button className="idea-summary" onClick={() => open(idea)}>
                    <span className="idea-title">
                      {idea.is_pinned && <Pin size={12} />} {idea.title}
                      {idea.is_completed && (
                        <small className="completed-label">완료</small>
                      )}
                    </span>
                    <span className="idea-preview">
                      {idea.plain_text || "본문 없음"}
                    </span>
                    <span className="idea-meta">
                      {idea.tags.map((t, index) => (
                        <span key={t} className={`tag-chip color-${index % 5}`}>
                          {t}
                        </span>
                      ))}
                      <span>{date(idea.updated_at)}</span>
                      {idea.provenance && <span>이전한 아이디어</span>}
                      {idea.images.length > 0 && (
                        <span>이미지 {idea.images.length}</span>
                      )}
                    </span>
                  </button>
                  <div className="row-actions">
                    {idea.links.find((l) => l.type === "website") && (
                      <a
                        className="icon-button"
                        href={idea.links.find((l) => l.type === "website")!.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${idea.title} 웹사이트 열기`}
                      >
                        <ExternalLink size={15} />
                      </a>
                    )}
                    {idea.deleted_at ? (
                      <button
                        className="icon-button"
                        aria-label={`${idea.title} 복원`}
                        onClick={() => update({ ...idea, deleted_at: null })}
                      >
                        <RotateCcw size={16} />
                      </button>
                    ) : (
                      <button
                        className={`icon-button pin-action ${idea.is_pinned ? "pinned" : ""}`}
                        aria-label={`${idea.title} 고정 ${idea.is_pinned ? "해제" : ""}`}
                        onClick={() =>
                          update({ ...idea, is_pinned: !idea.is_pinned })
                        }
                      >
                        <Pin size={15} />
                      </button>
                    )}
                  </div>
                  {idea.images[0] && (
                    <IdeaThumbnail
                      image={idea.images[0]}
                      title={idea.title}
                      onOpen={() => open(idea)}
                    />
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="empty">
              <h2>
                {filter === "trash"
                  ? "휴지통이 비어 있습니다"
                  : filter === "completed"
                    ? "완료한 아이디어가 없습니다"
                    : "아이디어가 없습니다"}
              </h2>
            </div>
          )}
        </div>
      </main>
      {layout.right && separator("right")}
      {layout.right && (
        <aside
          className={`detail-panel ${current ? "has-selection" : ""}`}
          aria-label="아이디어 상세"
        >
          <header className="detail-header">
            <button
              className="icon-button mobile-back"
              aria-label="목록으로 돌아가기"
              onClick={close}
            >
              <ArrowLeft size={18} />
            </button>
            <span>
              <FileText size={15} />
              아이디어 노트
            </span>
            <button
              className="icon-button"
              aria-label="상세 패널 닫기"
              onClick={() => {
                close();
                setLayout((prev) => ({ ...prev, right: false }));
              }}
            >
              <X size={18} />
            </button>
          </header>
          {current ? (
            <Detail
              key={current.id}
              idea={current}
              onChange={update}
              demo={store.demo}
              drive={store.backend === "drive" && !store.demo}
              onError={store.setError}
              onZoom={setZoom}
              focusTitle={focusTitle === current.id}
            />
          ) : authenticated ? (
            <div className="detail-placeholder">
              <h2>선택한 아이디어 없음</h2>
            </div>
          ) : null}
        </aside>
      )}
      {settings && (
        <div className="modal-backdrop" onClick={() => setSettings(false)}>
          <section
            ref={settingsRef}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title">
              <h2 id="settings-title">작업 공간 설정</h2>
              <button aria-label="설정 닫기" onClick={() => setSettings(false)}>
                <X size={19} />
              </button>
            </div>
            <p>화면 테마</p>
            <div className="theme-options">
              {[
                { id: "light", label: "라이트", icon: Sun },
                { id: "dark", label: "다크", icon: Moon },
                { id: "system", label: "시스템", icon: Monitor },
              ].map((t) => (
                <button
                  key={t.id}
                  className={theme === t.id ? "selected" : ""}
                  onClick={() => setTheme(t.id)}
                >
                  <t.icon size={18} />
                  {t.label}
                </button>
              ))}
            </div>
            <p className="settings-account">
              {store.user?.email ||
                (store.demo
                  ? "체험 데이터는 이 브라우저에만 보관되며 Google Drive에 동기화되지 않습니다."
                  : "로그인되지 않음")}
            </p>
            {!store.user && (
              <button className="primary" onClick={login}>
                Google 로그인
              </button>
            )}
            {store.user && store.backend === "drive" && (
              <button className="settings-button" onClick={login}>
                Google Drive 다시 연결
              </button>
            )}
            {store.backend === "drive" && supabase && (
              <button
                className="settings-button"
                onClick={async () => {
                  const result = await supabase?.auth.signInWithOAuth({
                    provider: "google",
                    options: {
                      redirectTo: `${location.origin}${location.pathname}`,
                    },
                  });
                  if (result?.error) store.setError(result.error.message);
                }}
              >
                이전 Supabase 계정 연결 · 데이터 조사용
              </button>
            )}
            <button
              className="settings-button"
              onClick={() => setLayout(defaultLayout)}
            >
              패널 레이아웃 초기화
            </button>
            {authenticated && (
              <button
                className="settings-button"
                onClick={() => {
                  void store.signOut();
                  setSettings(false);
                }}
              >
                <LogOut size={15} />
                {store.demo ? "체험 모드 나가기" : "로그아웃"}
              </button>
            )}
          </section>
        </div>
      )}
      {zoom && (
        <div
          ref={zoomRef}
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="이미지 확대"
          onClick={() => setZoom(null)}
        >
          <button aria-label="이미지 확대 닫기" onClick={() => setZoom(null)}>
            <X />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="첨부 이미지 확대" />
        </div>
      )}
    </div>
  );
}

function Detail({
  idea,
  onChange,
  demo,
  drive,
  onError,
  onZoom,
  focusTitle,
}: {
  idea: Idea;
  onChange: (idea: Idea) => void;
  demo: boolean;
  drive: boolean;
  onError: (text: string) => void;
  onZoom: (url: string) => void;
  focusTitle: boolean;
}) {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusTitle) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [focusTitle]);
  const latest = useRef(idea);
  latest.current = idea;
  const [tagText, setTagText] = useState(""),
    [linkOpen, setLinkOpen] = useState(false),
    [link, setLink] = useState<IdeaLink>({
      id: "",
      label: "",
      url: "",
      type: "website",
    }),
    [uploading, setUploading] = useState(false),
    [urls, setUrls] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  function patch(changes: Partial<Idea>) {
    onChange({ ...latest.current, ...changes });
  }
  useEffect(() => {
    let live = true;
    const allocated: string[] = [];
    async function load() {
      const next: Record<string, string> = {};
      for (const image of idea.images) {
        if (demo) {
          next[image.id] = image.storage_path;
          continue;
        }
        try {
          const url = await imageUrl(image.storage_path);
          allocated.push(url);
          if (live) next[image.id] = url;
          else URL.revokeObjectURL(url);
        } catch (error) {
          if (live)
            onError(error instanceof Error ? error.message : String(error));
        }
      }
      if (live) setUrls(next);
    }
    void load();
    const interval = setInterval(() => void load(), 3000000);
    return () => {
      live = false;
      clearInterval(interval);
      allocated.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [idea.images, demo, onError]);
  async function files(files: File[]) {
    if (uploading) return [];
    setUploading(true);
    const attached: IdeaImage[] = [];
    try {
      for (const file of files) {
        validateImage(file);
        if (latest.current.images.length >= 12)
          throw new Error(
            "아이디어 하나에 이미지는 최대 12장까지 첨부할 수 있습니다.",
          );
        const id = crypto.randomUUID();
        let path: string;
        if (demo) {
          if (file.size > 1024 * 1024)
            throw new Error(
              "체험 모드의 이미지는 1MB까지 지원합니다. 실제 계정에서는 5MB까지 가능합니다.",
            );
          path = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () =>
              reject(new Error("이미지를 읽지 못했습니다."));
            reader.readAsDataURL(file);
          });
        } else if (drive) {
          path = await uploadDriveImage(file);
        } else {
          if (!supabase) throw new Error("클라우드 연결이 필요합니다.");
          path = `${idea.user_id}/${idea.id}/${id}`;
          const result = await supabase.storage
            .from("idea-images")
            .upload(path, file, { contentType: file.type, upsert: false });
          if (result.error) throw result.error;
        }
        const image: IdeaImage = {
          id,
          storage_path: path,
          original_filename: file.name,
        };
        const next = {
          ...latest.current,
          images: [...latest.current.images, image],
        };
        latest.current = next;
        onChange(next);
        attached.push(image);
      }
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "이미지 업로드에 실패했습니다.",
      );
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
    return attached;
  }
  function addTag() {
    const name = tagText.trim().replace(/^#/, "");
    if (name && !idea.tags.includes(name)) {
      if (name.length > 50) {
        onError("태그는 50자 이하로 입력해 주세요.");
        return;
      }
      patch({ tags: [...idea.tags, name] });
    }
    setTagText("");
  }
  function saveLink() {
    if (!validUrl(link.url)) {
      onError("올바른 HTTP 또는 HTTPS URL을 입력해 주세요.");
      return;
    }
    const value = {
      ...link,
      id: link.id || crypto.randomUUID(),
      label:
        link.label.trim() || (link.type === "github" ? "GitHub" : "웹사이트"),
    };
    patch({
      links: idea.links.some((l) => l.id === value.id)
        ? idea.links.map((l) => (l.id === value.id ? value : l))
        : [...idea.links, value],
    });
    setLinkOpen(false);
  }
  return (
    <div className="detail-scroll">
      <div className="detail-top-meta">
        <label className={`completion-pill ${idea.is_completed ? "done" : ""}`}>
          <input
            type="checkbox"
            aria-label="상세 아이디어 완료"
            checked={idea.is_completed}
            onChange={(e) => patch({ is_completed: e.target.checked })}
          />
          {idea.is_completed ? "구현 완료" : "아이디어 단계"}
        </label>
        <div>
          <button
            className={`icon-button ${idea.is_pinned ? "pinned" : ""}`}
            aria-label="현재 아이디어 고정"
            onClick={() => patch({ is_pinned: !idea.is_pinned })}
          >
            <Pin size={16} />
          </button>
          <button
            className="icon-button"
            aria-label={
              idea.deleted_at
                ? "현재 아이디어 복원"
                : "현재 아이디어 휴지통으로 이동"
            }
            onClick={() =>
              patch({
                deleted_at: idea.deleted_at ? null : new Date().toISOString(),
              })
            }
          >
            {idea.deleted_at ? <RotateCcw size={16} /> : <Trash2 size={16} />}
          </button>
        </div>
      </div>
      <textarea
        ref={titleRef}
        className="detail-title"
        aria-label="아이디어 제목 편집"
        value={idea.title}
        rows={Math.min(6, Math.max(2, Math.ceil(idea.title.length / 19)))}
        onChange={(e) => patch({ title: e.target.value })}
        onBlur={() => {
          if (!latest.current.title.trim())
            patch({ title: "제목 없는 아이디어" });
        }}
      />
      <div className="detail-dates">
        <span>만든 날 {date(idea.created_at)}</span>
        <span>수정 {date(idea.updated_at)}</span>
      </div>
      <section className="detail-section">
        <div className="section-label">
          <Hash size={14} />
          태그
        </div>
        <div className="editable-tags">
          {idea.tags.map((t, index) => (
            <span className={`tag-chip color-${index % 5}`} key={t}>
              <button
                title="태그 이름 변경"
                aria-label={`${t} 태그 이름 변경`}
                onClick={() => {
                  const name = window.prompt("새 태그 이름", t)?.trim();
                  if (!name || name === t) return;
                  if (name.length > 50) {
                    onError("태그는 50자 이하로 입력해 주세요.");
                    return;
                  }
                  patch({
                    tags: Array.from(
                      new Set(idea.tags.map((tag) => (tag === t ? name : tag))),
                    ),
                  });
                }}
              >
                {t}
              </button>
              <button
                aria-label={`${t} 태그 삭제`}
                onClick={() =>
                  patch({ tags: idea.tags.filter((tag) => tag !== t) })
                }
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <input
            aria-label="태그 추가"
            value={tagText}
            placeholder="+ 태그 추가"
            onChange={(e) => setTagText(e.target.value)}
            onBlur={addTag}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                addTag();
              }
            }}
          />
        </div>
      </section>
      <section className="detail-section memo-section">
        <div className="section-label">
          <FileText size={14} />
          아이디어 메모
        </div>
        <Editor
          content={idea.content}
          onChange={(content, plain_text) => patch({ content, plain_text })}
          onFiles={files}
          onZoom={onZoom}
        />
      </section>
      <section className="detail-section">
        <div className="section-label">
          <ExternalLink size={14} />
          관련 링크
          <button
            aria-label="관련 링크 추가"
            onClick={() => {
              setLink({ id: "", label: "", url: "", type: "website" });
              setLinkOpen(true);
            }}
          >
            <Plus size={15} />
          </button>
        </div>
        {idea.links.map((l) => (
          <div className="link-row" key={l.id}>
            {l.type === "github" ? (
              <GitBranch size={17} />
            ) : (
              <ExternalLink size={17} />
            )}
            <a href={l.url} target="_blank" rel="noopener noreferrer">
              <strong>{l.label}</strong>
              <small>{l.url}</small>
            </a>
            <button
              aria-label={`${l.label} URL 복사`}
              onClick={() =>
                navigator.clipboard
                  .writeText(l.url)
                  .catch(() =>
                    onError(
                      "URL을 복사하지 못했습니다. 주소를 직접 복사해 주세요.",
                    ),
                  )
              }
            >
              <Copy size={13} />
            </button>
            <button
              aria-label={`${l.label} 링크 편집`}
              onClick={() => {
                setLink(l);
                setLinkOpen(true);
              }}
            >
              <Settings2 size={13} />
            </button>
            <button
              aria-label={`${l.label} 링크 삭제`}
              onClick={() =>
                patch({ links: idea.links.filter((x) => x.id !== l.id) })
              }
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {linkOpen && (
          <form
            className="link-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveLink();
            }}
          >
            <select
              aria-label="링크 종류"
              value={link.type}
              onChange={(e) =>
                setLink({ ...link, type: e.target.value as IdeaLink["type"] })
              }
            >
              <option value="website">웹사이트</option>
              <option value="github">GitHub</option>
            </select>
            <input
              autoFocus
              aria-label="링크 이름"
              placeholder="링크 이름"
              value={link.label}
              onChange={(e) => setLink({ ...link, label: e.target.value })}
            />
            <input
              aria-label="링크 URL"
              placeholder="https://"
              value={link.url}
              onChange={(e) => setLink({ ...link, url: e.target.value })}
            />
            <div>
              <button className="primary" type="submit">
                링크 저장
              </button>
              <button type="button" onClick={() => setLinkOpen(false)}>
                취소
              </button>
            </div>
          </form>
        )}
      </section>
      <section className="detail-section">
        <div className="section-label">
          <ImagePlus size={14} />
          참고 이미지 <small>{idea.images.length}/12</small>
          <button
            aria-label="이미지 첨부"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Plus size={15} />
            )}
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(e) => void files(Array.from(e.target.files || []))}
        />
        <div className="image-grid">
          {idea.images.map((image) => (
            <div key={image.id}>
              {urls[image.id] ? (
                <button onClick={() => onZoom(urls[image.id])}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={urls[image.id]} alt={image.original_filename} />
                </button>
              ) : (
                <span>이미지 준비 중</span>
              )}
              <button
                className="image-remove"
                aria-label={`${image.original_filename} 이미지 삭제`}
                onClick={() =>
                  patch({
                    images: idea.images.filter((i) => i.id !== image.id),
                    content: removeImageContent(idea.content, image.id),
                  })
                }
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="upload-area"
          disabled={uploading}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void files(Array.from(e.dataTransfer.files));
          }}
        >
          <ImagePlus size={21} />
          <span>
            {uploading
              ? "이미지 업로드 중…"
              : "이미지를 끌어 놓거나 클릭해 첨부"}
          </span>
          <small>본문에 붙여넣기도 가능 · 최대 5MB</small>
        </button>
      </section>
    </div>
  );
}
