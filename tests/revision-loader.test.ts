import { describe, expect, it } from "vitest";
import { DriveRepository } from "../src/lib/drive";
import { FolderRepository } from "../src/lib/folder-repository";
import { makeFolder } from "../src/lib/folders";
import { canonical } from "../src/lib/integrity";
import { makeIdea } from "../src/lib/model";
import { mapLimit, READ_CONCURRENCY } from "../src/lib/revision-loader";
import { MemoryDb, MemoryRemote } from "./support/memory";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function setup() {
  const remote = new MemoryRemote(),
    db = new MemoryDb();
  const calls = {
    reads: 0,
    lists: [] as { kind: string; key?: string }[],
    gets: 0,
    sets: 0,
    active: 0,
    peak: 0,
  };
  let latency = 0;
  const read = remote.read.bind(remote),
    list = remote.list.bind(remote),
    get = db.get.bind(db),
    set = db.set.bind(db);
  remote.read = async (id) => {
    calls.reads++;
    calls.active++;
    calls.peak = Math.max(calls.peak, calls.active);
    if (latency) await delay(latency);
    calls.active--;
    return read(id);
  };
  remote.list = async (kind: string, key?: string) => {
    calls.lists.push({ kind, key });
    if (latency) await delay(latency);
    return list(kind);
  };
  db.get = (async (key: string) => {
    calls.gets++;
    return get(key);
  }) as typeof db.get;
  db.set = (async (key: string, value: unknown) => {
    calls.sets++;
    return set(key, value);
  }) as typeof db.set;
  const repo = () => new DriveRepository("alice", remote, db);
  return {
    remote,
    db,
    calls,
    repo,
    slow: (ms: number) => (latency = ms),
    reset: () => {
      calls.reads = calls.gets = calls.sets = calls.peak = calls.active = 0;
      calls.lists.length = 0;
    },
  };
}
async function populate(repo: DriveRepository, count: number) {
  const ideas = Array.from({ length: count }, (_, i) =>
    makeIdea(`idea ${i}`, "alice"),
  );
  for (const idea of ideas) await repo.save(idea, null);
  return ideas;
}

describe("mapLimit", () => {
  it("keeps results in order and never exceeds the limit", async () => {
    let active = 0,
      peak = 0;
    const out = await mapLimit([5, 4, 3, 2, 1, 0], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await delay(n);
      active--;
      return n * 2;
    });
    expect(out).toEqual([10, 8, 6, 4, 2, 0]);
    expect(peak).toBe(2);
  });
});

describe("revision loading", () => {
  it("re-reads, re-hashes and re-writes nothing when nothing changed", async () => {
    const t = setup();
    await populate(t.repo(), 8);
    const repo = t.repo(); // a new page load: no memory, device cache present
    t.reset();
    const first = await repo.list();
    expect(first).toHaveLength(8);
    expect(t.calls.reads).toBe(0); // all verified from the device cache
    expect(t.calls.gets).toBe(8);
    expect(t.calls.sets).toBe(0); // and not written back again
    t.reset();
    const again = await repo.list();
    expect(again).toBe(first); // same rows: callers can skip the re-render
    expect(t.calls.gets).toBe(0);
    expect(t.calls.reads).toBe(0);
    expect(t.calls.sets).toBe(0);
  });

  it("downloads only unseen revisions, in parallel, and verifies each", async () => {
    const t = setup();
    await populate(t.repo(), 14);
    t.db.rows.clear(); // a new device: nothing cached
    const repo = t.repo();
    t.slow(15);
    t.reset();
    expect(await repo.list()).toHaveLength(14);
    expect(t.calls.reads).toBe(14);
    expect(t.calls.peak).toBeGreaterThan(1);
    expect(t.calls.peak).toBeLessThanOrEqual(READ_CONCURRENCY);
    expect(t.calls.sets).toBe(14);
    t.slow(0);
    t.reset();
    await repo.list();
    expect(t.calls.reads).toBe(0);
    // A change made on another device downloads exactly the new file.
    const other = new DriveRepository("alice", t.remote, new MemoryDb());
    await other.save(makeIdea("late", "alice"), null);
    t.reset();
    expect(await repo.list()).toHaveLength(15);
    expect(t.calls.reads).toBe(1);
  });

  it("shares one listing between concurrent callers", async () => {
    const t = setup();
    await populate(t.repo(), 5);
    t.db.rows.clear();
    const repo = t.repo();
    t.slow(10);
    t.reset();
    const [a, b, c] = await Promise.all([
      repo.list(),
      repo.list(),
      repo.list(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(t.calls.lists.filter((l) => l.kind === "revision")).toHaveLength(1);
    expect(t.calls.reads).toBe(5);
  });

  it("never serves a listing that started before an upload", async () => {
    const t = setup();
    const [first] = await populate(t.repo(), 3);
    const repo = t.repo();
    t.slow(20);
    const stale = repo.list(); // listing starts, then a write completes
    await delay(5);
    const edited = { ...first, title: "edited", version: first.version + 1 };
    await repo.append(edited, (await t.repo().list())[0].head);
    const fresh = await repo.list();
    expect(fresh.find((r) => r.idea.id === first.id)?.idea.title).toBe(
      "edited",
    );
    await stale;
  });

  it("replaces a tampered device copy from the remote", async () => {
    const t = setup();
    const [idea] = await populate(t.repo(), 2);
    const key = [...t.db.rows.keys()].find((k) =>
      k.startsWith("alice:revision:"),
    )!;
    const copy = structuredClone(t.db.rows.get(key)) as {
      idea: { id: string; title: string };
    };
    copy.idea.title = "tampered";
    t.db.rows.set(key, copy);
    t.reset();
    const rows = await t.repo().list();
    expect(t.calls.reads).toBe(1); // only the damaged copy is fetched again
    expect(rows.map((r) => r.idea.title)).not.toContain("tampered");
    expect(rows.some((r) => r.idea.id === idea.id)).toBe(true);
    expect((t.db.rows.get(key) as typeof copy).idea.title).not.toBe("tampered");
  });

  it("a forced load verifies every file from the remote again", async () => {
    const t = setup();
    await populate(t.repo(), 4);
    const repo = t.repo();
    await repo.list();
    t.reset();
    await repo.revisions(true);
    expect(t.calls.reads).toBe(4);
    expect(t.calls.sets).toBe(4);
  });

  it("rejects remote bytes that do not match their hash", async () => {
    const t = setup();
    await populate(t.repo(), 2);
    t.db.rows.clear();
    const file = (await t.remote.list("revision"))[0];
    t.remote.files.get(file.id)!.blob = new Blob(["corrupt"]);
    await expect(t.repo().list()).rejects.toThrow("무결성");
  });

  it("narrows the duplicate check of an upload to one content hash", async () => {
    const t = setup();
    t.reset();
    await t.repo().save(makeIdea("x", "alice"), null);
    const checks = t.calls.lists.filter((l) => l.kind === "revision" && l.key);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0].key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("loads folder revisions the same way", async () => {
    const t = setup();
    const repo = t.repo(),
      folders = new FolderRepository(repo);
    for (let i = 0; i < 5; i++)
      await folders.save(makeFolder(`f${i}`, "alice", null), null);
    // A new FolderRepository over the same DriveRepository shares its memory.
    t.reset();
    const first = await new FolderRepository(repo).list();
    expect(first).toHaveLength(5);
    expect(t.calls.reads + t.calls.gets).toBe(0);
    expect(await new FolderRepository(repo).list()).toBe(first);
    // A fresh page load verifies from the device cache without writing.
    t.reset();
    expect(await new FolderRepository(t.repo()).list()).toHaveLength(5);
    expect(t.calls.reads).toBe(0);
    expect(t.calls.sets).toBe(0);
    // Corrupt folder bytes are still refused.
    t.db.rows.clear();
    const file = (await t.remote.list("folder-revision"))[0];
    t.remote.files.get(file.id)!.blob = new Blob([canonical({ no: "good" })]);
    await expect(new FolderRepository(t.repo()).list()).rejects.toThrow(
      "체크섬",
    );
  });
});
