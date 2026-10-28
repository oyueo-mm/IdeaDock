// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  afterAll,
  beforeEach,
  it,
  expect,
  vi,
} from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { MemoryDb, MemoryRemote } from "./support/memory";
import { DriveRepository, driveCacheKey } from "../src/lib/drive";
import { makeFolder } from "../src/lib/folders";
import { FolderRepository } from "../src/lib/folder-repository";
const state = vi.hoisted(() => ({ repo: null as DriveRepository | null }));
vi.mock("../src/lib/drive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/drive")>()),
  activeDriveRepository: () => {
    if (!state.repo) throw new Error("not connected");
    return state.repo;
  },
  driveSessionAccount: () => state.repo?.account ?? null,
}));
vi.mock("../src/lib/paint", () => ({ afterPaint: async () => {} }));
vi.mock("../src/lib/local-db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/local-db")>();
  return {
    ...original,
    localDb: {
      get: async (key: string) => state.repo?.db.get(key),
      set: async (key: string, value: unknown) =>
        state.repo?.db.set(key, value),
    },
  };
});
import { useFolders, demoFolderKey } from "../src/lib/use-folders";
beforeAll(() => {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("crypto", webcrypto);
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  localStorage.clear();
  state.repo = new DriveRepository("alice", new MemoryRemote(), new MemoryDb());
});
afterEach(() => cleanup());
it("repairs a concurrent parent cycle explicitly while retaining immutable history", async () => {
  const repo = state.repo!,
    remote = new FolderRepository(repo),
    a = makeFolder("A", "alice", null),
    b = makeFolder("B", "alice", null);
  const ar = await remote.save(a, null),
    br = await remote.save(b, null);
  const h = renderHook(() => useFolders("alice"));
  await waitFor(() => expect(h.result.current.folders).toHaveLength(2));
  await remote.append({ ...ar.folder, parent_id: b.id }, ar.head);
  await remote.append({ ...br.folder, parent_id: a.id }, br.head);
  await act(async () => {
    await expect(h.result.current.refresh()).rejects.toThrow("계층");
  });
  expect(h.result.current.conflicts.length).toBe(2);
  await act(async () => h.result.current.resolve(a.id));
  expect(
    h.result.current.folders.find((f) => f.id === a.id)?.parent_id,
  ).toBeNull();
  expect(h.result.current.folders.find((f) => f.id === b.id)?.parent_id).toBe(
    a.id,
  );
  expect((await remote.revisions()).length).toBeGreaterThanOrEqual(5);
});
it("stores offline folder changes durably and retries after reconnection", async () => {
  const repo = state.repo!,
    remote = repo.remote as MemoryRemote;
  const h = renderHook(() => useFolders("alice"));
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  remote.failAt = 1;
  act(() =>
    h.result.current.updateMany([makeFolder("offline", "alice", null)]),
  );
  await act(async () => h.result.current.flush());
  expect(h.result.current.pendingCount).toBe(1);
  expect(
    await repo.db.get(`${driveCacheKey("alice")}:folders:v2`),
  ).toMatchObject({ folders: [{ name: "offline" }] });
  expect(h.result.current.conflicts).toEqual([]);
  remote.failAt = 0;
  await act(async () => h.result.current.flush());
  expect(h.result.current.pendingCount).toBe(0);
  expect(h.result.current.folders[0].name).toBe("offline");
});
it("preserves a corrupt original demo cache and refuses new writes", async () => {
  const raw = "{broken original";
  localStorage.setItem(demoFolderKey, raw);
  const h = renderHook(() => useFolders("demo"));
  await waitFor(() => expect(h.result.current.error).not.toBe(""));
  expect(() =>
    h.result.current.updateMany([makeFolder("x", "demo", null)]),
  ).toThrow();
  expect(localStorage.getItem(demoFolderKey)).toBe(raw);
});
it("switches folder namespaces and does not leak a previous account draft", async () => {
  const a = state.repo!;
  const h = renderHook(({ owner }) => useFolders(owner), {
    initialProps: { owner: "alice" },
  });
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  act(() => h.result.current.updateMany([makeFolder("Alice", "alice", null)]));
  await act(async () => h.result.current.flush());
  const b = new DriveRepository("bob", new MemoryRemote(), new MemoryDb());
  state.repo = b;
  h.rerender({ owner: "bob" });
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  expect(h.result.current.folders).toHaveLength(0);
  expect(() =>
    h.result.current.updateMany([makeFolder("wrong", "alice", null)]),
  ).toThrow("계정");
  expect(await a.db.get(`${driveCacheKey("alice")}:folders:v2`)).toMatchObject({
    folders: [{ name: "Alice" }],
  });
});
it("retains a newer edit while an older folder save is awaiting the network", async () => {
  const remote = state.repo!.remote as MemoryRemote,
    h = renderHook(() => useFolders("alice"));
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  const f = makeFolder("first", "alice", null);
  act(() => h.result.current.updateMany([f]));
  const original = remote.create.bind(remote);
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  remote.create = async (...args) => {
    await blocked;
    return original(...args);
  };
  let request!: Promise<void>;
  act(() => {
    request = h.result.current.flush();
  });
  await waitFor(() =>
    expect((state.repo!.db as MemoryDb).rows.size).toBeGreaterThan(0),
  );
  act(() => h.result.current.updateMany([{ ...f, name: "newest" }]));
  release();
  await act(async () => request);
  expect(h.result.current.folders[0].name).toBe("newest");
  await act(async () => h.result.current.flush());
  expect(h.result.current.folders[0].name).toBe("newest");
  expect(h.result.current.pendingCount).toBe(0);
});
