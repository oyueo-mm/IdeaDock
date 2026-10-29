import { describe, expect, it } from "vitest";
import {
  DriveRepository,
  type ImmutableRemote,
  type RemoteFile,
} from "../src/lib/drive";
import type { KeyValueStore } from "../src/lib/local-db";
import { canonical, digest } from "../src/lib/integrity";
import {
  migrate,
  prepareBackup,
  type ImportPlan,
  type MigrationBackup,
} from "../src/lib/migration";
import { makeIdea, type Idea } from "../src/lib/model";

const noWait = { sleep: async () => {}, random: () => 0 };
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
/** A Drive in memory that counts what is asked of it and can misbehave. */
class CountingDrive implements ImmutableRemote {
  files = new Map<string, RemoteFile & { blob: Blob }>();
  counts = { list: 0, keyedList: 0, read: 0, create: 0, ids: 0, idCalls: 0 };
  active = 0;
  peak = 0;
  /** Called before each create; throw to simulate a failure. */
  beforeCreate?: (index: number) => void | Promise<void>;
  /** Stores the file, then fails as if the reply were lost. */
  loseReplyAt = new Set<number>();
  async allocate() {
    this.counts.ids++;
    this.counts.idCalls++;
    return crypto.randomUUID();
  }
  async allocateMany(count: number) {
    this.counts.ids += count;
    this.counts.idCalls++;
    return Array.from({ length: count }, () => crypto.randomUUID());
  }
  async list(kind: string, key?: string) {
    this.counts.list++;
    if (key) this.counts.keyedList++;
    return [...this.files.values()].filter(
      (f) =>
        f.appProperties.kind === kind && (!key || f.appProperties.key === key),
    );
  }
  async read(id: string) {
    this.counts.read++;
    const f = this.files.get(id);
    if (!f) throw new Error("missing file");
    return f.blob;
  }
  async create(id: string, key: string, kind: string, blob: Blob) {
    const index = ++this.counts.create;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await this.beforeCreate?.(index);
      if (this.files.has(id))
        throw Object.assign(new Error("exists"), { status: 409 });
      this.files.set(id, { id, appProperties: { key, kind }, blob });
      if (this.loseReplyAt.has(index)) throw new TypeError("Failed to fetch");
    } finally {
      this.active--;
    }
  }
  ofKind(kind: string) {
    return [...this.files.values()].filter(
      (f) => f.appProperties.kind === kind,
    );
  }
}
const png = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], {
  type: "image/png",
});
const encode = async (b: Blob) =>
  `data:${b.type};base64,${Buffer.from(await b.arrayBuffer()).toString("base64")}`;
const decode = async (data: string) => (await fetch(data)).blob();

function setup() {
  const remote = new CountingDrive(),
    db = new MemoryDb();
  return {
    remote,
    db,
    repo: new DriveRepository("google:alice", remote, db),
    fresh: () => new DriveRepository("google:alice", remote, db),
  };
}
const approved = (backup: MigrationBackup) => ({
  account: "google:alice",
  backup: backup.id,
});
async function backupOf(ideas: Idea[], withImage = false) {
  const path = await encode(png);
  if (withImage) {
    const image = { id: "img", storage_path: path, original_filename: "a.png" };
    ideas[0].images = [image];
    ideas[0].content = {
      type: "doc",
      content: [{ type: "ideaImage", attrs: { ...image } }],
    };
  }
  return prepareBackup(
    [{ id: "json:local", label: "JSON", ideas }],
    async () => png,
    encode,
    new MemoryDb(),
  );
}
const incoming = (count: number, owner = "local") =>
  Array.from({ length: count }, (_, i) => ({
    ...makeIdea(`가져올 ${i}`, owner),
    plain_text: `본문 ${i}`,
  }));

describe("batch writes", () => {
  it("lists once, allocates ids in one request and stores every file", async () => {
    const { repo, remote } = setup();
    const blobs = Array.from(
      { length: 12 },
      (_, i) => new Blob([`file ${i}`], { type: "text/plain" }),
    );
    const done: string[] = [];
    const hashes = await repo.putMany("image", blobs, {
      onDone: (hash) => void done.push(hash),
      pool: noWait,
    });
    expect(hashes).toEqual(await Promise.all(blobs.map((b) => digest(b))));
    expect(remote.ofKind("image")).toHaveLength(12);
    expect(remote.counts).toMatchObject({
      list: 1, // not one lookup per file
      keyedList: 0,
      idCalls: 1,
      ids: 12,
      create: 12,
      read: 12, // each file is read back and its checksum compared
    });
    expect(done.sort()).toEqual([...hashes].sort());
    expect(remote.peak).toBeLessThanOrEqual(3);
    expect(remote.peak).toBeGreaterThan(1);
  });

  it("stores identical content once and finds what is already there", async () => {
    const { repo, remote } = setup();
    const same = new Blob(["same"], { type: "text/plain" });
    await repo.putMany("image", [same, same, new Blob(["other"])], {
      pool: noWait,
    });
    expect(remote.ofKind("image")).toHaveLength(2);
    remote.counts.create = 0;
    remote.counts.idCalls = 0;
    await repo.putMany("image", [same], { pool: noWait });
    expect(remote.counts.create).toBe(0);
    expect(remote.counts.idCalls).toBe(0);
    expect(remote.ofKind("image")).toHaveLength(2);
  });

  it("saves every id on the device before any bytes are sent", async () => {
    const { repo, remote, db } = setup();
    remote.beforeCreate = () => {
      throw new Error("browser closed");
    };
    const blobs = ["a", "b", "c"].map((t) => new Blob([t]));
    await expect(
      repo.putMany("image", blobs, { pool: noWait }),
    ).rejects.toThrow("browser closed");
    const slots = [...db.rows.keys()].filter((k) => k.includes(":upload:"));
    expect(slots).toHaveLength(3);
    // The next run reuses those ids instead of allocating more.
    remote.beforeCreate = undefined;
    remote.counts.idCalls = 0;
    await repo.putMany("image", blobs, { pool: noWait });
    expect(remote.counts.idCalls).toBe(0);
    expect(remote.ofKind("image")).toHaveLength(3);
  });

  it("looks a file up by hash before repeating an upload that may have arrived", async () => {
    const { repo, remote } = setup();
    remote.loseReplyAt = new Set([2]);
    const blobs = ["a", "b", "c"].map((t) => new Blob([t]));
    await repo.putMany("image", blobs, { pool: noWait });
    expect(remote.ofKind("image")).toHaveLength(3); // no duplicate of the lost reply
    expect(remote.counts.keyedList).toBeGreaterThan(0);
  });

  it("retries a transient failure without duplicating anything", async () => {
    const { repo, remote } = setup();
    remote.beforeCreate = (index) => {
      if (index <= 2) throw Object.assign(new Error("busy"), { status: 503 });
    };
    const blobs = ["a", "b", "c", "d"].map((t) => new Blob([t]));
    await repo.putMany("image", blobs, { pool: noWait });
    expect(remote.ofKind("image")).toHaveLength(4);
  });

  it("slows down and finishes when Drive answers 429 under load", async () => {
    const { repo, remote } = setup();
    remote.beforeCreate = () => {
      if (remote.active > 1)
        throw Object.assign(new Error("slow down"), { status: 429 });
    };
    const blobs = Array.from({ length: 12 }, (_, i) => new Blob([`n${i}`]));
    await repo.putMany("image", blobs, {
      pool: { ...noWait, attempts: 12 },
    });
    expect(remote.ofKind("image")).toHaveLength(12);
  });

  it("with read-back off, the caller's verification still catches a bad file", async () => {
    const { repo, remote } = setup();
    const ideas = incoming(4);
    const hashes = await repo.appendMany(
      ideas.map((idea) => ({
        idea: { ...idea, user_id: "google:alice" },
        parent: null,
      })),
      { readBack: false, pool: noWait },
    );
    expect(remote.counts.read).toBe(0);
    expect(remote.ofKind("revision")).toHaveLength(4);
    expect([...(await repo.verifyRevisions(hashes)).keys()].sort()).toEqual(
      [...hashes].sort(),
    );
    const victim = remote.ofKind("revision")[1];
    victim.blob = new Blob(["corrupt"]);
    await expect(repo.verifyRevisions(hashes)).rejects.toThrow("무결성");
  });

  it("verifies only what was asked for", async () => {
    const { repo, remote } = setup();
    const ideas = incoming(6).map((i) => ({ ...i, user_id: "google:alice" }));
    const hashes = await repo.appendMany(
      ideas.map((idea) => ({ idea, parent: null })),
      { pool: noWait },
    );
    remote.counts.read = 0;
    await repo.verifyRevisions(hashes.slice(0, 2));
    expect(remote.counts.read).toBe(2);
    await expect(repo.verifyRevisions(["f".repeat(64)])).rejects.toThrow(
      "찾지 못했습니다",
    );
  });
});

describe("saveMany", () => {
  it("rejects a changed parent and reports an existing identical revision", async () => {
    const { repo } = setup();
    const idea = { ...incoming(1)[0], user_id: "google:alice" };
    const first = await repo.save(idea, null);
    const next = { ...first.idea, title: "바뀐 제목" };
    const [saved] = await repo.saveMany([{ idea: next, parent: first.head }], {
      pool: noWait,
    });
    expect(saved.idea.version).toBe(first.idea.version + 1);
    // Same request again: it is recognised, not written twice.
    const again = await repo.saveMany([{ idea: next, parent: first.head }], {
      pool: noWait,
    });
    expect(again[0].head).toBe(saved.head);
    await expect(
      repo.saveMany([{ idea: { ...next, title: "x" }, parent: first.head }], {
        pool: noWait,
      }),
    ).rejects.toThrow("VERSION_CONFLICT");
  });
});

describe("JSON import (migrate)", () => {
  it("imports 27 ideas and a picture in a handful of requests, verifying each file", async () => {
    const { repo, remote } = setup();
    const backup = await backupOf(incoming(27), true);
    const seen: string[] = [];
    const result = await migrate(
      backup,
      repo,
      approved(backup),
      decode,
      (p) => {
        if (p.stage) seen.push(p.stage);
      },
    );
    expect(result.state).toBe("verified");
    expect(result.total).toBe(27);
    expect(result.verified).toHaveLength(27);
    expect(remote.ofKind("revision")).toHaveLength(27);
    expect(remote.ofKind("image")).toHaveLength(1);
    expect(remote.ofKind("backup")).toHaveLength(1);
    // ids: one batch for the ideas, one for the picture, one for the backup
    expect(remote.counts.idCalls).toBeLessThanOrEqual(3);
    expect(seen).toEqual(
      expect.arrayContaining([
        "복구 백업을 Drive에 저장",
        "이미지 저장",
        "아이디어 저장",
        "서버 재조회 검증",
      ]),
    );
    expect(result.stages?.map((s) => s.stage)).toEqual([
      "복구 백업을 Drive에 저장",
      "폴더 저장",
      "이미지 저장",
      "아이디어 저장",
      "서버 재조회 검증",
    ]);
    // each revision is downloaded once (final verification), not once per step
    expect(remote.counts.read).toBeLessThanOrEqual(27 + 1 + 1 + 3);
  });

  it("does not download the revisions that were already in Drive", async () => {
    const { repo, remote, fresh } = setup();
    for (const idea of incoming(120).map((i) => ({
      ...i,
      user_id: "google:alice",
    })))
      await repo.append(idea, null);
    const backup = await backupOf(incoming(5), false);
    const clean = fresh(); // a new page: nothing cached in memory
    remote.counts.read = 0;
    await migrate(backup, clean, approved(backup), decode);
    // the old 120 are checked against the device cache, never re-downloaded
    expect(remote.counts.read).toBeLessThan(20);
    expect(remote.ofKind("revision")).toHaveLength(125);
  });

  it("re-running a partly stored import adds nothing and stores the rest", async () => {
    const { repo, remote, fresh } = setup();
    const backup = await backupOf(incoming(12), true);
    remote.beforeCreate = (index) => {
      if (index > 6) throw new Error("network offline");
    };
    await expect(
      migrate(backup, repo, approved(backup), decode),
    ).rejects.toThrow("offline");
    const partial = remote.ofKind("revision").length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(12);
    remote.beforeCreate = undefined;
    const result = await migrate(backup, fresh(), approved(backup), decode);
    expect(result.state).toBe("verified");
    expect(remote.ofKind("revision")).toHaveLength(12); // no duplicates
    const again = await migrate(backup, fresh(), approved(backup), decode);
    expect(again.state).toBe("verified");
    expect(remote.ofKind("revision")).toHaveLength(12);
    expect(remote.ofKind("image")).toHaveLength(1);
  });

  it("survives a lost reply and a rate-limited burst in the same run", async () => {
    const { repo, remote } = setup();
    const backup = await backupOf(incoming(20), true);
    remote.loseReplyAt = new Set([5, 9]);
    remote.beforeCreate = () => {
      if (remote.active > 2)
        throw Object.assign(new Error("slow down"), {
          status: 403,
          reason: "userRateLimitExceeded",
        });
    };
    const result = await migrate(backup, repo, approved(backup), decode);
    expect(result.state).toBe("verified");
    expect(remote.ofKind("revision")).toHaveLength(20);
    expect(remote.ofKind("image")).toHaveLength(1);
  });

  it("marks the run failed and keeps the saved count when the server returns bad bytes", async () => {
    const { repo, remote, db } = setup();
    const backup = await backupOf(incoming(6), false);
    const read = remote.read.bind(remote);
    remote.read = async (id) =>
      remote.files.get(id)?.appProperties.kind === "revision"
        ? new Blob(["corrupt"])
        : read(id);
    await expect(
      migrate(backup, repo, approved(backup), decode),
    ).rejects.toThrow();
    expect(await db.get(`google:alice:migration:${backup.id}`)).toMatchObject({
      state: "failed",
      total: 6,
    });
  });
});

describe("import plan", () => {
  it("creates only the chosen ideas but keeps all of them in the backup", async () => {
    const { repo, remote } = setup();
    const ideas = incoming(5);
    const backup = await backupOf(ideas, false);
    const plan: ImportPlan = { create: [ideas[0].id, ideas[3].id] };
    const result = await migrate(
      backup,
      repo,
      approved(backup),
      decode,
      undefined,
      plan,
    );
    expect(result.total).toBe(2);
    expect(remote.ofKind("revision")).toHaveLength(2);
    expect(backup.sources[0].ideas).toHaveLength(5);
    // only a picture of a created idea is uploaded
    expect(remote.ofKind("image")).toHaveLength(0);
  });

  it("updates only the completion state and GitHub links of an existing idea", async () => {
    const { repo, remote } = setup();
    const existing = {
      ...makeIdea("기존", "google:alice"),
      plain_text: "기존 설명",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "기존 설명" }] },
        ],
      },
      images: [
        {
          id: "k",
          storage_path: `drive-sha:${"a".repeat(64)}`,
          original_filename: "k.png",
        },
      ],
      tags: ["보존"],
      links: [
        {
          id: "w",
          type: "website" as const,
          label: "사이트",
          url: "https://example.com",
        },
      ],
    };
    const saved = await repo.save(existing, null);
    const backup = await backupOf(incoming(1), false);
    const plan: ImportPlan = {
      create: [],
      updates: [
        {
          id: existing.id,
          version: saved.idea.version,
          changes: {
            completed: true,
            github: [
              {
                id: "g",
                type: "github",
                label: "repo",
                url: "https://github.com/a/b",
              },
            ],
          },
        },
      ],
    };
    const result = await migrate(
      backup,
      repo,
      approved(backup),
      decode,
      undefined,
      plan,
    );
    expect(result.state).toBe("verified");
    const after = (await repo.list()).find(
      (r) => r.idea.id === existing.id,
    )!.idea;
    expect(after).toMatchObject({
      is_completed: true,
      title: "기존",
      plain_text: "기존 설명",
      tags: ["보존"],
      version: saved.idea.version + 1,
    });
    expect(after.content).toEqual(existing.content);
    expect(after.images).toEqual(existing.images);
    expect(after.links.map((l) => l.url)).toEqual([
      "https://example.com",
      "https://github.com/a/b",
    ]);
    // the old revision is still there
    expect(remote.ofKind("revision")).toHaveLength(2);
    // running it again changes nothing
    const again = await migrate(backup, repo, approved(backup), decode);
    expect(again.state).toBe("verified");
    expect(remote.ofKind("revision")).toHaveLength(2);
  });

  it("refuses to update an idea that changed after the preview", async () => {
    const { repo, remote } = setup();
    const existing = { ...makeIdea("기존", "google:alice"), plain_text: "t" };
    const first = await repo.save(existing, null);
    await repo.save({ ...first.idea, title: "다른 기기에서 수정" }, first.head);
    const backup = await backupOf(incoming(1), false);
    await expect(
      migrate(backup, repo, approved(backup), decode, undefined, {
        create: [],
        updates: [
          {
            id: existing.id,
            version: first.idea.version, // what the preview saw
            changes: { completed: true, github: [] },
          },
        ],
      }),
    ).rejects.toThrow("다시 검토");
    expect(remote.ofKind("revision")).toHaveLength(2); // nothing was written
  });

  it("a resumed run keeps the choices made in the preview", async () => {
    const { repo, remote, fresh } = setup();
    const ideas = incoming(4);
    const backup = await backupOf(ideas, false);
    remote.beforeCreate = (index) => {
      if (index > 1) throw new Error("network offline");
    };
    await expect(
      migrate(backup, repo, approved(backup), decode, undefined, {
        create: [ideas[1].id],
      }),
    ).rejects.toThrow();
    remote.beforeCreate = undefined;
    // the retry button passes no plan: the stored one applies
    await migrate(backup, fresh(), approved(backup), decode);
    expect(remote.ofKind("revision").map((f) => f.blob).length).toBe(1);
  });
});
