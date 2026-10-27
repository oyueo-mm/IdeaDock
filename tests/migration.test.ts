import { describe, expect, it } from "vitest";
import { DriveRepository, ImmutableRemote, RemoteFile } from "../src/lib/drive";
import { KeyValueStore } from "../src/lib/local-db";
import { canonical, digest } from "../src/lib/integrity";
import {
  jsonSources,
  migrate,
  MigrationProgress,
  prepareBackup,
  restoreDemoBackup,
  validateBackup,
} from "../src/lib/migration";
import { makeIdea } from "../src/lib/model";

class MemoryDb implements KeyValueStore {
  rows = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.rows.get(key)) as T | undefined;
  }
  async set<T>(key: string, value: T) {
    this.rows.set(key, structuredClone(value));
  }
  async entries<T>(prefix: string) {
    return [...this.rows].filter(([key]) => key.startsWith(prefix)) as [
      string,
      T,
    ][];
  }
}
class MemoryDrive implements ImmutableRemote {
  files = new Map<string, RemoteFile & { blob: Blob }>();
  creates = 0;
  failAt = 0;
  loseReply = false;
  async allocate() {
    return crypto.randomUUID();
  }
  async list(kind: string) {
    return [...this.files.values()].filter(
      (f) => f.appProperties.kind === kind,
    );
  }
  async read(id: string) {
    const f = this.files.get(id);
    if (!f) throw new Error("missing file");
    return f.blob;
  }
  async create(id: string, key: string, kind: string, blob: Blob) {
    this.creates++;
    if (this.failAt === this.creates) throw new Error("network offline");
    if (this.files.has(id))
      throw Object.assign(new Error("exists"), { status: 409 });
    this.files.set(id, { id, appProperties: { key, kind }, blob });
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error("response lost");
    }
  }
}
const blob = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], {
  type: "image/png",
});
const encode = async (b: Blob) =>
  `data:${b.type};base64,${Buffer.from(await b.arrayBuffer()).toString("base64")}`;
const decode = async (data: string) => (await fetch(data)).blob();
async function fixture() {
  const db = new MemoryDb(),
    remote = new MemoryDrive();
  const repo = new DriveRepository("google:alice", remote, db);
  const path = await encode(blob);
  const image = {
    id: "image-1",
    storage_path: path,
    original_filename: "원본.png",
  };
  const idea = {
    ...makeIdea("서식과 이미지", "demo"),
    is_completed: true,
    is_pinned: true,
    created_at: "2021-01-01T00:00:00.000Z",
    updated_at: "2022-03-01T02:00:00.000Z",
    deleted_at: "2023-01-01T00:00:00.000Z",
    version: 8,
    tags: ["한글", "태그"],
    links: [
      {
        id: "link-1",
        type: "github" as const,
        label: "소스",
        url: "https://github.com/oyueo-mm/IdeaDock",
      },
    ],
    images: [image],
    plain_text: "굵은 글씨와 체크",
    content: {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            { type: "text", text: "굵은 글씨", marks: [{ type: "bold" }] },
          ],
        },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph" }],
            },
          ],
        },
        { type: "ideaImage", attrs: { ...image, custom: "보존" } },
      ],
    },
  };
  const second = makeIdea("두 번째", "demo");
  const sources = [
    {
      id: "demo",
      label: "체험",
      ideas: [idea, second],
      raw: { untouched: "raw snapshot" },
    },
  ];
  const backup = await prepareBackup(sources, async () => blob, encode, db);
  const approved = { account: repo.account, backup: backup.id };
  return { db, remote, repo, idea, second, backup, approved, sources };
}
describe("safe migration", () => {
  it("preserves all fields, Tiptap structure, references, trash and original bytes", async () => {
    const { repo, remote, idea, backup, approved, sources } = await fixture();
    const original = canonical(sources);
    const result = await migrate(backup, repo, approved, decode);
    expect(result.state).toBe("verified");
    const rows = await repo.list();
    expect(rows).toHaveLength(2);
    const migrated = rows.find((r) => r.idea.id === idea.id)!.idea;
    const expected = structuredClone(idea);
    expected.user_id = repo.account;
    expected.images[0].storage_path = `drive-sha:${await digest(blob)}`;
    (
      expected.content.content[2].attrs as Record<string, unknown>
    ).storage_path = expected.images[0].storage_path;
    expect(migrated).toEqual({
      ...expected,
      provenance: {
        source: "demo",
        source_id: idea.id,
        original_owner: "demo",
        fingerprint: await digest(canonical(idea)),
      },
    });
    expect(canonical(sources)).toBe(original);
    expect(
      await digest(await remote.read((await remote.list("image"))[0].id)),
    ).toBe(await digest(blob));
    expect((await remote.list("backup")).length).toBe(1);
  });
  it("never writes to Drive without approval for the exact account and backup", async () => {
    const { repo, remote, backup, approved } = await fixture();
    await expect(
      migrate(backup, repo, { ...approved, account: "google:bob" }, decode),
    ).rejects.toThrow("승인");
    await expect(
      migrate(backup, repo, { ...approved, backup: "another" }, decode),
    ).rejects.toThrow("승인");
    expect(remote.creates).toBe(0);
  });
  it("rejects a corrupt recovery document or image before any upload", async () => {
    const { repo, remote, backup, approved } = await fixture();
    const corrupt = structuredClone(backup);
    corrupt.sources[0].ideas[0].title = "tampered";
    await expect(migrate(corrupt, repo, approved, decode)).rejects.toThrow(
      "체크섬",
    );
    const corruptImage = structuredClone(backup);
    corruptImage.images[0].sha256 = "bad";
    corruptImage.id = await digest(
      canonical({ sources: corruptImage.sources, images: corruptImage.images }),
    );
    await expect(validateBackup(corruptImage, decode)).rejects.toThrow(
      "이미지",
    );
    expect(remote.creates).toBe(0);
  });
  it("refuses to create a recovery backup if an attachment cannot be read", async () => {
    const { sources } = await fixture();
    const db = new MemoryDb();
    await expect(
      prepareBackup(
        sources,
        async () => {
          throw new Error("missing attachment");
        },
        encode,
        db,
      ),
    ).rejects.toThrow("missing attachment");
    expect(await db.entries("backup:")).toEqual([]);
  });
  it("refuses remote uploads when durable backup storage fails", async () => {
    const { sources } = await fixture();
    const db = new MemoryDb();
    db.set = async () => {
      throw new Error("quota exceeded");
    };
    await expect(
      prepareBackup(sources, async () => blob, encode, db),
    ).rejects.toThrow("quota exceeded");
    const manual = await prepareBackup(sources, async () => blob, encode, null);
    await expect(validateBackup(manual, decode)).resolves.toBeUndefined();
  });
  it("resumes after partial upload, remount and repeat runs without duplicate ideas", async () => {
    const { repo, remote, db, backup, approved } = await fixture();
    remote.failAt = 4; // backup, image, first idea succeed; second idea fails
    await expect(migrate(backup, repo, approved, decode)).rejects.toThrow(
      "offline",
    );
    expect(await repo.list()).toHaveLength(1);
    const progress = await db.get<MigrationProgress>(
      `${repo.account}:migration:${backup.id}`,
    );
    expect(progress).toMatchObject({
      state: "failed",
      verified: [backup.sources[0].ideas[0].id],
    });
    remote.failAt = 0;
    const secondDevice = new DriveRepository(
      repo.account,
      remote,
      new MemoryDb(),
    );
    await migrate(backup, secondDevice, approved, decode);
    await migrate(backup, repo, approved, decode);
    expect(await repo.list()).toHaveLength(2);
    expect(await remote.list("revision")).toHaveLength(2);
    expect(await remote.list("image")).toHaveLength(1);
  });
  it("reconciles a lost successful upload response and checks the actual bytes", async () => {
    const { repo, remote, backup, approved } = await fixture();
    remote.loseReply = true;
    await expect(migrate(backup, repo, approved, decode)).rejects.toThrow(
      "response lost",
    );
    await migrate(backup, repo, approved, decode);
    expect(await remote.list("backup")).toHaveLength(1);
    expect(await repo.list()).toHaveLength(2);
  });
  it("preserves subsequent edits when an already verified migration is rerun", async () => {
    const { repo, remote, backup, approved } = await fixture();
    await migrate(backup, repo, approved, decode);
    const row = (await repo.list())[0];
    await repo.save({ ...row.idea, title: "새로 편집한 내용" }, row.head);
    await migrate(backup, repo, approved, decode);
    expect(
      (await repo.list()).find((r) => r.idea.id === row.idea.id)?.idea.title,
    ).toBe("새로 편집한 내용");
    expect(await remote.list("revision")).toHaveLength(3);
  });
  it("blocks a changed source with an existing ID without overwriting Drive", async () => {
    const { repo, backup, approved, sources, db } = await fixture();
    await migrate(backup, repo, approved, decode);
    sources[0].ideas[0].title = "원본 변경";
    const changed = await prepareBackup(sources, async () => blob, encode, db);
    await expect(
      migrate(
        changed,
        repo,
        { account: repo.account, backup: changed.id },
        decode,
      ),
    ).rejects.toThrow("겹치거나");
    expect(
      (await repo.list()).find((r) => r.idea.id === sources[0].ideas[0].id)
        ?.idea.title,
    ).toBe("서식과 이미지");
  });
  it("does not mark the migration verified if the final remote image read is corrupt", async () => {
    const { repo, remote, backup, approved, db } = await fixture();
    const originalRead = remote.read.bind(remote);
    let reads = 0;
    remote.read = async (id) => {
      if (remote.files.get(id)?.appProperties.kind === "image" && ++reads > 1)
        return new Blob(["corrupt"]);
      return originalRead(id);
    };
    await expect(migrate(backup, repo, approved, decode)).rejects.toThrow(
      "이미지",
    );
    expect(
      await db.get(`${repo.account}:migration:${backup.id}`),
    ).toMatchObject({ state: "failed" });
  });
  it("rejects broken inline image relations and duplicate IDs in old JSON exports", async () => {
    const { idea } = await fixture();
    await expect(
      prepareBackup(
        [{ id: "empty", label: "empty", ideas: [] }],
        async () => blob,
        encode,
        new MemoryDb(),
      ),
    ).rejects.toThrow("없습니다");
    expect(() => jsonSources({ ideas: [idea, idea] })).toThrow("중복");
    const broken = structuredClone(idea);
    broken.images = [];
    expect(() => jsonSources({ ideas: [broken] })).toThrow("본문 이미지 참조");
    expect(jsonSources({ ideas: [idea] })[0].id).toBe("demo");
  });
  it("a newly created Drive idea has no migrated provenance", async () => {
    const { repo } = await fixture();
    const idea = makeIdea("new", repo.account);
    await repo.save(idea, null);
    expect((await repo.list())[0].idea.provenance).toBeUndefined();
  });
  it("restores self-contained backups to the legacy demo format without replacing ideas", async () => {
    const { backup } = await fixture();
    const rows = new Map<string, string>();
    const storage = {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => {
        rows.set(key, value);
      },
    };
    const unrelated = makeIdea("기존 아이디어", "demo");
    const before = JSON.stringify({ ideas: [unrelated], pending: {} });
    storage.setItem("ideadock:data:demo", before);
    expect(await restoreDemoBackup(backup, storage, decode)).toBe(2);
    const restored = JSON.parse(storage.getItem("ideadock:data:demo")!);
    expect(restored.ideas).toHaveLength(3);
    expect(restored.ideas[0]).toEqual(unrelated);
    expect(restored.ideas[1].images[0].storage_path).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(storage.getItem(`ideadock:recovery:${backup.id}`)).toBe(before);
    expect(await restoreDemoBackup(backup, storage, decode)).toBe(0);
    restored.ideas[1].title = "기존 편집 내용";
    const modified = JSON.stringify(restored);
    storage.setItem("ideadock:data:demo", modified);
    await expect(restoreDemoBackup(backup, storage, decode)).rejects.toThrow(
      "겹칩니다",
    );
    expect(storage.getItem("ideadock:data:demo")).toBe(modified);
  });
  it("retries an ordinary save after a lost response without conflict or duplication", async () => {
    const { repo, remote } = await fixture();
    const idea = makeIdea("new", repo.account);
    remote.loseReply = true;
    await expect(repo.save(idea, null)).rejects.toThrow("response lost");
    const saved = await repo.save(idea, null);
    expect(saved.idea.version).toBe(1);
    expect(await remote.list("revision")).toHaveLength(1);
  });
  it("detects concurrent device branches, preserves both revisions and joins explicitly", async () => {
    const { repo, remote } = await fixture();
    const original = makeIdea("original", repo.account);
    const saved = await repo.save(original, null);
    // Both devices observed the same parent before their network writes finished.
    await Promise.all([
      repo.append({ ...saved.idea, title: "device A" }, saved.head),
      new DriveRepository(repo.account, remote, new MemoryDb()).append(
        { ...saved.idea, title: "device B" },
        saved.head,
      ),
    ]);
    const rows = await repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].conflicts.map((r) => r.idea.title).sort()).toEqual([
      "device A",
      "device B",
    ]);
    await expect(repo.save(rows[0].idea, rows[0].head)).rejects.toThrow(
      "VERSION_CONFLICT",
    );
    await repo.join(rows[0]);
    expect((await repo.list())[0].conflicts).toHaveLength(0);
    expect(await remote.list("revision")).toHaveLength(4);
  });
  it("reuses validated immutable revisions but forces server reads for verification", async () => {
    const { repo, remote } = await fixture();
    const original = makeIdea("cached history", repo.account);
    await repo.save(original, null);
    const read = remote.read.bind(remote);
    let downloads = 0;
    remote.read = async (id) => {
      downloads++;
      return read(id);
    };
    await repo.list();
    await repo.list();
    expect(downloads).toBe(0);
    await repo.revisions(true);
    expect(downloads).toBe(1);
    const file = (await remote.list("revision"))[0];
    remote.files.get(file.id)!.blob = new Blob(["corrupt"]);
    await expect(repo.revisions(true)).rejects.toThrow("무결성");
  });
});
