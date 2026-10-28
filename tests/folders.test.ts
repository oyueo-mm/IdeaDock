import { describe, it, expect } from "vitest";
import {
  makeFolder,
  validateFolders,
  validateMove,
  folderPath,
  folderTrashed,
  validateWorkspace,
} from "../src/lib/folders";
import { makeIdea } from "../src/lib/model";
import { canonical, digest } from "../src/lib/integrity";
import { DriveRepository } from "../src/lib/drive";
import { FolderRepository } from "../src/lib/folder-repository";
import {
  prepareBackup,
  validateBackup,
  restoreDemoBackup,
  migrate,
} from "../src/lib/migration";
import { MemoryDb, MemoryRemote } from "./support/memory";
const encode = async (b: Blob) =>
  `data:${b.type};base64,${Buffer.from(await b.arrayBuffer()).toString("base64")}`;
const decode = async (p: string) => (await fetch(p)).blob();
function setup() {
  const db = new MemoryDb(),
    remote = new MemoryRemote(),
    repo = new DriveRepository("alice", remote, db);
  return { db, remote, repo, folders: new FolderRepository(repo) };
}
describe("folder hierarchy and compatibility", () => {
  it("preserves old idea hashes and does not normalize absent folder fields", async () => {
    const idea = makeIdea("old", "alice"),
      before = canonical(idea),
      { repo } = setup();
    const hash = await repo.append(idea, null);
    expect((await repo.revisions())[0].hash).toBe(hash);
    expect(canonical((await repo.list())[0].idea)).toBe(before);
    expect(Object.hasOwn(idea, "folder_id")).toBe(false);
  });
  it("supports deep iterative paths and inherited trash without editing ideas", () => {
    const fs = Array.from({ length: 120 }, (_, n) => ({
      ...makeFolder(String(n), "alice", n ? `f${n - 1}` : null),
      id: `f${n}`,
    }));
    validateFolders(fs);
    expect(folderPath(fs, "f119")).toHaveLength(120);
    const idea = { ...makeIdea("retained", "alice"), folder_id: "f119" };
    const before = canonical(idea);
    fs[0].deleted_at = new Date().toISOString();
    expect(folderTrashed(fs, idea.folder_id)).toBe(true);
    expect(canonical(idea)).toBe(before);
  });
  it("rejects self, descendant, foreign account, missing parent and trash moves", () => {
    const a = makeFolder("a", "alice", null),
      b = makeFolder("b", "alice", a.id),
      other = makeFolder("other", "bob", null);
    for (const target of [a.id, b.id])
      expect(() => validateMove([a, b], "alice", [a.id], [], target)).toThrow();
    expect(() =>
      validateMove(
        [a, b, other],
        "alice",
        [],
        [makeIdea("x", "alice")],
        other.id,
      ),
    ).toThrow();
    expect(() => validateFolders([{ ...a, parent_id: "missing" }])).toThrow();
    expect(() =>
      validateMove(
        [{ ...a, deleted_at: new Date().toISOString() }],
        "alice",
        [a.id],
        [],
        null,
      ),
    ).toThrow();
  });
  it("rejects cross-account idea references", () => {
    const a = makeFolder("a", "alice", null);
    expect(() =>
      validateWorkspace([{ ...makeIdea("b", "bob"), folder_id: a.id }], [a]),
    ).toThrow();
  });
  it("uses separate immutable revision kinds and verifies corruption", async () => {
    const { folders, remote, repo } = setup(),
      f = makeFolder("root", "alice", null);
    await folders.save(f, null);
    expect(await repo.list()).toEqual([]);
    const file = (await remote.list("folder-revision"))[0];
    file.blob = new Blob(["corrupt"]);
    const uncached = new FolderRepository(
      new DriveRepository("alice", remote, new MemoryDb()),
    );
    await expect(uncached.list()).rejects.toThrow("체크섬");
  });
  it("retains conflicting siblings and requires explicit join", async () => {
    const { folders, repo } = setup(),
      f = makeFolder("a", "alice", null);
    const first = await folders.save(f, null);
    await folders.append({ ...first.folder, name: "left" }, first.head);
    await folders.append({ ...first.folder, name: "right" }, first.head);
    const row = (await folders.list())[0];
    expect(row.conflicts).toHaveLength(2);
    await expect(
      folders.save({ ...first.folder, name: "silent" }, first.head),
    ).rejects.toThrow("VERSION_CONFLICT");
    await folders.join(row, { ...row.folder, parent_id: null });
    expect((await folders.list())[0].conflicts).toHaveLength(0);
    expect(await folders.revisions()).toHaveLength(4);
    expect(await repo.list()).toEqual([]);
  });
  it("retries a lost reply idempotently", async () => {
    const { folders, remote } = setup(),
      f = makeFolder("retry", "alice", null);
    remote.lostReply = true;
    await expect(folders.save(f, null)).rejects.toThrow("lost");
    await folders.save(f, null);
    expect(await remote.list("folder-revision")).toHaveLength(1);
  });
  it("round trips v2 folders, trashed hierarchy and membership while restoring v1", async () => {
    const root = makeFolder("root", "demo", null),
      child = makeFolder("child", "demo", root.id);
    root.deleted_at = new Date().toISOString();
    const idea = { ...makeIdea("x", "demo"), folder_id: child.id };
    const backup = await prepareBackup(
      [{ id: "demo", label: "demo", ideas: [idea], folders: [root, child] }],
      decode,
      encode,
      new MemoryDb(),
    );
    expect(backup.schema).toBe("ideadock-migration-v2");
    await validateBackup(backup, decode);
    const data = new Map<string, string>(),
      storage = {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => {
          data.set(k, v);
        },
      };
    await restoreDemoBackup(backup, storage, decode);
    expect(JSON.parse(data.get("ideadock:folders:demo:v2")!).folders).toEqual([
      root,
      child,
    ]);
    expect(JSON.parse(data.get("ideadock:data:demo")!).ideas[0]).toEqual(idea);
    const old = await prepareBackup(
      [{ id: "demo", label: "demo", ideas: [makeIdea("old", "demo")] }],
      decode,
      encode,
      null,
    );
    expect(old.schema).toBe("ideadock-migration-v1");
    await validateBackup(old, decode);
  });
  it("migrates empty folders and memberships without changing original IDs", async () => {
    const { repo, remote } = setup();
    const f = makeFolder("folder", "demo", null),
      idea = { ...makeIdea("x", "demo"), folder_id: f.id };
    const backup = await prepareBackup(
      [{ id: "demo", label: "demo", ideas: [idea], folders: [f] }],
      decode,
      encode,
      null,
    );
    await migrate(
      backup,
      repo,
      { account: "alice", backup: backup.id },
      decode,
    );
    await migrate(
      backup,
      repo,
      { account: "alice", backup: backup.id },
      decode,
    );
    expect(await remote.list("folder-revision")).toHaveLength(1);
    expect((await repo.list())[0].idea.folder_id).toBe(f.id);
    expect((await new FolderRepository(repo).list())[0].folder.user_id).toBe(
      "alice",
    );
  });
  it("detects altered folder metadata in a backup", async () => {
    const f = makeFolder("folder", "demo", null);
    const backup = await prepareBackup(
      [{ id: "demo", label: "demo", ideas: [], folders: [f] }],
      decode,
      encode,
      null,
    );
    backup.sources[0].folders![0].name = "changed";
    await expect(validateBackup(backup, decode)).rejects.toThrow("체크섬");
    expect(backup.id).not.toBe(
      await digest(
        canonical({ sources: backup.sources, images: backup.images }),
      ),
    );
  });
});
