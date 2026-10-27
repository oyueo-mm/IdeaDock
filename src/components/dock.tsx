"use client";
import { useEffect, useRef, useState } from "react";
import {
  Anchor,
  ArrowDownUp,
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronRight,
  Cloud,
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
  Search,
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
import MigrationPanel, { downloadJson } from "./migration-panel";
import { driveConfigured } from "@/lib/drive";
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
  leftWidth: 220,
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
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("updated"),
    [quick, setQuick] = useState(""),
    [selected, setSelected] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>(defaultLayout),
    [loaded, setLoaded] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [settings, setSettings] = useState(false),
    [theme, setTheme] = useState("system");
  const quickRef = useRef<HTMLInputElement>(null),
    searchRef = useRef<HTMLInputElement>(null);
  const current = ideas.find((i) => i.id === selected),
    visible = selectIdeas(ideas, filter, tag, query, sort),
    active = ideas.filter((i) => !i.deleted_at),
    tags = Array.from(new Set(active.flatMap((i) => i.tags))).sort();
  const [zoom, setZoom] = useState<string | null>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  useDialogFocus(settingsRef, settings);
  useDialogFocus(zoomRef, !!zoom);
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
            Math.max(180, Number(saved.leftWidth) || 220),
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
      const target = e.target as HTMLElement;
      const typing =
        target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "n" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        quickRef.current?.focus();
      }
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
    const idea = store.create(quick);
    if (idea) {
      setQuick("");
      setQuery("");
      setTag("");
      setFilter("all");
      open(idea);
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
      {(layout.left || mobileNav) && (
        <aside
          className={`sidebar ${mobileNav ? "mobile-open" : ""}`}
          aria-label="탐색"
        >
          <div className="brand">
            <span className="brand-icon">
              <Anchor size={22} />
            </span>
            <span>
              IdeaDock<span className="brand-dot">.</span>
            </span>
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
          <div className="workspace-label">
            개인 작업 공간 <span>PRIVATE</span>
          </div>
          <button
            className="new-idea"
            onClick={() => {
              quickRef.current?.focus();
              setMobileNav(false);
            }}
          >
            <Plus size={17} />새 아이디어<span>N</span>
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
              </button>
            ))}
          </nav>
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
              <p className="muted sidebar-hint">
                아이디어에 태그를 붙여
                <br />
                생각을 가볍게 정리해 보세요.
              </p>
            )}
          </div>
          <div className="sidebar-bottom">
            <div className="small-note">
              <span className="tiny-spark">✦</span>
              <span>
                작은 생각이
                <br />
                <strong>다음 시작이 되도록.</strong>
              </span>
            </div>
            <button
              className="account"
              aria-label="작업 공간 설정"
              onClick={() => setSettings(true)}
            >
              <span className="avatar">
                {store.user?.email?.slice(0, 1).toUpperCase() || "I"}
              </span>
              <span>
                <strong>
                  {store.user?.user_metadata?.full_name ||
                    (store.demo ? "체험 작업 공간" : "나의 작업 공간")}
                </strong>
                <small>
                  {store.user
                    ? "Google 계정 연결됨"
                    : store.demo
                      ? "이 브라우저에만 저장"
                      : "계정을 연결해 시작하세요"}
                </small>
              </span>
              <Settings2 size={16} />
            </button>
          </div>
        </aside>
      )}
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
            <span>내 작업 공간</span>
            <ChevronRight size={13} />
            <strong>
              {tag ? `# ${tag}` : nav.find((i) => i.id === filter)?.label}
            </strong>
          </div>
          <div className="topbar-actions">
            <span className="sync-label">
              <Cloud size={14} />
              {store.demo
                ? "체험 모드"
                : store.user
                  ? "클라우드 연결"
                  : "로그인 필요"}
            </span>
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
          <div className="page-title">
            <div>
              <div className="eyebrow">YOUR IDEAS, A LITTLE CLOSER.</div>
              <h1>
                {tag ? `# ${tag}` : nav.find((i) => i.id === filter)?.label}
                <span>{visible.length}</span>
              </h1>
              <p>떠오른 생각을 담고, 하나씩 현실로 만들어 보세요.</p>
            </div>
            <span className="title-decoration">
              <Lightbulb size={31} strokeWidth={1.25} />
            </span>
          </div>
          {!authenticated && (
            <section className="welcome">
              <Anchor size={25} />
              <div>
                <strong>아이디어가 머무는 나만의 공간</strong>
                <p>
                  Google 계정을 연결하면 모든 기기에서 이어서 기록할 수 있어요.
                </p>
                {!(store.backend === "drive" ? driveConfigured : supabase) && (
                  <small>
                    현재 클라우드 설정이 없습니다. 체험 모드에서 화면과 기능을
                    확인할 수 있습니다.
                  </small>
                )}
              </div>
              <div className="welcome-actions">
                <button className="primary" onClick={login}>
                  Google로 시작하기
                </button>
                <button className="text-button" onClick={store.startDemo}>
                  체험 모드 열기
                </button>
              </div>
            </section>
          )}
          <MigrationPanel
            account={store.backend === "drive" ? store.user?.id : undefined}
            demo={store.demo}
            pending={store.pendingCount}
            onRefresh={store.backend === "drive" ? store.refresh : store.flush}
          />
          <form
            className="quick-add"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Plus size={20} />
            <input
              ref={quickRef}
              aria-label="새 아이디어 제목"
              placeholder="어떤 아이디어가 떠올랐나요?"
              value={quick}
              disabled={!authenticated}
              onChange={(e) => setQuick(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button
              type="submit"
              disabled={!quick.trim() || !authenticated}
              aria-label="아이디어 추가"
            >
              추가 <span>↵</span>
            </button>
          </form>
          <div className="list-tools">
            <div className="search-field">
              <Search size={16} />
              <input
                ref={searchRef}
                aria-label="아이디어 검색"
                placeholder="제목, 내용, 태그 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query ? (
                <button aria-label="검색 지우기" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              ) : (
                <kbd>⌘ K</kbd>
              )}
            </div>
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
          <div className="filter-tabs" aria-label="목록 필터">
            {nav.slice(0, 4).map((n) => (
              <button
                key={n.id}
                className={filter === n.id ? "active" : ""}
                onClick={() => {
                  setFilter(n.id);
                  setTag("");
                }}
              >
                {n.id === "all"
                  ? "전체"
                  : n.id === "completed"
                    ? "완료"
                    : n.id === "pinned"
                      ? "고정"
                      : n.label}
              </button>
            ))}
            {tag && (
              <button onClick={() => setTag("")}>
                #{tag} <X size={12} />
              </button>
            )}
            <span className="list-count">{visible.length}개의 생각</span>
          </div>
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
                서버의 변경 내용과 내 초안을 모두 보존하려면 복사본을 만드세요.
              </p>
              <button onClick={() => void store.resolve(id, true)}>
                내 초안을 복사하고 서버 버전 불러오기
              </button>
              <button onClick={() => void store.resolve(id, false)}>
                서버 버전 사용 · 내 변경 버리기
              </button>
            </div>
          ))}
          {!store.ready ? (
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
                      {idea.plain_text ||
                        "아직 적어둔 메모가 없어요. 생각을 이어가 보세요."}
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
                </article>
              ))}
            </div>
          ) : (
            <div className="empty">
              <div className="empty-icon">
                {query ? (
                  <Search size={30} />
                ) : filter === "completed" ? (
                  <CheckCheck size={30} />
                ) : (
                  <Lightbulb size={30} />
                )}
              </div>
              <h2>
                {query
                  ? "검색 결과가 없어요"
                  : filter === "trash"
                    ? "휴지통이 비어 있어요"
                    : filter === "completed"
                      ? "완성한 아이디어가 여기에 모여요"
                      : "새로운 생각을 위한 빈 공간"}
              </h2>
              <p>
                {query
                  ? "다른 단어나 태그로 다시 찾아보세요."
                  : "거창하지 않아도 괜찮아요. 제목 한 줄로 시작해 보세요."}
              </p>
              {authenticated && filter === "all" && !query && (
                <button
                  className="text-button"
                  onClick={() => quickRef.current?.focus()}
                >
                  <Plus size={15} />첫 아이디어 기록하기
                </button>
              )}
            </div>
          )}
          <footer className="list-footer">
            <span>
              <span className="status-dot" />
              {store.status || "생각이 떠오르는 순간, 기록하세요."}
            </span>
            <span>
              빠른 기록 <kbd>N</kbd> · 검색 <kbd>⌘ K</kbd>
            </span>
          </footer>
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
              status={store.status}
            />
          ) : (
            <div className="detail-placeholder">
              <div className="note-illustration">
                <div className="paper">
                  <Lightbulb size={29} strokeWidth={1.3} />
                  <i />
                  <i />
                  <i />
                </div>
                <span>✦</span>
              </div>
              <h2>생각의 다음 페이지</h2>
              <p>
                아이디어를 선택하면
                <br />
                여기에서 이야기를 이어갈 수 있어요.
              </p>
              <div className="detail-hint">
                <Check size={14} />
                내용은 자동으로 저장됩니다
              </div>
            </div>
          )}
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
                "Google 계정 연결로 기기 간 동기화를 시작하세요."}
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
                    options: { redirectTo: location.origin },
                  });
                  if (result?.error) store.setError(result.error.message);
                }}
              >
                이전 Supabase 계정 연결 · 데이터 조사용
              </button>
            )}
            <button className="settings-button" onClick={backup}>
              현재 데이터 JSON 백업
            </button>
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
            <small>
              IdeaDock v0.1 ·{" "}
              {store.demo
                ? "체험 데이터는 이 브라우저에만 보관됩니다."
                : "개인 아이디어 작업 공간"}
            </small>
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
  status,
}: {
  idea: Idea;
  onChange: (idea: Idea) => void;
  demo: boolean;
  drive: boolean;
  onError: (text: string) => void;
  onZoom: (url: string) => void;
  status: string;
}) {
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
        {!idea.links.length && !linkOpen && (
          <p className="section-empty">
            웹사이트나 GitHub 링크를 연결해 보세요.
          </p>
        )}
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
      <div className="detail-save-status" role="status">
        <Cloud size={14} />
        {status || "작성 내용은 자동으로 저장됩니다."}
      </div>
    </div>
  );
}
