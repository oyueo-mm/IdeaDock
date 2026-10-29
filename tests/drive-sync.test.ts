// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Idea } from "../src/lib/model";
import { makeIdea } from "../src/lib/model";
import { registerFolderWrites } from "../src/lib/folder-sync-gate";

const state = vi.hoisted(() => ({
  rows: [] as { idea: Idea; head: string; conflicts: [] }[],
  disk: new Map<string, unknown>(),
  save: vi.fn(),
  list: vi.fn(),
  login: vi.fn(),
  join: vi.fn(),
  writeFailure: false,
  session: null as string | null,
  listeners: new Set<() => void>(),
}));
function setSession(account: string | null) {
  state.session = account;
  state.listeners.forEach((listener) => listener());
}
// Waiting for a browser paint is not what these tests are about.
vi.mock("../src/lib/paint", () => ({ afterPaint: async () => {} }));
vi.mock("../src/lib/local-db", () => ({
  localDb: {
    get: async (key: string) => structuredClone(state.disk.get(key)),
    set: async (key: string, value: unknown) => {
      if (state.writeFailure) throw new Error("quota exceeded");
      state.disk.set(key, structuredClone(value));
    },
  },
}));
vi.mock("../src/lib/drive", () => ({
  // Token (GitHub Pages) mode; server mode is covered by auth-server tests.
  authMode: "token",
  driveAuthState: () => "restoring",
  restoreServerSession: vi.fn(),
  serverToken: vi.fn(),
  signOutServer: async () => {},
  takeAuthResult: () => null,
  driveConfigured: false,
  driveCacheKey: (account: string) => `${account}:cache`,
  loadGoogle: vi.fn(),
  connectDrive: async (...args: unknown[]) => {
    const user = await state.login(...args);
    setSession(user.id);
    return user;
  },
  disconnectDrive: () => setSession(null),
  forgetDriveUser: () => {
    setSession(null);
    localStorage.removeItem("ideadock:drive-account");
  },
  rememberDriveUser: (user: unknown) =>
    localStorage.setItem("ideadock:drive-account", JSON.stringify(user)),
  rememberedDriveUser: () =>
    JSON.parse(localStorage.getItem("ideadock:drive-account") || "null"),
  driveSessionAccount: () => state.session,
  subscribeDriveSession: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
  DriveAuthError: class DriveAuthError extends Error {},
  driveRepositoryFor: () => ({
    save: state.save,
    list: state.list,
    join: state.join,
  }),
  GoogleDrive: class {},
  DriveRepository: class {
    save = state.save;
    list = state.list;
    join = state.join;
  },
}));
import { useDriveIdeas } from "../src/lib/use-ideas";
import { DriveAuthError } from "../src/lib/drive";
beforeEach(() => {
  localStorage.clear();
  state.disk.clear();
  state.rows = [];
  state.writeFailure = false;
  state.session = null;
  state.listeners.clear();
  state.login.mockReset().mockResolvedValue({
    id: "google:alice",
    email: "alice@example.com",
    user_metadata: { full_name: "Alice" },
  });
  state.list
    .mockReset()
    .mockImplementation(async () => structuredClone(state.rows));
  state.save
    .mockReset()
    .mockImplementation(async (idea: Idea, parent: string | null) => {
      const current = state.rows.find((r) => r.idea.id === idea.id);
      if ((current?.head ?? null) !== parent)
        throw new Error("VERSION_CONFLICT");
      const saved = {
        idea: { ...structuredClone(idea), version: idea.version + 1 },
        head: crypto.randomUUID(),
        conflicts: [] as [],
      };
      state.rows = state.rows
        .filter((r) => r.idea.id !== idea.id)
        .concat(saved);
      return saved;
    });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function setup() {
  const hook = renderHook(() => useDriveIdeas());
  await act(async () => {
    await hook.result.current.login();
  });
  await waitFor(() => expect(state.list).toHaveBeenCalled());
  return hook;
}
describe("Drive autosave and local recovery", () => {
  it("keeps idea drafts local until pending folders have been durably synced", async () => {
    const { result } = await setup();
    let available = false;
    const stop = registerFolderWrites("google:alice", async () => {
      if (!available) throw new Error("folder offline");
    });
    try {
      act(() => {
        result.current.create("folder-dependent draft");
      });
      await act(async () => result.current.flush());
      expect(state.save).not.toHaveBeenCalled();
      expect(result.current.pendingCount).toBe(1);
      expect(state.disk.get("google:alice:cache")).toMatchObject({
        ideas: [{ title: "folder-dependent draft" }],
      });
      available = true;
      await act(async () => result.current.flush());
      expect(result.current.pendingCount).toBe(0);
      expect(state.rows[0].idea.title).toBe("folder-dependent draft");
    } finally {
      stop();
    }
  });
  it("saves drafts to account-scoped IndexedDB before remote upload", async () => {
    const { result } = await setup();
    act(() => {
      result.current.create("durable draft");
    });
    await act(async () => {
      await result.current.flush();
    });
    expect(state.rows[0].idea.title).toBe("durable draft");
    expect(state.disk.get("google:alice:cache")).toMatchObject({
      ideas: [{ title: "durable draft" }],
      pending: {},
    });
    expect(localStorage.getItem("ideadock:data:google:alice")).toBeNull();
  });
  it("retains newer input while a save is in flight", async () => {
    const { result } = await setup();
    let original!: Idea;
    act(() => {
      original = result.current.create("first")!;
    });
    let complete!: (value: unknown) => void;
    state.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    let saving!: Promise<void>;
    await act(async () => {
      saving = result.current.flush();
      await Promise.resolve();
    });
    act(() => result.current.update({ ...original, title: "new edit" }));
    await act(async () => {
      complete({ idea: { ...original, version: 1 }, head: "head-1" });
      await saving;
    });
    expect(result.current.ideas[0]).toMatchObject({
      title: "new edit",
      version: 1,
    });
    expect(state.disk.get("google:alice:cache")).toMatchObject({
      pending: {
        [original.id]: { idea: { title: "new edit" }, parent: "head-1" },
      },
    });
  });
  it("restores an offline pending draft after remount without data loss", async () => {
    const hook = await setup();
    state.save.mockRejectedValue(new Error("network offline"));
    act(() => {
      hook.result.current.create("offline draft");
    });
    await act(async () => {
      await hook.result.current.flush();
    });
    expect(hook.result.current.error).toContain("offline");
    hook.unmount();
    const again = await setup();
    expect(again.result.current.ideas[0].title).toBe("offline draft");
    expect(again.result.current.pendingCount).toBe(1);
  });
  it("does not send a draft if IndexedDB persistence fails", async () => {
    const { result } = await setup();
    state.writeFailure = true;
    act(() => {
      result.current.create("must remain local");
    });
    await act(async () => {
      await result.current.flush();
    });
    expect(state.save).not.toHaveBeenCalled();
    expect(result.current.ideas[0].title).toBe("must remain local");
    expect(result.current.error).toContain("quota");
  });
  it("prevents a stale refresh from discarding a newly created draft", async () => {
    const { result } = await setup();
    let complete!: (rows: unknown[]) => void;
    state.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    act(() => {
      result.current.create("newer than fetch");
    });
    await act(async () => {
      complete([]);
      await refreshing;
    });
    expect(result.current.ideas[0].title).toBe("newer than fetch");
  });
  it("blocks logout and account switching with pending drafts", async () => {
    const { result } = await setup();
    act(() => {
      result.current.create("private draft");
    });
    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.user?.id).toBe("google:alice");
    state.login.mockResolvedValueOnce({ id: "google:bob" });
    await act(async () => {
      await expect(result.current.login()).rejects.toThrow("미저장");
    });
    expect(result.current.ideas[0].title).toBe("private draft");
  });
  it("does not auto-upload demo ideas at Google login", async () => {
    const demo = makeIdea("original demo", "demo");
    const raw = JSON.stringify({ ideas: [demo], pending: {} });
    localStorage.setItem("ideadock:data:demo", raw);
    const { result } = await setup();
    expect(result.current.ideas).toEqual([]);
    expect(state.save).not.toHaveBeenCalled();
    expect(localStorage.getItem("ideadock:data:demo")).toBe(raw);
  });
  it("keeps the conflicted draft locally when remote version changed", async () => {
    const original = makeIdea("original", "google:alice");
    state.rows = [{ idea: original, head: "h1", conflicts: [] }];
    const { result } = await setup();
    act(() => {
      result.current.update({ ...original, title: "my draft" });
    });
    state.rows = [
      {
        idea: { ...original, title: "other device" },
        head: "h2",
        conflicts: [],
      },
    ];
    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.conflicts).toEqual([original.id]);
    expect(result.current.ideas[0].title).toBe("my draft");
    expect(state.disk.get("google:alice:cache")).toMatchObject({
      pending: { [original.id]: { idea: { title: "my draft" } } },
    });
  });
  it("reopens the remembered workspace after a reload and reconnects without the account chooser", async () => {
    const first = await setup();
    act(() => {
      first.result.current.create("kept across reload");
    });
    await act(async () => first.result.current.flush());
    first.unmount();
    // A reload loses the in-memory token; the device cache must still open.
    setSession(null);
    state.login.mockClear();
    state.save.mockClear();
    const reload = renderHook(() => useDriveIdeas());
    await waitFor(() =>
      expect(reload.result.current.ideas[0]?.title).toBe("kept across reload"),
    );
    expect(reload.result.current.user?.id).toBe("google:alice");
    expect(reload.result.current.connected).toBe(false);
    act(() => {
      reload.result.current.update({
        ...reload.result.current.ideas[0],
        title: "edited while disconnected",
      });
    });
    await act(async () => reload.result.current.flush());
    expect(state.save).not.toHaveBeenCalled();
    expect(reload.result.current.error).toBe("");
    expect(reload.result.current.pendingCount).toBe(1);
    await act(async () => reload.result.current.login());
    expect(state.login).toHaveBeenCalledWith({
      hint: expect.objectContaining({ id: "google:alice" }),
    });
    await waitFor(() => expect(reload.result.current.pendingCount).toBe(0));
    expect(state.rows[0].idea.title).toBe("edited while disconnected");
  });
  it("keeps drafts and shows no error when the token expires mid-save", async () => {
    const { result } = await setup();
    state.save.mockImplementationOnce(async () => {
      setSession(null);
      throw new DriveAuthError();
    });
    act(() => {
      result.current.create("expired token draft");
    });
    await act(async () => result.current.flush());
    expect(result.current.error).toBe("");
    expect(result.current.connected).toBe(false);
    expect(result.current.pendingCount).toBe(1);
    expect(state.disk.get("google:alice:cache")).toMatchObject({
      ideas: [{ title: "expired token draft" }],
    });
  });
  it("switches accounts through the chooser and forgets the workspace at sign-out", async () => {
    const { result, unmount } = await setup();
    state.login.mockResolvedValueOnce({
      id: "google:bob",
      email: "bob@example.com",
      user_metadata: { full_name: "Bob" },
    });
    await act(async () => result.current.login(false, true));
    expect(state.login).toHaveBeenLastCalledWith({});
    await waitFor(() => expect(result.current.user?.id).toBe("google:bob"));
    expect(JSON.parse(localStorage.getItem("ideadock:drive-account")!).id).toBe(
      "google:bob",
    );
    await act(async () => result.current.signOut());
    expect(result.current.user).toBeNull();
    expect(localStorage.getItem("ideadock:drive-account")).toBeNull();
    unmount();
    const reload = renderHook(() => useDriveIdeas());
    await waitFor(() => expect(reload.result.current.ready).toBe(true));
    expect(reload.result.current.user).toBeNull();
    expect(reload.result.current.ideas).toEqual([]);
  });
  it("refuses an account switch before opening Google when drafts are pending", async () => {
    const { result } = await setup();
    setSession(null);
    act(() => {
      result.current.create("unsaved");
    });
    state.login.mockClear();
    await act(async () => {
      await expect(result.current.login(false, true)).rejects.toThrow(
        "계정을 전환할 수 없습니다",
      );
    });
    expect(state.login).not.toHaveBeenCalled();
    expect(result.current.user?.id).toBe("google:alice");
  });
});
