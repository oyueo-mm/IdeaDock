// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Idea } from "../src/lib/model";
import { makeIdea } from "../src/lib/model";
const server = vi.hoisted(() => ({
  rows: [] as Idea[],
  failure: "",
  save: vi.fn(),
  list: vi.fn(),
  copy: vi.fn(),
  auth: null as null | ((event: string, session: unknown) => void),
}));
vi.mock("../src/lib/supabase", () => ({
  supabase: {
    storage: { from: () => ({ copy: server.copy }) },
    auth: {
      onAuthStateChange: (
        callback: (event: string, session: unknown) => void,
      ) => {
        server.auth = callback;
        queueMicrotask(() =>
          callback("INITIAL_SESSION", {
            user: { id: "alice", email: "alice@example.com" },
          }),
        );
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signOut: vi.fn(async () => ({ error: null })),
    },
    rpc: (method: string, args?: unknown) =>
      method === "list_ideas" ? server.list() : server.save(args),
  },
}));
import { useLegacyIdeas as useIdeas } from "../src/lib/use-legacy-ideas";
beforeEach(() => {
  localStorage.clear();
  server.rows = [];
  server.failure = "";
  server.save.mockReset();
  server.list.mockReset();
  server.copy.mockReset();
  server.copy.mockResolvedValue({ data: {}, error: null });
  server.list.mockImplementation(async () => ({
    data: structuredClone(server.rows),
    error: null,
  }));
  server.save.mockImplementation(
    async ({
      document,
      expected_version,
    }: {
      document: Idea;
      expected_version: number;
    }) => {
      if (server.failure)
        return { data: null, error: { message: server.failure } };
      const existing = server.rows.find((i) => i.id === document.id);
      if ((existing?.version || 0) !== expected_version)
        return { data: null, error: { message: "VERSION_CONFLICT" } };
      const saved = {
        ...structuredClone(document),
        version: expected_version + 1,
      };
      server.rows = server.rows.filter((i) => i.id !== saved.id).concat(saved);
      return { data: saved, error: null };
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function setup() {
  const hook = renderHook(() => useIdeas());
  await waitFor(() => expect(hook.result.current.user?.id).toBe("alice"));
  return hook;
}
describe("autosave recovery and concurrency", () => {
  it("retains edits made while a previous save is in flight", async () => {
    const { result } = await setup();
    let original!: Idea;
    act(() => {
      original = result.current.create("first")!;
    });
    let complete!: (value: unknown) => void;
    server.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.flush();
    });
    act(() =>
      result.current.update({ ...original, title: "new edit during save" }),
    );
    await act(async () => {
      complete({ data: { ...original, version: 1 }, error: null });
      await saving;
    });
    expect(result.current.ideas[0]).toMatchObject({
      title: "new edit during save",
      version: 1,
    });
    await act(async () => {
      await result.current.flush();
    });
    expect(server.save.mock.calls[1][0]).toMatchObject({
      expected_version: 1,
      document: { title: "new edit during save" },
    });
  });
  it("recovers an unsaved draft after a failed save and remount", async () => {
    server.failure = "network offline";
    const hook = await setup();
    act(() => {
      hook.result.current.create("offline draft");
    });
    await act(async () => {
      await hook.result.current.flush();
    });
    expect(hook.result.current.error).toContain("network offline");
    expect(
      JSON.parse(localStorage.getItem("ideadock:data:alice")!).pending,
    ).not.toEqual({});
    hook.unmount();
    server.failure = "";
    const again = await setup();
    await waitFor(() =>
      expect(again.result.current.ideas[0]?.title).toBe("offline draft"),
    );
    await act(async () => {
      await again.result.current.flush();
    });
    expect(server.rows[0].title).toBe("offline draft");
  });
  it("blocks stale overwrite and preserves both versions as separate records", async () => {
    const original = { ...makeIdea("shared", "alice"), version: 1 };
    server.rows = [original];
    const { result } = await setup();
    await waitFor(() => expect(result.current.ideas).toHaveLength(1));
    act(() => result.current.update({ ...original, title: "my draft" }));
    server.rows = [{ ...original, title: "other device", version: 2 }];
    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.conflicts).toEqual([original.id]);
    expect(result.current.ideas[0].title).toBe("my draft");
    await act(async () => {
      await result.current.resolve(original.id, true);
    });
    expect(result.current.ideas.map((i) => i.title).sort()).toEqual([
      "my draft (내 초안)",
      "other device",
    ]);
  });
  it("does not let a delayed initial fetch erase a newly saved idea", async () => {
    let complete!: (value: unknown) => void;
    server.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { result } = await setup();
    act(() => {
      result.current.create("new record");
    });
    await act(async () => {
      await result.current.flush();
    });
    await act(async () => {
      complete({ data: [], error: null });
    });
    expect(result.current.ideas[0].title).toBe("new record");
  });
  it("copies attachment identities and private files when preserving a conflict", async () => {
    const base = { ...makeIdea("attached", "alice"), version: 1 };
    const image = {
      id: crypto.randomUUID(),
      storage_path: `alice/${base.id}/image`,
      original_filename: "test.png",
    };
    const link = {
      id: crypto.randomUUID(),
      type: "website" as const,
      label: "Example",
      url: "https://example.com",
    };
    const original = {
      ...base,
      images: [image],
      links: [link],
      content: { type: "doc", content: [{ type: "ideaImage", attrs: image }] },
    };
    server.rows = [original];
    const { result } = await setup();
    await waitFor(() => expect(result.current.ideas).toHaveLength(1));
    act(() =>
      result.current.update({ ...original, title: "my attached draft" }),
    );
    server.rows = [{ ...original, version: 2 }];
    await act(async () => {
      await result.current.flush();
    });
    await act(async () => {
      await result.current.resolve(original.id, true);
    });
    const copy = result.current.ideas.find((i) => i.id !== original.id)!;
    expect(copy.links[0].id).not.toBe(link.id);
    expect(copy.images[0].id).not.toBe(image.id);
    expect(copy.images[0].storage_path).toBe(
      `alice/${copy.id}/${copy.images[0].id}`,
    );
    expect(server.copy).toHaveBeenCalledWith(
      image.storage_path,
      copy.images[0].storage_path,
    );
    expect(copy.content).toMatchObject({
      content: [{ attrs: copy.images[0] }],
    });
    expect(result.current.conflicts).toHaveLength(0);
  });
  it("keeps the original conflicted draft when attachment copying fails", async () => {
    const original = {
      ...makeIdea("attached", "alice"),
      version: 1,
      images: [
        {
          id: crypto.randomUUID(),
          storage_path: "alice/idea/image",
          original_filename: "test.png",
        },
      ],
    };
    server.rows = [original];
    const { result } = await setup();
    await waitFor(() => expect(result.current.ideas).toHaveLength(1));
    act(() => result.current.update({ ...original, title: "keep my draft" }));
    server.rows = [{ ...original, version: 2 }];
    await act(async () => {
      await result.current.flush();
    });
    server.copy.mockResolvedValueOnce({ error: { message: "offline" } });
    await act(async () => {
      await result.current.resolve(original.id, true);
    });
    expect(result.current.ideas[0].title).toBe("keep my draft");
    expect(result.current.conflicts).toEqual([original.id]);
    expect(
      JSON.parse(localStorage.getItem("ideadock:data:alice")!).pending[
        original.id
      ],
    ).toBeDefined();
  });
  it("clears visible personal data on account transition", async () => {
    const { result } = await setup();
    act(() => {
      result.current.create("alice private draft");
    });
    await act(async () => {
      server.auth?.("SIGNED_IN", {
        user: { id: "bob", email: "bob@example.com" },
      });
    });
    await waitFor(() => expect(result.current.ideas).toHaveLength(0));
    act(() =>
      result.current.update({ ...makeIdea("late upload result", "alice") }),
    );
    expect(result.current.ideas).toHaveLength(0);
    expect(localStorage.getItem("ideadock:data:alice")).toContain(
      "alice private draft",
    );
  });
});
