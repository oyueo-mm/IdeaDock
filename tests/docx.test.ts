// @vitest-environment jsdom
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { parseDocx, duplicateCandidates } from "../src/lib/docx";
import { docxFixture, pixel } from "./support/docx-fixture";
import { validateIdeas, imageNodes, canonical } from "../src/lib/integrity";
import { makeIdea } from "../src/lib/model";
import { DriveRepository } from "../src/lib/drive";
import { importWord } from "../src/lib/word-import";
import { MemoryDb, MemoryRemote } from "./support/memory";
vi.mock("../src/lib/images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/images")>();
  return {
    ...actual,
    dataUrl: async (b: Blob) =>
      `data:${b.type};base64,${Buffer.from(await b.arrayBuffer()).toString("base64")}`,
  };
});
beforeAll(() => {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("crypto", webcrypto);
});
afterAll(() => vi.unstubAllGlobals());
const file = (body?: string, ext?: string) =>
  new File([docxFixture(body, ext)], "만들거.docx");
const setup = () => {
  const db = new MemoryDb(),
    remote = new MemoryRemote(),
    repo = new DriveRepository("alice", remote, db);
  return { db, remote, repo };
};
describe("browser Word parsing", () => {
  it("flags duplicate items inside one document and uses stable image identities", async () => {
    const body =
      "<w:p><w:r><w:t>Same</w:t></w:r></w:p><w:p><w:r><w:t>=====</w:t></w:r></w:p><w:p><w:r><w:t>Same</w:t></w:r></w:p>";
    const p = await parseDocx(file(body), "alice");
    expect(p.candidates[1].action).toBe("skip");
    expect(p.candidates[1].warnings[0]).toContain("중복");
    const a = await parseDocx(file(), "alice"),
      b = await parseDocx(file(), "alice");
    expect(a.candidates[1].idea.images[0].id).toBe(
      b.candidates[1].idea.images[0].id,
    );
  });
  it("splits on separators without splitting consecutive description paragraphs", async () => {
    const preview = await parseDocx(file(), "alice");
    expect(preview.candidates.map((c) => c.idea.title)).toEqual([
      "오목 AI",
      "명지대 통닭트럭",
    ]);
    expect(preview.candidates[0].idea.plain_text).toBe(
      "첫 번째 설명입니다.\n여러 문단을 하나로 보존합니다.",
    );
    expect(preview.candidates.every((c) => !c.idea.is_completed)).toBe(true);
    validateIdeas(preview.candidates.map((c) => c.idea));
  });
  it("retains source order, image bytes, image node references and actual hyperlinks", async () => {
    const preview = await parseDocx(file(), "alice"),
      idea = preview.candidates[1].idea;
    expect(idea.links[0].url).toBe("https://example.com/actual-post");
    expect(idea.images).toHaveLength(1);
    expect(
      new Uint8Array(
        await (await fetch(idea.images[0].storage_path)).arrayBuffer(),
      ),
    ).toEqual(pixel);
    expect(imageNodes(idea.content)[0].attrs).toEqual(idea.images[0]);
    expect(
      preview.original.startsWith("data:application/vnd.openxmlformats"),
    ).toBe(true);
  });
  it("supports title-only items and heading styles in Korean and English", async () => {
    const p = await parseDocx(
      file(
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title only 제목</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>신경망 시각화</w:t></w:r></w:p>',
      ),
      "alice",
    );
    expect(p.candidates).toHaveLength(2);
    expect(p.candidates[0].idea.plain_text).toBe("");
  });
  it("warns rather than silently dropping unsupported images", async () => {
    const p = await parseDocx(file(undefined, "emf"), "alice");
    expect(p.candidates[1].warnings[0]).toMatch(/PNG|이미지/);
    expect(p.candidates[1].idea.images).toHaveLength(0);
    expect(p.original).toBeTruthy();
  });
  it("keeps ambiguous long documents together and requires review", async () => {
    const p = await parseDocx(
      file(
        Array.from(
          { length: 6 },
          (_, i) => `<w:p><w:r><w:t>원문 ${i}</w:t></w:r></w:p>`,
        ).join(""),
      ),
      "alice",
    );
    expect(p.candidates).toHaveLength(1);
    expect(p.warnings).toHaveLength(1);
    expect(p.candidates[0].idea.plain_text).toContain("원문 5");
  });
  it("detects same titles, similar bodies and prior source markers without guessing completion", async () => {
    const p = await parseDocx(file(), "alice");
    const old = {
      ...makeIdea("다른 제목", "alice"),
      imports: [{ file_hash: p.fileHash, item_id: p.candidates[0].key }],
    };
    expect(duplicateCandidates(p.candidates[0].idea, [old])).toEqual([old]);
    const repeated = await parseDocx(file(), "alice", [p.candidates[0].idea]);
    expect(repeated.fileHash).toBe(p.fileHash);
    expect(repeated.candidates[0].action).toBe("skip");
    expect(repeated.candidates[0].idea.is_completed).toBe(false);
  });
  it("rejects non-docx, malformed XML and missing archives", async () => {
    await expect(
      parseDocx(new File(["x"], "x.txt"), "alice"),
    ).rejects.toThrow();
    await expect(
      parseDocx(new File(["x"], "x.docx"), "alice"),
    ).rejects.toThrow();
    await expect(parseDocx(file("<w:p><broken>"), "alice")).rejects.toThrow(
      "XML",
    );
  });
});
describe("Word import approvals, recovery and integrity", () => {
  it("requires explicit file/account and warning approval before writes", async () => {
    const { repo, remote } = setup(),
      p = await parseDocx(file(), "alice");
    await expect(
      importWord(p, [], [], repo, {
        account: "other",
        file: p.fileHash,
        warnings: true,
        merge: false,
      }),
    ).rejects.toThrow("승인");
    expect(remote.files.size).toBe(0);
    const unsupported = await parseDocx(file(undefined, "emf"), "alice");
    await expect(
      importWord(unsupported, [], [], repo, {
        account: "alice",
        file: unsupported.fileHash,
        warnings: false,
        merge: false,
      }),
    ).rejects.toThrow("경고");
    expect(remote.files.size).toBe(0);
  });
  it("backs up before ideas, reads back image bytes and is idempotent", async () => {
    const { repo, remote } = setup(),
      p = await parseDocx(file(), "alice");
    const approval = {
      account: "alice",
      file: p.fileHash,
      warnings: true,
      merge: false,
    };
    const progress = await importWord(p, [], [], repo, approval);
    expect(progress.state).toBe("verified");
    const rows = await repo.list();
    expect(rows).toHaveLength(2);
    expect(await remote.list("image")).toHaveLength(1);
    expect([...remote.files.values()][0].appProperties.kind).toBe("backup");
    await importWord(p, [], [], repo, approval);
    expect(await remote.list("revision")).toHaveLength(2);
    expect(
      rows[1].idea.images[0]?.storage_path ??
        rows[0].idea.images[0].storage_path,
    ).toMatch(/^drive-sha:/);
  });
  it("resumes after interrupted uploads without duplicate ideas", async () => {
    const { repo, remote } = setup(),
      p = await parseDocx(file(), "alice");
    remote.failAt = 4;
    const approval = {
      account: "alice",
      file: p.fileHash,
      warnings: true,
      merge: false,
    };
    await expect(importWord(p, [], [], repo, approval)).rejects.toThrow(
      "offline",
    );
    remote.failAt = 0;
    await importWord(p, [], [], repo, approval);
    expect(await repo.list()).toHaveLength(2);
    expect(await remote.list("revision")).toHaveLength(2);
  });
  it("merges only after approval, preserving the old revision and appending original content", async () => {
    const { repo, remote } = setup();
    const original = {
      ...makeIdea("오목 AI", "alice"),
      plain_text: "기존 본문",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "기존 본문" }] },
        ],
      },
    };
    const saved = await repo.save(original, null),
      p = await parseDocx(file(), "alice");
    p.candidates[0].action = "merge";
    p.candidates[0].mergeId = saved.idea.id;
    p.candidates[1].selected = false;
    await expect(
      importWord(p, [saved.idea], [], repo, {
        account: "alice",
        file: p.fileHash,
        warnings: true,
        merge: false,
      }),
    ).rejects.toThrow("병합");
    await importWord(p, [saved.idea], [], repo, {
      account: "alice",
      file: p.fileHash,
      warnings: true,
      merge: true,
    });
    const rows = await repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].idea.plain_text).toContain("기존 본문\n첫 번째 설명");
    expect(rows[0].idea.imports?.[0].file_hash).toBe(p.fileHash);
    expect(
      (await repo.revisions()).some(
        (r) => canonical(r.revision.idea) === canonical(saved.idea),
      ),
    ).toBe(true);
    expect(await remote.list("revision")).toHaveLength(2);
  });
});
