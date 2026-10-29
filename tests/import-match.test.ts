import { describe, expect, it } from "vitest";
import {
  alreadyApplied,
  applyChanges,
  changesFor,
  describeChanges,
  hasChanges,
  reviewImport,
} from "../src/lib/import-match";
import { makeIdea, type Idea, type IdeaLink } from "../src/lib/model";

const github = (url: string): IdeaLink => ({
  id: url,
  type: "github",
  label: "repo",
  url,
});
const idea = (
  title: string,
  text: string,
  extra: Partial<Idea> = {},
  owner = "google:alice",
): Idea => ({ ...makeIdea(title, owner), plain_text: text, ...extra });

describe("finding what already exists", () => {
  it("a new idea is created and nothing is flagged", () => {
    const [item] = reviewImport(
      [idea("새 아이디어", "본문")],
      [idea("다른", "다름")],
    );
    expect(item.action).toBe("create");
    expect(item.match).toBeUndefined();
  });

  it("matches by id, by source and by title with text", () => {
    const stored = idea("오목 AI", "본문입니다");
    const imported = idea("전혀 다른 제목", "다른 본문", {
      provenance: {
        source: "docx:x",
        source_id: "3",
        original_owner: "a",
        fingerprint: "f",
      },
    });
    const bySource = idea("출처", "출처 본문", {
      provenance: {
        source: "docx:x",
        source_id: "3",
        original_owner: "a",
        fingerprint: "g",
      },
    });
    const items = reviewImport(
      [
        { ...idea("바뀐 제목", "바뀐 본문"), id: stored.id },
        imported,
        idea("오목 AI", "본문입니다"),
      ],
      [stored, bySource],
    );
    expect(items.map((i) => i.match?.reason)).toEqual([
      "id",
      "source",
      "content",
    ]);
    expect(items.every((i) => i.action === "skip")).toBe(true);
  });

  it("ignores case, spacing and Unicode form but not different words", () => {
    const stored = idea("My  Idea", "Hello   World\n again");
    const [same, different] = reviewImport(
      [
        idea("my idea", "hello world again"),
        idea("my idea", "hello world later"),
      ],
      [stored],
    );
    expect(same.match?.reason).toBe("content");
    expect(different.match).toBeUndefined();
    const [width] = reviewImport(
      [idea("ＡＢＣ", "ｔｅｘｔ")],
      [idea("abc", "text")],
    );
    expect(width.match?.reason).toBe("content");
  });

  it("never merges notes without text by their title", () => {
    const [item] = reviewImport(
      [idea("제목 없는 아이디어", "")],
      [idea("제목 없는 아이디어", "")],
    );
    expect(item.match).toBeUndefined();
    expect(item.action).toBe("create");
  });

  it("flags a repeat inside the file, with nothing to update", () => {
    const [first, again] = reviewImport(
      [idea("반복", "같은 본문"), idea("반복", "같은 본문")],
      [],
    );
    expect(first.action).toBe("create");
    expect(again.match?.reason).toBe("file");
    expect(again.action).toBe("skip");
    expect(again.changes).toBeUndefined();
  });

  it("recognises ideas that an earlier Word import created", () => {
    const fromWord = idea("명지대 통닭트럭", "트럭 아이디어 본문", {
      id: "word-abc-1",
      provenance: {
        source: "docx:abc",
        source_id: "1",
        original_owner: "alice",
        fingerprint: "f",
      },
      imports: [{ file_hash: "abc", item_id: "1" }],
    });
    const [sameId, sameSource, sameText, other] = reviewImport(
      [
        { ...idea("바뀐 제목", "바뀐 본문"), id: "word-abc-1" },
        idea("다른 제목", "다른 본문", {
          provenance: {
            source: "docx:abc",
            source_id: "1",
            original_owner: "bob",
            fingerprint: "g",
          },
        }),
        idea("명지대 통닭트럭", "트럭 아이디어   본문"),
        idea("전혀 다른", "아이디어"),
      ],
      [fromWord],
    );
    expect(sameId.match?.reason).toBe("id");
    expect(sameSource.match?.reason).toBe("source");
    expect(sameText.match?.reason).toBe("content");
    expect(other.match).toBeUndefined();
    expect(
      [sameId, sameSource, sameText].every((i) => i.action === "skip"),
    ).toBe(true);
  });

  it("a match in the trash is still a match", () => {
    const trashed = idea("휴지통", "본문", {
      deleted_at: "2026-01-01T00:00:00.000Z",
    });
    const [item] = reviewImport([idea("휴지통", "본문")], [trashed]);
    expect(item.match?.existing.deleted_at).toBeTruthy();
  });
});

describe("what an update may change", () => {
  it("proposes only a different completion state and GitHub links it lacks", () => {
    const stored = idea("a", "t", {
      links: [github("https://github.com/x/y")],
    });
    const incoming = idea("a", "t", {
      is_completed: true,
      links: [
        github("https://github.com/x/y/"), // same repository, trailing slash
        github("https://github.com/x/z"),
        { id: "w", type: "website", label: "site", url: "https://example.com" },
      ],
    });
    const changes = changesFor(incoming, stored);
    expect(changes.completed).toBe(true);
    expect(changes.github.map((l) => l.url)).toEqual([
      "https://github.com/x/z",
    ]);
    expect(describeChanges(changes)).toContain("완료");
    expect(describeChanges(changes)).toContain("GitHub 링크 1개");
  });

  it("reports nothing to change when both already agree", () => {
    const changes = changesFor(idea("a", "t"), idea("a", "t"));
    expect(hasChanges(changes)).toBe(false);
    expect(describeChanges(changes)).toBe("바뀌는 내용 없음");
  });

  it("applyChanges keeps the description, images, tags, title and website links", () => {
    const stored = idea("제목", "설명", {
      tags: ["a"],
      images: [
        { id: "i", storage_path: "drive-sha:abc", original_filename: "x.png" },
      ],
      links: [
        { id: "w", type: "website", label: "s", url: "https://example.com" },
      ],
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    const next = applyChanges(
      stored,
      { completed: true, github: [github("https://github.com/x/y")] },
      "2026-05-05T00:00:00.000Z",
    );
    expect(next).toMatchObject({
      title: "제목",
      plain_text: "설명",
      tags: ["a"],
      is_completed: true,
      updated_at: "2026-05-05T00:00:00.000Z",
      id: stored.id,
    });
    expect(next.images).toEqual(stored.images);
    expect(next.content).toEqual(stored.content);
    expect(next.links.map((l) => l.url)).toEqual([
      "https://example.com",
      "https://github.com/x/y",
    ]);
    expect(stored.is_completed).toBe(false); // the original is not mutated
  });

  it("does not add a link twice and recognises a finished update", () => {
    const stored = idea("a", "t", {
      links: [github("https://github.com/x/y")],
    });
    const changes = {
      completed: true,
      github: [github("https://github.com/x/y")],
    };
    expect(applyChanges(stored, changes).links).toHaveLength(1);
    expect(alreadyApplied(stored, changes)).toBe(false); // not completed yet
    expect(alreadyApplied({ ...stored, is_completed: true }, changes)).toBe(
      true,
    );
    expect(
      alreadyApplied(stored, { github: [github("https://github.com/q/r")] }),
    ).toBe(false);
  });
});
