"use client";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type DragEvent,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import {
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  Plus,
  Pin,
  RotateCcw,
  ExternalLink,
} from "lucide-react";
import { type Idea, type Filter, selectIdeas } from "@/lib/model";
import {
  type Folder,
  folderPath,
  folderTrashed,
  makeFolder,
  validateMove,
} from "@/lib/folders";
import type { useFolders } from "@/lib/use-folders";
import IdeaThumbnail from "./idea-thumbnail";

type FolderStore = ReturnType<typeof useFolders>;
const fid = (id: string) => `f:${id}`,
  iid = (id: string) => `i:${id}`;
export function useExplorer({
  ideas,
  folderStore,
  owner,
  filter,
  tag,
  sort,
  onOpen,
  onClear,
  onError,
  onSelection,
  onNavigate,
}: {
  ideas: Idea[];
  folderStore: FolderStore;
  owner?: string;
  filter: Filter;
  tag: string;
  sort: string;
  onOpen: (i: Idea) => void;
  onClear: () => void;
  onError: (s: string) => void;
  onSelection: () => void;
  onNavigate: () => void;
}) {
  const { folders } = folderStore;
  const [folderId, setFolderId] = useState<string | null | undefined>(
      undefined,
    ),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [context, setContext] = useState<{ x: number; y: number } | null>(null),
    [moveOpen, setMoveOpen] = useState(false),
    [target, setTarget] = useState(""),
    [dragging, setDragging] = useState<string[]>([]),
    [over, setOver] = useState<{ id: string | null; valid: boolean } | null>(
      null,
    ),
    [mobileMulti, setMobileMulti] = useState(false);
  const [touchMode, setTouchMode] = useState(false);
  useEffect(() => {
    const media = matchMedia("(pointer: coarse)");
    const check = () => setTouchMode(media.matches);
    check();
    media.addEventListener("change", check);
    return () => media.removeEventListener("change", check);
  }, []);
  const anchor = useRef<string | null>(null),
    longPress = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    touchStart = useRef<{ x: number; y: number } | null>(null),
    suppress = useRef(false),
    hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    dragRef = useRef<string[]>([]),
    hoverId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    setSelected(new Set());
    setMobileMulti(false);
    setFolderId(undefined);
    setContext(null);
  }, [owner]);
  useEffect(() => {
    const pop = () => {
      const id = new URLSearchParams(location.hash.slice(1)).get("idea");
      setSelected(id ? new Set([iid(id)]) : new Set());
      setMobileMulti(false);
    };
    pop();
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    setSelected(new Set());
    setMobileMulti(false);
    setContext(null);
  }, [filter, tag, folderId]);
  useEffect(
    () => () => {
      clearTimeout(longPress.current);
      clearTimeout(hover.current);
    },
    [],
  );
  const trashed = (i: Idea) =>
    !!i.deleted_at || folderTrashed(folders, i.folder_id);
  const visibleIdeas = selectIdeas(
    ideas.map((i) =>
      filter === "trash" && trashed(i) && !i.deleted_at
        ? { ...i, deleted_at: "inherited" }
        : i,
    ),
    filter,
    tag,
    "",
    sort,
  )
    .filter(
      (i) =>
        (filter === "trash" || !trashed(i)) &&
        (folderId === undefined || (i.folder_id ?? null) === folderId),
    )
    .map((i) => ideas.find((v) => v.id === i.id)!);
  // A missing remote folder never makes an idea disappear from the root recovery view.
  if (folderId === null)
    for (const i of ideas)
      if (
        i.folder_id &&
        !folders.some((f) => f.id === i.folder_id) &&
        !i.deleted_at &&
        !visibleIdeas.some((v) => v.id === i.id)
      )
        visibleIdeas.push(i);
  const visibleFolders = folders
    .filter((f) =>
      filter === "trash"
        ? folderTrashed(folders, f.id)
        : folderId !== undefined &&
          !folderTrashed(folders, f.id) &&
          f.parent_id === folderId,
    )
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const order = [
    ...visibleFolders.map((f) => fid(f.id)),
    ...visibleIdeas.map((i) => iid(i.id)),
  ];
  const selectedFolders = folders.filter((f) => selected.has(fid(f.id))),
    selectedIdeas = ideas.filter((i) => selected.has(iid(i.id)));
  function clear() {
    setSelected(new Set());
    setMobileMulti(false);
    setContext(null);
    onClear();
  }
  function navigate(id: string | null | undefined) {
    if (id && folderTrashed(folders, id)) {
      onError("휴지통의 폴더는 복원한 후 열 수 있습니다.");
      return;
    }
    if (id !== undefined) onNavigate();
    setFolderId(id);
    clear();
  }
  function announce(next: Set<string>, forceBulk = false) {
    setSelected(next);
    if (next.size === 1 && !forceBulk) {
      const id = [...next][0];
      const idea = ideas.find((i) => iid(i.id) === id);
      if (idea) {
        onOpen(idea);
        return;
      }
    }
    onClear();
    if (next.size) onSelection();
  }
  function select(
    id: string,
    event: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
    selectionOrder = order,
  ) {
    if (suppress.current) {
      suppress.current = false;
      return;
    }
    let next = new Set<string>();
    if (
      event.shiftKey &&
      anchor.current &&
      selectionOrder.includes(anchor.current) &&
      selectionOrder.includes(id)
    ) {
      const a = selectionOrder.indexOf(anchor.current),
        b = selectionOrder.indexOf(id);
      next = new Set(event.ctrlKey || event.metaKey ? selected : []);
      for (const key of selectionOrder.slice(
        Math.min(a, b),
        Math.max(a, b) + 1,
      ))
        next.add(key);
    } else if (event.ctrlKey || event.metaKey || mobileMulti) {
      next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = id;
    } else {
      next.add(id);
      anchor.current = id;
    }
    announce(next, mobileMulti);
  }
  function attempt(task: () => void) {
    try {
      task();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }
  function createFolder(parent = folderId ?? null) {
    attempt(() => {
      if (!owner) throw new Error("먼저 로그인하세요.");
      if (parent && folderTrashed(folders, parent))
        throw new Error("휴지통 폴더에는 하위 폴더를 만들 수 없습니다.");
      const name = window.prompt("새 폴더 이름", "새 폴더")?.trim();
      if (!name) return;
      const f = makeFolder(name, owner, parent);
      folderStore.updateMany([f]);
      navigate(parent);
      setExpanded(
        (prev) =>
          new Set([...prev, ...folderPath(folders, parent).map((p) => p.id)]),
      );
    });
  }
  function rename() {
    attempt(() => {
      if (selectedIdeas.length === 1 && selected.size === 1) {
        onOpen(selectedIdeas[0]);
        setTimeout(() => {
          const title =
            document.querySelector<HTMLTextAreaElement>(".detail-title");
          title?.focus();
          title?.select();
        }, 0);
        return;
      }
      if (selectedFolders.length !== 1 || selected.size !== 1) return;
      const f = selectedFolders[0],
        name = window.prompt("폴더 이름 변경", f.name)?.trim();
      if (name) folderStore.updateMany([{ ...f, name }]);
    });
  }
  function move(ids: string[], destination: string | null) {
    attempt(() => {
      if (!owner) throw new Error("먼저 로그인하세요.");
      const fs = folders.filter((f) => ids.includes(fid(f.id))),
        is = ideas.filter((i) => ids.includes(iid(i.id)));
      validateMove(
        folders,
        owner,
        fs.map((f) => f.id),
        is,
        destination,
      );
      const top = fs.filter(
        (f) =>
          !folderPath(folders, f.parent_id).some((p) =>
            fs.some((a) => a.id === p.id),
          ),
      );
      folderStore.updateMany(
        top.map((f) => ({ ...f, parent_id: destination })),
      );
      for (const i of is)
        if (
          !folderPath(folders, i.folder_id ?? null).some((f) =>
            top.some((p) => p.id === f.id),
          )
        )
          update({ ...i, folder_id: destination });
      setMoveOpen(false);
      clear();
    });
  }
  // Assigned by Dock: immutable idea updates retain all existing fields.
  const updateRef = useRef<(i: Idea) => void>(() => {});
  const update = (i: Idea) => updateRef.current(i);
  function bulk(
    action: "complete" | "active" | "pin" | "unpin" | "trash" | "restore",
    keys = selected,
    keepSelection = false,
  ) {
    const selected = keys,
      selectedFolders = folders.filter((f) => keys.has(fid(f.id))),
      selectedIdeas = ideas.filter((i) => keys.has(iid(i.id)));
    attempt(() => {
      if (action === "trash") {
        const roots = selectedFolders.filter(
          (f) =>
            !folderPath(folders, f.parent_id).some((p) =>
              selected.has(fid(p.id)),
            ),
        );
        const now = new Date().toISOString();
        if (roots.length)
          folderStore.updateMany(roots.map((f) => ({ ...f, deleted_at: now })));
        for (const i of selectedIdeas)
          if (
            !folderPath(folders, i.folder_id ?? null).some((f) =>
              roots.some((r) => r.id === f.id),
            )
          )
            update({ ...i, deleted_at: now });
        clear();
        return;
      }
      if (action === "restore") {
        const inherited =
          selectedIdeas.some((i) =>
            folderPath(folders, i.folder_id ?? null).some(
              (f) => f.deleted_at && !selected.has(fid(f.id)),
            ),
          ) ||
          selectedFolders.some((f) =>
            folderPath(folders, f.parent_id).some(
              (p) => p.deleted_at && !selected.has(fid(p.id)),
            ),
          );
        if (
          inherited &&
          !window.confirm(
            "상위 휴지통 폴더와 그 안의 다른 항목도 함께 복원됩니다. 계속할까요?",
          )
        )
          return;
        const restore = new Set(
          selectedFolders
            .flatMap((f) => folderPath(folders, f.id).map((p) => p.id))
            .concat(
              selectedIdeas.flatMap((i) =>
                folderPath(folders, i.folder_id ?? null).map((p) => p.id),
              ),
            ),
        );
        const changed = folders
          .filter((f) => restore.has(f.id) && f.deleted_at)
          .map((f) => ({ ...f, deleted_at: null }));
        if (changed.length) folderStore.updateMany(changed);
        for (const i of selectedIdeas)
          if (i.deleted_at) update({ ...i, deleted_at: null });
        if (!keepSelection) clear();
        return;
      }
      for (const i of selectedIdeas)
        update({
          ...i,
          ...(action === "complete" || action === "active"
            ? { is_completed: action === "complete" }
            : { is_pinned: action === "pin" }),
        });
    });
  }
  function keys(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (
      el.isContentEditable ||
      el.closest("input,textarea,select,[contenteditable=true]")
    )
      return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      announce(new Set(order), true);
    } else if (e.key === "Delete" && selected.size) {
      e.preventDefault();
      bulk("trash");
    } else if (
      e.key === "F2" &&
      selectedFolders.length === 1 &&
      selected.size === 1
    ) {
      e.preventDefault();
      rename();
    } else if (
      e.key === "Enter" &&
      selectedFolders.length === 1 &&
      selected.size === 1
    ) {
      e.preventDefault();
      navigate(selectedFolders[0].id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (context) setContext(null);
      else if (moveOpen) setMoveOpen(false);
      else clear();
    }
  }
  function dragStart(e: DragEvent, id: string) {
    const ids = selected.has(id) ? [...selected] : [id];
    if (!selected.has(id)) announce(new Set(ids), true);
    dragRef.current = ids;
    setDragging(ids);
    e.dataTransfer.setData(
      "application/x-ideadock-items",
      JSON.stringify({ owner, ids }),
    );
    e.dataTransfer.effectAllowed = "move";
  }
  function canDrop(id: string | null, ids = dragRef.current) {
    try {
      if (!owner || !ids.length) return false;
      if (
        ids.some(
          (key) =>
            !folders.some((f) => fid(f.id) === key) &&
            !ideas.some((i) => iid(i.id) === key),
        )
      )
        return false;
      validateMove(
        folders,
        owner,
        ids.filter((k) => k.startsWith("f:")).map((k) => k.slice(2)),
        ideas.filter((i) => ids.includes(iid(i.id))),
        id,
      );
      return true;
    } catch {
      return false;
    }
  }
  function dragOver(e: DragEvent, id: string | null) {
    e.stopPropagation();
    const valid = canDrop(id);
    setOver({ id, valid });
    if (valid) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    } else e.dataTransfer.dropEffect = "none";
    const scroll = (e.currentTarget as HTMLElement).closest(
      ".sidebar,.explorer-list",
    ) as HTMLElement | null;
    if (scroll) {
      const r = scroll.getBoundingClientRect();
      if (e.clientY < r.top + 40) scroll.scrollTop -= 20;
      else if (e.clientY > r.bottom - 40) scroll.scrollTop += 20;
    }
    if (hoverId.current !== id) {
      clearTimeout(hover.current);
      hoverId.current = id;
      if (id && valid)
        hover.current = setTimeout(
          () => setExpanded((prev) => new Set([...prev, id])),
          650,
        );
    }
  }
  function dragEnd() {
    dragRef.current = [];
    setDragging([]);
    setOver(null);
    hoverId.current = undefined;
    clearTimeout(hover.current);
  }
  function drop(e: DragEvent, id: string | null) {
    e.preventDefault();
    e.stopPropagation();
    try {
      const data = JSON.parse(
        e.dataTransfer.getData("application/x-ideadock-items"),
      );
      if (
        data.owner !== owner ||
        !Array.isArray(data.ids) ||
        !canDrop(id, data.ids)
      )
        throw new Error("이 위치로 이동할 수 없습니다.");
      move(data.ids, id);
    } catch (err) {
      onError(String(err));
    }
    dragEnd();
  }
  function pointerDown(e: PointerEvent, id: string) {
    if (
      e.pointerType !== "touch" ||
      (e.target as HTMLElement).closest("input,a,.icon-button")
    )
      return;
    touchStart.current = { x: e.clientX, y: e.clientY };
    clearTimeout(longPress.current);
    longPress.current = setTimeout(() => {
      setMobileMulti(true);
      suppress.current = true;
      announce(new Set(selected.size ? selected : [id]), true);
    }, 550);
  }
  function pointerMove(e: PointerEvent) {
    if (
      touchStart.current &&
      Math.hypot(
        e.clientX - touchStart.current.x,
        e.clientY - touchStart.current.y,
      ) > 10
    ) {
      clearTimeout(longPress.current);
      touchStart.current = null;
    }
  }
  function pointerUp() {
    clearTimeout(longPress.current);
    touchStart.current = null;
  }
  function rowProps(id: string) {
    return {
      draggable: filter !== "trash" && !touchMode,
      onDragStart: (e: DragEvent) => dragStart(e, id),
      onDragEnd: dragEnd,
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault();
        if(touchMode)return;
        if (!selected.has(id)) announce(new Set([id]), true);
        setContext({
          x: Math.min(e.clientX, window.innerWidth - 190),
          y: Math.min(e.clientY, window.innerHeight - 320),
        });
      },
      onPointerDown: (e: PointerEvent) => pointerDown(e, id),
      onPointerMove: pointerMove,
      onPointerUp: pointerUp,
      onPointerCancel: pointerUp,
    };
  }
  return {
    folderId,
    navigate,
    folders,
    visibleFolders,
    visibleIdeas,
    selected,
    selectedFolders,
    selectedIdeas,
    expanded,
    setExpanded,
    context,
    setContext,
    moveOpen,
    setMoveOpen,
    target,
    setTarget,
    dragging,
    over,
    select,
    announce,
    clear,
    createFolder,
    rename,
    move,
    bulk,
    keys,
    rowProps,
    dragOver,
    drop,
    updateRef,
    canDrop,
    owner,
    order,
    ready: folderStore.ready,
    selectCreated: (idea: Idea) => {
      setSelected(new Set([iid(idea.id)]));
      onOpen(idea);
    },
    mobileMulti,
    selectedTrashed:
      selectedFolders.some((f) => folderTrashed(folders, f.id)) ||
      selectedIdeas.some(
        (i) => !!i.deleted_at || folderTrashed(folders, i.folder_id),
      ),
    setMobileMulti,
  };
}
export type Explorer = ReturnType<typeof useExplorer>;

export function FolderTree({ e }: { e: Explorer }) {
  const visible = e.folders.filter((f) => !folderTrashed(e.folders, f.id));
  const byParent = new Map<string | null, Folder[]>();
  for (const f of visible) {
    const a = byParent.get(f.parent_id) ?? [];
    a.push(f);
    byParent.set(f.parent_id, a);
  }
  const rows: { f: Folder; depth: number }[] = [],
    stack = (byParent.get(null) ?? [])
      .slice()
      .reverse()
      .map((f) => ({ f, depth: 0 })),
    seen = new Set<string>();
  while (stack.length) {
    const row = stack.pop()!;
    if (seen.has(row.f.id)) continue;
    seen.add(row.f.id);
    rows.push(row);
    if (e.expanded.has(row.f.id))
      stack.push(
        ...(byParent.get(row.f.id) ?? [])
          .slice()
          .reverse()
          .map((f) => ({ f, depth: row.depth + 1 })),
      );
  }
  return (
    <section
      className="folder-tree"
      aria-label="폴더 탐색"
      onKeyDown={e.keys}
      tabIndex={0}
    >
      <div className="folder-tree-heading">
        <span>폴더</span>
        <button
          className="icon-button"
          aria-label="새 폴더 만들기"
          disabled={!e.owner || !e.ready}
          onClick={() => e.createFolder()}
        >
          <Plus size={15} />
        </button>
      </div>
      <button
        className={`nav-item ${e.folderId === null ? "selected" : ""} ${e.over?.id === null ? (e.over.valid ? "drop-valid" : "drop-invalid") : ""}`}
        onClick={() => e.navigate(null)}
        onDragOver={(ev) => e.dragOver(ev, null)}
        onDrop={(ev) => e.drop(ev, null)}
      >
        <FolderOpen size={16} />내 아이디어
      </button>
      {rows.map(({ f, depth }) => (
        <div
          key={f.id}
          className={`folder-tree-row ${e.over?.id === f.id ? (e.over.valid ? "drop-valid" : "drop-invalid") : ""}`}
          style={{ paddingLeft: Math.min(depth, 8) * 10 }}
          {...e.rowProps(fid(f.id))}
          onDragOver={(ev) => e.dragOver(ev, f.id)}
          onDrop={(ev) => e.drop(ev, f.id)}
        >
          <button
            className={`folder-expand ${e.expanded.has(f.id) ? "expanded" : ""}`}
            aria-label={`${f.name} ${e.expanded.has(f.id) ? "접기" : "펼치기"}`}
            aria-expanded={e.expanded.has(f.id)}
            onClick={() =>
              e.setExpanded((prev) => {
                const n = new Set(prev);
                if (n.has(f.id)) n.delete(f.id);
                else n.add(f.id);
                return n;
              })
            }
          >
            <ChevronRight size={13} />
          </button>
          <button
            className={`folder-tree-name ${e.folderId === f.id ? "selected" : ""}`}
            title={folderPath(e.folders, f.id)
              .map((p) => p.name)
              .join(" / ")}
            onClick={(ev) => {
              if (ev.ctrlKey || ev.metaKey || ev.shiftKey)
                e.select(
                  fid(f.id),
                  ev,
                  rows.map((row) => fid(row.f.id)),
                );
              else e.navigate(f.id);
            }}
          >
            <FolderIcon size={15} />
            <span>{f.name}</span>
          </button>
        </div>
      ))}
    </section>
  );
}
export function ExplorerBreadcrumb({ e }: { e: Explorer }) {
  return (
    <nav className="explorer-breadcrumb" aria-label="폴더 경로">
      <button
        onClick={() => e.navigate(null)}
        onDragOver={(ev) => e.dragOver(ev, null)}
        onDrop={(ev) => e.drop(ev, null)}
      >
        내 아이디어
      </button>
      {folderPath(e.folders, e.folderId ?? null).map((f) => (
        <span key={f.id}>
          <ChevronRight size={12} />
          <button
            onClick={() => e.navigate(f.id)}
            onDragOver={(ev) => e.dragOver(ev, f.id)}
            onDrop={(ev) => e.drop(ev, f.id)}
          >
            {f.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

export function ExplorerList({
  e,
  update,
}: {
  e: Explorer;
  update: (i: Idea) => void;
}) {
  const list = useRef<HTMLDivElement>(null),
    gesture = useRef<{
      x: number;
      y: number;
      cx: number;
      cy: number;
      base: Set<string>;
      ctrl: boolean;
    } | null>(null);
  const [rect, setRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const paint = () => {
    const g = gesture.current,
      el = list.current;
    if (!g || !el) return;
    const bounds = el.getBoundingClientRect(),
      x = g.cx - bounds.left + el.scrollLeft,
      y = g.cy - bounds.top + el.scrollTop,
      r = {
        x: Math.min(x, g.x),
        y: Math.min(y, g.y),
        w: Math.abs(x - g.x),
        h: Math.abs(y - g.y),
      };
    if (r.w + r.h < 5) return;
    setRect(r);
    const next = new Set(g.ctrl ? g.base : []);
    for (const row of el.querySelectorAll<HTMLElement>("[data-item-id]")) {
      const b = row.getBoundingClientRect(),
        rx = b.left - bounds.left + el.scrollLeft,
        ry = b.top - bounds.top + el.scrollTop;
      if (
        rx < r.x + r.w &&
        rx + b.width > r.x &&
        ry < r.y + r.h &&
        ry + b.height > r.y
      ) {
        const id = row.dataset.itemId!;
        if (g.ctrl && g.base.has(id)) next.delete(id);
        else next.add(id);
      }
    }
    e.announce(next, true);
  };
  useEffect(() => {
    if (!rect) return;
    const timer = setInterval(() => {
      const el = list.current,
        g = gesture.current;
      if (!el || !g) return;
      const b = el.getBoundingClientRect();
      if (g.cy > b.bottom - 35) el.scrollTop += 12;
      else if (g.cy < b.top + 35) el.scrollTop -= 12;
    }, 40);
    return () => clearInterval(timer);
  }, [!!rect]);
  return (
    <div
      ref={list}
      className="explorer-list"
      role="region"
      aria-label="폴더와 아이디어 목록"
      tabIndex={0}
      onKeyDown={e.keys}
      onScroll={() => {
        if (gesture.current) paint();
      }}
      onPointerDown={(ev) => {
        if (
          ev.button !== 0 ||
          ev.pointerType === "touch" ||
          (ev.target as HTMLElement).closest(
            "[data-item-id],button,input,a,select",
          )
        )
          return;
        list.current?.focus();
        const b = ev.currentTarget.getBoundingClientRect();
        gesture.current = {
          x: ev.clientX - b.left + ev.currentTarget.scrollLeft,
          y: ev.clientY - b.top + ev.currentTarget.scrollTop,
          cx: ev.clientX,
          cy: ev.clientY,
          base: new Set(e.selected),
          ctrl: ev.ctrlKey || ev.metaKey,
        };
        ev.currentTarget.setPointerCapture(ev.pointerId);
        ev.preventDefault();
      }}
      onPointerMove={(ev) => {
        if (gesture.current) {
          gesture.current.cx = ev.clientX;
          gesture.current.cy = ev.clientY;
          paint();
        }
      }}
      onPointerUp={() => {
        if (gesture.current && !rect) e.clear();
        gesture.current = null;
        setRect(null);
      }}
      onPointerCancel={() => {
        gesture.current = null;
        setRect(null);
      }}
    >
      <div className="explorer-items">
        {e.visibleFolders.map((f) => (
          <article
            data-item-id={fid(f.id)}
            key={f.id}
            className={`idea-row folder-list-row ${e.selected.has(fid(f.id)) ? "is-selected" : ""} ${e.over?.id === f.id ? (e.over.valid ? "drop-valid" : "drop-invalid") : ""}`}
            {...e.rowProps(fid(f.id))}
            onDragOver={(ev) => e.dragOver(ev, f.id)}
            onDrop={(ev) => e.drop(ev, f.id)}
          >
            <FolderIcon size={22} />
            <button
              className="idea-summary"
              aria-pressed={e.selected.has(fid(f.id))}
              onClick={(ev) => e.select(fid(f.id), ev)}
              onDoubleClick={() => e.navigate(f.id)}
            >
              <span className="idea-title">{f.name}</span>
            </button>
            {folderTrashed(e.folders, f.id) && (
              <button
                className="icon-button"
                aria-label={`${f.name} 폴더 복원`}
                onClick={() => {
                  e.bulk("restore", new Set([fid(f.id)]));
                }}
              >
                <RotateCcw size={16} />
              </button>
            )}
          </article>
        ))}
        {e.visibleIdeas.map((idea) => (
          <article
            data-item-id={iid(idea.id)}
            key={idea.id}
            className={`idea-row ${e.selected.has(iid(idea.id)) ? "is-selected" : ""}`}
            {...e.rowProps(iid(idea.id))}
          >
            <input
              className="completion-check"
              type="checkbox"
              aria-label={`${idea.title} 완료`}
              checked={idea.is_completed}
              onChange={(ev) =>
                update({ ...idea, is_completed: ev.target.checked })
              }
            />
            <button
              className="idea-summary"
              aria-pressed={e.selected.has(iid(idea.id))}
              onClick={(ev) => e.select(iid(idea.id), ev)}
            >
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
                <span>
                  {new Date(idea.updated_at).toLocaleDateString("ko-KR", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
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
                  aria-label={`${idea.title} 웹사이트 열기`}
                  href={idea.links.find((l) => l.type === "website")!.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={15} />
                </a>
              )}
              {idea.deleted_at || folderTrashed(e.folders, idea.folder_id) ? (
                <button
                  className="icon-button"
                  aria-label={`${idea.title} 복원`}
                  onClick={() => e.bulk("restore", new Set([iid(idea.id)]))}
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
                onOpen={() =>
                  e.select(iid(idea.id), {
                    ctrlKey: false,
                    metaKey: false,
                    shiftKey: false,
                  })
                }
              />
            )}
          </article>
        ))}
        {!e.order.length && (
          <div className="empty">
            <h2>
              {e.folderId !== undefined
                ? "폴더가 비어 있습니다"
                : "아이디어가 없습니다"}
            </h2>
          </div>
        )}
        <div className="explorer-blank" aria-hidden="true" />
        {rect && (
          <div
            className="selection-marquee"
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          />
        )}
      </div>
      {e.dragging.length > 0 && (
        <div className="drag-status" role="status">
          {e.dragging.length}개 이동 중 ·{" "}
          {e.over
            ? e.over.valid
              ? (e.folders.find((f) => f.id === e.over!.id)?.name ??
                "내 아이디어")
              : "이동 불가"
            : "대상 폴더를 선택하세요"}
        </div>
      )}
      {e.context && (
        <div
          className="explorer-context"
          role="menu"
          aria-label="항목 작업"
          style={{ left: e.context.x, top: e.context.y }}
          onKeyDown={e.keys}
        >
          <button
            role="menuitem"
            disabled={e.selected.size !== 1 || e.selectedTrashed}
            onClick={() => {
              if (e.selectedFolders.length === 1)
                e.navigate(e.selectedFolders[0].id);
              else if (e.selectedIdeas.length === 1)
                e.announce(new Set([iid(e.selectedIdeas[0].id)]));
              e.setContext(null);
            }}
          >
            열기
          </button>
          <button
            role="menuitem"
            disabled={e.selected.size !== 1 || e.selectedTrashed}
            onClick={() => {
              e.rename();
              e.setContext(null);
            }}
          >
            이름 변경
          </button>
          <button
            role="menuitem"
            disabled={
              e.selectedFolders.some((f) => folderTrashed(e.folders, f.id)) ||
              e.selectedIdeas.some(
                (i) => i.deleted_at || folderTrashed(e.folders, i.folder_id),
              )
            }
            onClick={() => {
              e.setMoveOpen(true);
              e.setContext(null);
            }}
          >
            이동
          </button>
          <button
            role="menuitem"
            disabled={!e.selectedIdeas.length || e.selectedTrashed}
            onClick={() => {
              e.bulk("complete");
              e.setContext(null);
            }}
          >
            완료 처리
          </button>
          <button
            role="menuitem"
            disabled={!e.selectedIdeas.length || e.selectedTrashed}
            onClick={() => {
              e.bulk("pin");
              e.setContext(null);
            }}
          >
            고정
          </button>
          <button
            role="menuitem"
            onClick={() => {
              e.bulk(e.selectedTrashed ? "restore" : "trash");
              e.setContext(null);
            }}
          >
            {e.selectedTrashed ? "복원" : "삭제"}
          </button>
          <button role="menuitem" onClick={() => e.setContext(null)}>
            닫기
          </button>
        </div>
      )}
    </div>
  );
}
export function ExplorerActions({ e }: { e: Explorer }) {
  const trash =
    e.selectedFolders.some((f) => folderTrashed(e.folders, f.id)) ||
    e.selectedIdeas.some(
      (i) => i.deleted_at || folderTrashed(e.folders, i.folder_id),
    );
  return (
    <div className="explorer-actions" onKeyDown={e.keys}>
      <h2>{e.selected.size}개 선택됨</h2>
      <button onClick={() => e.clear()}>선택 해제</button>
      {e.selectedFolders.length === 1 && e.selected.size === 1 && (
        <>
          <button
            disabled={trash}
            onClick={() => e.navigate(e.selectedFolders[0].id)}
          >
            폴더 열기
          </button>
          <button disabled={trash} onClick={e.rename}>
            이름 변경
          </button>
          <button
            disabled={trash}
            onClick={() => e.createFolder(e.selectedFolders[0].id)}
          >
            하위 폴더 만들기
          </button>
        </>
      )}
      <button disabled={trash} onClick={() => e.setMoveOpen(true)}>
        이동
      </button>
      {e.moveOpen && (
        <>
          <select
            aria-label="이동할 폴더"
            value={e.target}
            onChange={(ev) => e.setTarget(ev.target.value)}
          >
            <option value="">내 아이디어 (루트)</option>
            {e.folders
              .filter((f) => e.canDrop(f.id, [...e.selected]))
              .map((f) => (
                <option value={f.id} key={f.id}>
                  {folderPath(e.folders, f.id)
                    .map((p) => p.name)
                    .join(" / ")}
                </option>
              ))}
          </select>
          <button
            className="primary"
            onClick={() => e.move([...e.selected], e.target || null)}
          >
            선택 항목 이동
          </button>
        </>
      )}
      <button
        disabled={!e.selectedIdeas.length || trash}
        onClick={() => e.bulk("complete")}
      >
        완료 처리
      </button>
      <button
        disabled={!e.selectedIdeas.length || trash}
        onClick={() => e.bulk("active")}
      >
        미완료 처리
      </button>
      <button
        disabled={!e.selectedIdeas.length || trash}
        onClick={() => e.bulk("pin")}
      >
        고정
      </button>
      <button
        disabled={!e.selectedIdeas.length || trash}
        onClick={() => e.bulk("unpin")}
      >
        고정 해제
      </button>
      {trash ? (
        <button onClick={() => e.bulk("restore")}>선택 항목 복원</button>
      ) : (
        <button onClick={() => e.bulk("trash")}>휴지통으로 이동</button>
      )}
    </div>
  );
}
