"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Idea, makeIdea } from "./model";
import { validateIdeas } from "./integrity";
import { localDb } from "./local-db";
import {
  connectDrive,
  disconnectDrive,
  DriveAuthError,
  DriveRepository,
  driveRepositoryFor,
  driveSessionAccount,
  forgetDriveUser,
  GoogleUser,
  loadGoogle,
  driveConfigured,
  driveCacheKey,
  rememberDriveUser,
  rememberedDriveUser,
  Revision,
  subscribeDriveSession,
} from "./drive";
import { useLegacyIdeas } from "./use-legacy-ideas";
import { waitForFolderWrites } from "./folder-sync-gate";
import { afterPaint } from "./paint";

type Pending = { idea: Idea; parent: string | null; seq: number };
type Cache = {
  ideas: Idea[];
  pending: Record<string, Pending>;
  heads: Record<string, string>;
};
/** Account id holding a usable Drive token; null while a reconnect is needed. */
export function useDriveSession() {
  return useSyncExternalStore(
    subscribeDriveSession,
    driveSessionAccount,
    () => null,
  );
}
export function useDriveIdeas() {
  const [user, setUser] = useState<GoogleUser | null>(null);
  const [restored, setRestored] = useState(false);
  const [demo, setDemo] = useState(false);
  const session = useDriveSession();
  const connected = !!user && session === user.id;
  const linked = useRef(connected);
  linked.current = connected;
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [conflicts, setConflicts] = useState<string[]>([]);
  const owner = useRef<string | null>(null);
  const cache = useRef<Cache>({ ideas: [], pending: {}, heads: {} });
  const repo = useRef<DriveRepository | null>(null);
  // The rows last applied to the screen, so an unchanged remote costs nothing.
  const applied = useRef<{ rows: unknown; revision: number } | null>(null);
  const cycle = useRef<Promise<void> | null>(null),
    again = useRef(false);
  const epoch = useRef(0),
    revision = useRef(0),
    seq = useRef(0);
  const busy = useRef(false),
    initialized = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disk = useRef(Promise.resolve());
  const branches = useRef<Record<string, Revision[]>>({});
  const idleWaiters = useRef<(() => void)[]>([]);
  const publish = useCallback(() => {
    revision.current++;
    setIdeas([...cache.current.ideas]);
  }, []);
  const persist = useCallback(async () => {
    const account = owner.current;
    if (!account || !initialized.current) return;
    const snapshot = structuredClone(cache.current);
    if (account === "demo") {
      // Keep the established demo format readable by the old release.
      localStorage.setItem("ideadock:data:demo", JSON.stringify(snapshot));
    } else {
      disk.current = disk.current
        .catch(() => {})
        .then(() => localDb.set(driveCacheKey(account), snapshot));
      await disk.current;
    }
  }, []);
  const report = useCallback((e: unknown) => {
    // The reconnect banner covers a missing token; drafts stay on the device.
    if (e instanceof DriveAuthError) setStatus("Drive 재연결 필요");
    else setError(e instanceof Error ? e.message : String(e));
  }, []);
  const refresh = useCallback(async () => {
    if (busy.current)
      await new Promise<void>((resolve) => idleWaiters.current.push(resolve));
    if (!repo.current || !initialized.current || !linked.current) return;
    const generation = epoch.current,
      started = revision.current,
      account = owner.current;
    const rows = await repo.current.list();
    if (
      epoch.current !== generation ||
      revision.current !== started ||
      account !== owner.current
    )
      return;
    // Same revisions as last time and nothing edited since: skip the rebuild,
    // the re-render and the full IndexedDB snapshot write.
    if (
      applied.current?.rows === rows &&
      applied.current.revision === revision.current
    )
      return;
    const pending = cache.current.pending;
    const next: Idea[] = rows.map((r) => pending[r.idea.id]?.idea ?? r.idea);
    for (const p of Object.values(pending))
      if (!next.some((i) => i.id === p.idea.id)) next.push(p.idea);
    for (const row of rows) {
      if (!pending[row.idea.id]) cache.current.heads[row.idea.id] = row.head;
      if (row.conflicts.length) branches.current[row.idea.id] = row.conflicts;
    }
    setConflicts([
      ...new Set([
        ...Object.keys(branches.current),
        ...rows
          .filter(
            (r) => pending[r.idea.id] && pending[r.idea.id].parent !== r.head,
          )
          .map((r) => r.idea.id),
      ]),
    ]);
    cache.current.ideas = next;
    publish();
    applied.current = { rows, revision: revision.current };
    await persist();
  }, [persist, publish]);
  const flush = useCallback(async () => {
    if (busy.current) {
      await new Promise<void>((resolve) => idleWaiters.current.push(resolve));
      return;
    }
    if (!owner.current || !initialized.current) return;
    if (owner.current === "demo") {
      try {
        await persist();
        setStatus("이 브라우저에 저장됨");
      } catch (e) {
        report(e);
      }
      return;
    }
    if (!repo.current) return;
    if (!linked.current) {
      try {
        await persist();
        if (Object.keys(cache.current.pending).length)
          setStatus("Drive 재연결 필요");
      } catch (e) {
        report(e);
      }
      return;
    }
    busy.current = true;
    const generation = epoch.current;
    try {
      await persist(); // Never send a draft before durable local storage succeeds.
      await waitForFolderWrites(owner.current!);
      if (epoch.current !== generation) return;
      for (const [id, p] of Object.entries(cache.current.pending)) {
        if (epoch.current !== generation) break;
        setStatus("Drive에 저장 중…");
        try {
          const saved = await repo.current.save(p.idea, p.parent);
          if (epoch.current !== generation) break;
          const current = cache.current.pending[id];
          cache.current.heads[id] = saved.head;
          if (current?.seq === p.seq) {
            delete cache.current.pending[id];
            cache.current.ideas = cache.current.ideas.map((i) =>
              i.id === id ? saved.idea : i,
            );
          } else if (current) {
            current.parent = saved.head;
            current.idea = { ...current.idea, version: saved.idea.version };
            cache.current.ideas = cache.current.ideas.map((i) =>
              i.id === id ? current.idea : i,
            );
          }
          publish();
          await persist();
        } catch (e) {
          if (epoch.current !== generation) break;
          if (e instanceof Error && e.message === "VERSION_CONFLICT") {
            setConflicts((prev) => [...new Set([...prev, id])]);
            setError(
              "다른 기기의 변경 내용이 있습니다. 서버 버전과 내 초안을 확인해 주세요.",
            );
          } else if (e instanceof DriveAuthError) {
            report(e);
            return;
          } else report(e);
          setStatus("초안 보관됨 · 재시도 필요");
          return;
        }
      }
      if (epoch.current === generation) {
        setStatus(
          Object.keys(cache.current.pending).length
            ? "변경 내용 대기 중"
            : "Google Drive에 저장됨",
        );
        setError("");
      }
    } catch (e) {
      if (epoch.current === generation) report(e);
    } finally {
      if (epoch.current === generation) {
        busy.current = false;
        idleWaiters.current.splice(0).forEach((resolve) => resolve());
      }
    }
  }, [persist, publish, report]);
  useEffect(() => {
    if (driveConfigured) void loadGoogle().catch(report);
  }, [report]);
  useEffect(() => {
    // Reopen the last workspace from its device cache; Drive reconnects on
    // demand. Runs after hydration because storage is browser-only.
    const remembered = rememberedDriveUser();
    if (remembered) setUser((prev) => prev ?? remembered);
    setRestored(true);
  }, []);
  useEffect(() => {
    if (user) rememberDriveUser(user);
  }, [user]);
  // One sync at a time: callers that arrive meanwhile share it and ask for one
  // more pass, instead of each downloading the same revisions in parallel.
  const sync = useCallback((): Promise<void> => {
    if (cycle.current) {
      again.current = true;
      return cycle.current;
    }
    const run = (async () => {
      try {
        do {
          again.current = false;
          await flush();
          await refresh();
        } while (again.current);
      } finally {
        // Cleared in the same tick the loop decides to stop: a caller arriving
        // later starts a new cycle instead of joining one that is finishing and
        // whose extra pass would never run.
        cycle.current = null;
      }
    })();
    cycle.current = run;
    return run;
  }, [flush, refresh]);
  useEffect(() => {
    if (connected) void sync().catch(report);
  }, [connected, sync, report]);
  useEffect(() => {
    const account = demo ? "demo" : (user?.id ?? null);
    const generation = ++epoch.current;
    busy.current = false;
    idleWaiters.current.splice(0).forEach((resolve) => resolve());
    owner.current = account;
    initialized.current = false;
    cache.current = { ideas: [], pending: {}, heads: {} };
    branches.current = {};
    applied.current = null;
    setConflicts([]);
    publish();
    setError("");
    setStatus("");
    repo.current =
      account && account !== "demo" ? driveRepositoryFor(account) : null;
    if (!account) return;
    void (async () => {
      try {
        const cached =
          account === "demo"
            ? JSON.parse(localStorage.getItem("ideadock:data:demo") || "null")
            : await localDb.get<Cache>(driveCacheKey(account));
        if (epoch.current !== generation) return;
        if (cached) {
          validateIdeas(cached.ideas);
          cache.current = {
            ...cached,
            pending: cached.pending ?? {},
            heads: cached.heads ?? {},
          };
          for (const p of Object.values(cache.current.pending))
            validateIdeas([p.idea]);
          seq.current = Math.max(
            0,
            ...Object.values(cache.current.pending).map((p) => p.seq),
          );
          publish();
        }
        initialized.current = true;
        if (account === "demo") setStatus("체험 모드 · 이 브라우저에만 저장");
        else {
          // Show the cached list first; verification and Drive follow.
          await afterPaint();
          if (epoch.current !== generation) return;
          await sync();
        }
      } catch (e) {
        if (epoch.current === generation) report(e);
      }
    })();
  }, [user?.id, demo, sync, publish, report]);
  useEffect(() => {
    // A hidden tab neither polls nor competes with the visible one; it catches
    // up as soon as it is shown again.
    const run = () => {
      if (!document.hidden) void sync().catch(report);
    };
    const interval = setInterval(run, 15000);
    const leave = (event: BeforeUnloadEvent) => {
      if (
        owner.current !== "demo" &&
        Object.keys(cache.current.pending).length
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", run);
    window.addEventListener("beforeunload", leave);
    return () => {
      clearInterval(interval);
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener("online", run);
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("beforeunload", leave);
    };
  }, [sync, report]);
  const update = useCallback(
    (idea: Idea) => {
      if (
        !initialized.current ||
        !owner.current ||
        idea.user_id !== owner.current
      )
        return;
      const next = { ...idea, updated_at: new Date().toISOString() };
      const parent =
        cache.current.pending[idea.id]?.parent ??
        cache.current.heads[idea.id] ??
        null;
      cache.current.pending[idea.id] = {
        idea: next,
        parent,
        seq: ++seq.current,
      };
      cache.current.ideas = cache.current.ideas.some((i) => i.id === next.id)
        ? cache.current.ideas.map((i) => (i.id === next.id ? next : i))
        : [next, ...cache.current.ideas];
      publish();
      void persist()
        .then(() =>
          setStatus(
            owner.current === "demo"
              ? "이 브라우저에 저장됨"
              : "기기에 초안 저장됨",
          ),
        )
        .catch(report);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 700);
    },
    [persist, flush, publish, report],
  );
  async function resolve(id: string, keepLocal: boolean) {
    if (!repo.current) return;
    const generation = epoch.current;
    try {
      const rows = await repo.current.list();
      if (epoch.current !== generation) return;
      const row = rows.find((r) => r.idea.id === id);
      const local = cache.current.ideas.find((i) => i.id === id);
      if (keepLocal && local) {
        const copy = {
          ...structuredClone(local),
          id: crypto.randomUUID(),
          title: `${local.title} (내 초안)`,
          version: 0,
          created_at: new Date().toISOString(),
        };
        update(copy);
      }
      // Sibling revisions stay on Drive. Keep each alternative as an explicit
      // new idea when resolving, so a remote concurrent draft is never hidden.
      if (row?.conflicts.length) {
        for (const branch of row.conflicts.slice(1))
          update({
            ...branch.idea,
            id: crypto.randomUUID(),
            title: `${branch.idea.title} (다른 기기 초안)`,
            version: 0,
          });
        await persist();
        // Append a joining revision acknowledging ALL siblings (see repository).
        await repo.current.join(row);
        if (epoch.current !== generation) return;
      }
      delete cache.current.pending[id];
      delete branches.current[id];
      cache.current.ideas = cache.current.ideas
        .filter((i) => i.id !== id)
        .concat(row ? [row.idea] : []);
      if (row) cache.current.heads[id] = row.head;
      setConflicts((prev) => prev.filter((key) => key !== id));
      publish();
      await persist();
      await refresh();
    } catch (e) {
      report(e);
    }
  }
  return {
    backend: "drive" as const,
    user,
    demo,
    connected,
    ready: restored,
    ideas,
    status,
    error,
    setError,
    conflicts,
    update,
    flush,
    refresh,
    resolve,
    create: (title: string) => {
      if (!owner.current || !initialized.current || !title.trim()) return;
      const idea = makeIdea(title, owner.current);
      update(idea);
      return idea;
    },
    login: async (additionalPending = false, switchAccount = false) => {
      const hint = !demo && !switchAccount && user ? { hint: user } : {};
      if (
        !demo &&
        (Object.keys(cache.current.pending).length || additionalPending) &&
        user
      ) {
        if (switchAccount)
          throw new Error(
            "미저장 초안이 있어 계정을 전환할 수 없습니다. 먼저 저장하거나 백업하세요.",
          );
        // Reauthorization is allowed, but account switching with drafts is not.
        const next = await connectDrive(hint);
        if (next.id !== user.id) {
          disconnectDrive();
          throw new Error(
            "미저장 초안이 있습니다. 원래 계정으로 다시 연결한 후 저장하세요.",
          );
        }
        await sync();
        return;
      }
      await persist();
      const next = await connectDrive(hint);
      if (next.id === user?.id && !demo) {
        await sync();
      } else {
        setDemo(false);
        setUser(next);
      }
    },
    signOut: async () => {
      if (!demo && Object.keys(cache.current.pending).length) {
        setError(
          "Drive에 저장되지 않은 초안이 있습니다. 저장 또는 백업 후 로그아웃하세요.",
        );
        return;
      }
      await persist();
      if (!demo) forgetDriveUser();
      setUser(null);
      setDemo(false);
    },
    startDemo: () => setDemo(true),
    pendingCount: Object.keys(cache.current.pending).length,
  };
}
// Explicit rollback switch. Both implementations remain available until live
// migration and multi-device acceptance checks have been completed.
export const useIdeas =
  process.env.NEXT_PUBLIC_STORAGE_BACKEND === "legacy"
    ? useLegacyIdeas
    : useDriveIdeas;
