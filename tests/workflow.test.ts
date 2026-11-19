import { describe, expect, it } from "vitest";
import { inferLinkType, makeIdea, normalizeIdeaUrl } from "../src/lib/model";
import { validateIdeas } from "../src/lib/integrity";
import { addImprovement, restoreCheckpoint, saveCheckpoint } from "../src/lib/workflow";
import { prepareBackup, validateBackup } from "../src/lib/migration";

describe("link quick add normalization", () => {
  it.each([
    ["github.com/oyueo-mm/IdeaDock", "https://github.com/oyueo-mm/IdeaDock"],
    ["oyueo-mm.github.io/IdeaDock/", "https://oyueo-mm.github.io/IdeaDock/"],
    ["https://oyueo-mm.github.io/IdeaDock/", "https://oyueo-mm.github.io/IdeaDock/"],
    ["http://localhost:3000/", "http://localhost:3000/"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeIdeaUrl(input)).toBe(expected);
  });
  it.each(["javascript:alert(1)", "data:text/html,hello", "file:///tmp/x", "//evil.example", "https:", "https://", "https://a:b@example.com", "hello world", ""])("rejects unsafe input %s", (input) => {
    expect(normalizeIdeaUrl(input)).toBeNull();
  });
  it("treats GitHub Pages as a website, not a repository", () => {
    expect(inferLinkType("https://github.com/a/b")).toBe("github");
    expect(inferLinkType("https://a.github.io/b/")).toBe("website");
  });
});

describe("improvements and explicit versions", () => {
  it("preserves legacy idea schema and completion independence", () => {
    const idea = makeIdea("기존 아이디어", "demo");
    validateIdeas([idea]);
    expect(idea.improvements).toBeUndefined();
    expect(idea.checkpoints).toBeUndefined();
    const improved = { ...idea, is_completed: true, improvements: addImprovement(idea, "개선 필요") };
    expect(improved.is_completed).toBe(true);
    expect(improved.improvements[0].is_done).toBe(false);
    validateIdeas([improved]);
  });
  it("saves a version without mutating the source and restores through a safety snapshot", () => {
    const original = makeIdea("초기 버전", "demo");
    const notes = addImprovement(original, "제안 수정");
    const done = notes.map((note) => ({ ...note, is_done: true, completed_at: new Date().toISOString() }));
    const source = { ...original, improvements: done };
    const saved = saveCheckpoint(source, "v1.0", "최초 구현");
    const versioned = { ...source, ...saved };
    expect(source.checkpoints).toBeUndefined();
    expect(versioned.improvements[0].version_id).toBe(saved.checkpoints?.[0].id);
    const newer = { ...versioned, title: "업데이트된 버전", plain_text: "새 본문" };
    const restored = { ...newer, ...restoreCheckpoint(newer, versioned.checkpoints![0]) };
    expect(restored.title).toBe("초기 버전");
    expect(restored.checkpoints).toHaveLength(2);
    expect(restored.checkpoints![1].snapshot.title).toBe("업데이트된 버전");
    expect(restored.checkpoints![1].snapshot.plain_text).toBe("새 본문");
    validateIdeas([restored]);
  });
  it("rejects corrupted snapshot metadata", () => {
    const idea = makeIdea("테스트", "demo");
    const saved = saveCheckpoint(idea, "v1.0");
    const corrupted = { ...idea, ...saved, checkpoints: saved.checkpoints!.map((c) => ({ ...c, snapshot: { ...c.snapshot, links: [{ id: "bad", type: "website" as const, label: "위험", url: "javascript:alert(1)" }] } })) };
    expect(() => validateIdeas([corrupted])).toThrow();
  });
  it("backs up historical image data even after it leaves the current version", async () => {
    const idea = makeIdea("이미지 이력", "demo");
    const image = { id: crypto.randomUUID(), storage_path: "backup-image", original_filename: "img.png" };
    const versioned = { ...idea, images: [image] };
    const saved = saveCheckpoint(versioned, "v1.0");
    const latest = { ...versioned, ...saved, images: [] };
    const backup = await prepareBackup([{ id: "demo", label: "테스트", ideas: [latest] }], async (path) => new Blob([path]), async (blob) => await blob.text(), null);
    expect(backup.images.map((item) => item.path)).toContain("backup-image");
    await expect(validateBackup(backup, async (data) => new Blob([data]))).resolves.toBeUndefined();
  });
});
