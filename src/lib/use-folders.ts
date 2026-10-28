"use client";
import { useEffect, useRef, useState } from "react";
import {
  activeDriveRepository,
  DriveAuthError,
  driveCacheKey,
  driveSessionAccount,
  subscribeDriveSession,
} from "./drive";
import { FolderRepository } from "./folder-repository";
import { type Folder, validateFolders } from "./folders";
import { canonical, digest } from "./integrity";
import { localDb } from "./local-db";
import { registerFolderWrites } from "./folder-sync-gate";

type Pending = { folder: Folder; parent: string | null; seq: number };
type Cache = {
  folders: Folder[];
  pending: Record<string, Pending>;
  heads: Record<string, string>;
};
const empty = (): Cache => ({ folders: [], pending: {}, heads: {} });
export const demoFolderKey = "ideadock:folders:demo:v2";
export function useFolders(account: string | undefined) {
  const [folders, setFolders] = useState<Folder[]>([]),
    [error, setError] = useState(""),
    [conflicts, setConflicts] = useState<string[]>([]),
    [ready, setReady] = useState(false),
    [pendingCount, setPendingCount] = useState(0);
  const cache = useRef(empty()),
    owner = useRef(account),
    generation = useRef(0),
    busy = useRef(false),
    initialized = useRef(false),
    sequence = useRef(0),
    disk = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const syncRef = useRef<() => Promise<void>>(async () => {});
  const idleWaiters = useRef<(() => void)[]>([]);
  function publish() {
    setFolders([...cache.current.folders]);
    setPendingCount(Object.keys(cache.current.pending).length);
  }
  async function persist() {
    const who = owner.current;
    if (!who || !initialized.current)
      throw new Error("폴더 저장소를 준비 중입니다.");
    const value = structuredClone(cache.current);
    if (who === "demo")
      localStorage.setItem(demoFolderKey, JSON.stringify(value));
    else {
      disk.current = disk.current
        .catch(() => {})
        .then(() => localDb.set(`${driveCacheKey(who)}:folders:v2`, value));
      await disk.current;
    }
  }
  async function refresh() {
    const epoch = generation.current,
      seq = sequence.current;
    if (
      !owner.current ||
      owner.current === "demo" ||
      !initialized.current ||
      busy.current ||
      driveSessionAccount() !== owner.current
    )
      return;
    const active = activeDriveRepository();
    if (active.account !== owner.current)
      throw new Error("폴더 동기화 계정이 변경되었습니다.");
    const rows = await new FolderRepository(active).list();
    if (epoch !== generation.current || seq !== sequence.current) return;
    const next = rows.map(
      (r) => cache.current.pending[r.folder.id]?.folder ?? r.folder,
    );
    for (const p of Object.values(cache.current.pending))
      if (!next.some((f) => f.id === p.folder.id)) next.push(p.folder);
    const collision = rows
      .filter(
        (r) =>
          r.conflicts.length ||
          (cache.current.pending[r.folder.id] &&
            cache.current.pending[r.folder.id].parent !== r.head),
      )
      .map((r) => r.folder.id);
    setConflicts(collision);
    try {
      validateFolders(next);
    } catch {
      setConflicts([...new Set([...collision, ...next.map((f) => f.id)])]);
      throw new Error(
        "다른 기기의 폴더 계층이 충돌합니다. 루트 복구로 원본을 보존하세요.",
      );
    }
    for (const r of rows)
      if (!cache.current.pending[r.folder.id])
        cache.current.heads[r.folder.id] = r.head;
    cache.current.folders = next;
    publish();
    await persist();
  }
  async function flush() {
    if (busy.current) {
      await new Promise<void>((resolve) => idleWaiters.current.push(resolve));
      return;
    }
    if (!initialized.current || !owner.current) return;
    if (owner.current === "demo" || driveSessionAccount() !== owner.current) {
      // Without a Drive token, folder drafts wait on the device.
      await persist();
      return;
    }
    const epoch = generation.current;
    busy.current = true;
    try {
      await persist();
      const repo = new FolderRepository(activeDriveRepository());
      if (repo.ideas.account !== owner.current)
        throw new Error("폴더 동기화 계정이 변경되었습니다.");
      // Parents must reach the server before their new children.
      const pending = Object.values(cache.current.pending);
      const depth = (f: Folder) => {
        let n = 0,
          p = f.parent_id;
        const seen = new Set<string>();
        while (p && !seen.has(p)) {
          seen.add(p);
          n++;
          p = cache.current.folders.find((x) => x.id === p)?.parent_id ?? null;
        }
        return n;
      };
      pending.sort((a, b) => depth(a.folder) - depth(b.folder));
      for (const p of pending) {
        if (epoch !== generation.current) return;
        const saved = await repo.save(p.folder, p.parent);
        if (epoch !== generation.current) return;
        const latest = cache.current.pending[p.folder.id];
        cache.current.heads[p.folder.id] = saved.head;
        if (latest?.seq === p.seq) {
          delete cache.current.pending[p.folder.id];
          cache.current.folders = cache.current.folders.map((f) =>
            f.id === saved.folder.id ? saved.folder : f,
          );
        } else if (latest) {
          latest.parent = saved.head;
          latest.folder.version = saved.folder.version;
        }
        publish();
        await persist();
      }
      setError("");
    } catch (e) {
      if (epoch === generation.current && !(e instanceof DriveAuthError)) {
        setError(
          e instanceof Error
            ? e.message === "VERSION_CONFLICT"
              ? "폴더 동시 편집 충돌: 루트 복구 후 다시 시도하세요."
              : e.message
            : String(e),
        );
        if (
          e instanceof Error &&
          /VERSION_CONFLICT|순환|상위 폴더/.test(e.message)
        )
          setConflicts((prev) => [
            ...new Set([...prev, ...Object.keys(cache.current.pending)]),
          ]);
      }
    } finally {
      if (epoch === generation.current) {
        busy.current = false;
        idleWaiters.current.splice(0).forEach((resolve) => resolve());
      }
    }
  }
  syncRef.current = async () => {
    await flush();
    await refresh();
  };
  useEffect(() => {
    const epoch = ++generation.current;
    owner.current = account;
    initialized.current = false;
    busy.current = false;
    cache.current = empty();
    setConflicts([]);
    setError("");
    setReady(false);
    publish();
    if (timer.current) clearTimeout(timer.current);
    if (!account) {
      setReady(true);
      return;
    }
    const loading = (async () => {
      try {
        const value =
          account === "demo"
            ? JSON.parse(localStorage.getItem(demoFolderKey) || "null")
            : await localDb.get<Cache>(`${driveCacheKey(account)}:folders:v2`);
        if (epoch !== generation.current) return;
        if (value) {
          validateFolders(value.folders);
          if (value.folders.some((f: Folder) => f.user_id !== account))
            throw new Error("폴더 캐시 계정 불일치");
          cache.current = {
            ...value,
            pending: value.pending ?? {},
            heads: value.heads ?? {},
          };
          for (const p of Object.values(cache.current.pending))
            if (p.folder.user_id !== account)
              throw new Error("폴더 초안 계정 불일치");
          sequence.current = Math.max(
            0,
            ...Object.values(cache.current.pending).map((p) => p.seq),
          );
        }
        initialized.current = true;
        publish();
        setReady(true);
        await syncRef.current();
      } catch (e) {
        if (epoch === generation.current) setError(String(e));
      }
    })();
    const unregister = registerFolderWrites(account, async () => {
      await loading;
      if (owner.current !== account || generation.current !== epoch)
        throw new Error("폴더 저장 계정이 변경되었습니다.");
      await flush();
      if (!initialized.current || Object.keys(cache.current.pending).length)
        throw new Error(
          "폴더 변경을 먼저 동기화하세요. 아이디어 초안은 보존됩니다.",
        );
    });
    return () => {
      unregister();
      idleWaiters.current.splice(0).forEach((resolve) => resolve());
      generation.current++;
    };
  }, [account]);
  useEffect(() => {
    const run = () =>
      void syncRef.current().catch((e) => {
        if (!(e instanceof DriveAuthError)) setError(String(e));
      });
    // Sync as soon as a reconnect delivers a token for this workspace.
    const unsubscribe = subscribeDriveSession(() => {
      if (owner.current && driveSessionAccount() === owner.current) run();
    });
    const leave = (e: BeforeUnloadEvent) => {
      if (
        owner.current !== "demo" &&
        Object.keys(cache.current.pending).length
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const interval = setInterval(run, 15000);
    window.addEventListener("online", run);
    window.addEventListener("beforeunload", leave);
    return () => {
      unsubscribe();
      clearInterval(interval);
      window.removeEventListener("online", run);
      window.removeEventListener("beforeunload", leave);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  function updateMany(values: Folder[]) {
    if (!initialized.current || !owner.current)
      throw new Error("폴더 저장소가 준비되지 않았습니다.");
    if (values.some((f) => f.user_id !== owner.current))
      throw new Error("다른 계정의 폴더입니다.");
    const previous = structuredClone(cache.current);
    const next = cache.current.folders
      .filter((f) => !values.some((v) => v.id === f.id))
      .concat(values);
    validateFolders(next);
    for (const f of values) {
      const value = { ...f, updated_at: new Date().toISOString() };
      cache.current.pending[f.id] = {
        folder: value,
        parent:
          cache.current.pending[f.id]?.parent ??
          cache.current.heads[f.id] ??
          null,
        seq: ++sequence.current,
      };
    }
    cache.current.folders = next.map(
      (f) => cache.current.pending[f.id]?.folder ?? f,
    );
    publish();
    // Demo durability is synchronous; do not overwrite a corrupt source cache.
    if (owner.current === "demo") {
      try {
        localStorage.setItem(demoFolderKey, JSON.stringify(cache.current));
      } catch (e) {
        cache.current = previous;
        publish();
        throw e;
      }
    } else void persist().catch((e) => setError(String(e)));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => void syncRef.current().catch((e) => setError(String(e))),
      700,
    );
  }
  async function resolve(id: string) {
    if (owner.current === "demo" || !owner.current) return;
    const epoch = generation.current,
      repo = new FolderRepository(activeDriveRepository());
    if (repo.ideas.account !== owner.current)
      throw new Error("폴더 복구 계정이 변경되었습니다.");
    const rows = await repo.list();
    if (epoch !== generation.current) return;
    const row = rows.find((r) => r.folder.id === id);
    if (!row) return;
    const local = cache.current.folders.find((f) => f.id === id);
    const alternatives = [
      ...row.conflicts.map((r) => r.folder),
      ...(local ? [local] : []),
    ];
    const copies: Folder[] = [];
    for (const f of alternatives)
      if (
        canonical(f) !== canonical(row.folder) &&
        !copies.some((c) => c.name === `${f.name} (보존한 폴더)`)
      )
        copies.push({
          ...f,
          id: crypto.randomUUID(),
          name: `${f.name} (보존한 폴더)`,
          parent_id: null,
          version: 0,
        });
    const restored = {
      ...row.folder,
      parent_id: null,
      version: row.folder.version + 1,
    };
    // Explicit root repair cannot introduce a parent cycle, even when two
    // independent concurrent moves created more than one invalid component.
    const merged = await Promise.all(
      row.conflicts.map((r) => digest(canonical(r))),
    );
    const saved = {
      folder: restored,
      head: await repo.append(restored, row.head, merged),
    };
    if (epoch !== generation.current) return;
    delete cache.current.pending[id];
    cache.current.heads[id] = saved.head;
    cache.current.folders = cache.current.folders
      .filter((f) => f.id !== id)
      .concat(saved.folder);
    publish();
    await persist();
    if (copies.length) updateMany(copies);
    setConflicts((prev) => prev.filter((x) => x !== id));
    await syncRef.current();
  }
  return {
    folders,
    error,
    ready,
    pendingCount,
    conflicts,
    updateMany,
    flush,
    refresh,
    resolve,
    persist,
  };
}
