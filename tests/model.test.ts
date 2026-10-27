import { describe, it, expect } from "vitest";
import {
  makeIdea,
  selectIdeas,
  validUrl,
  validateImage,
} from "../src/lib/model";
describe("safe links and uploads", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,evil",
    "file:///secret",
    "https://",
    "https://name:password@example.com",
  ])("rejects %s", (value) => expect(validUrl(value)).toBe(false));
  it.each(["https://github.com/oyueo-mm/FourierLab", "http://localhost:3000/"])(
    "accepts %s",
    (value) => expect(validUrl(value)).toBe(true),
  );
  it("rejects executable SVGs and files over the size limit", () => {
    expect(() => validateImage({ type: "image/svg+xml", size: 200 })).toThrow();
    expect(() => validateImage({ type: "image/png", size: 5242881 })).toThrow();
    expect(() =>
      validateImage({ type: "image/webp", size: 5242880 }),
    ).not.toThrow();
  });
});
describe("idea library", () => {
  const a = {
    ...makeIdea("푸리에 급수 시각화", "user"),
    is_completed: true,
    tags: ["수학"],
    plain_text: "파형을 겹쳐서 관찰",
  };
  const b = { ...makeIdea("읽은 책 기록", "user"), is_pinned: true };
  const deleted = {
    ...makeIdea("휴지통 메모", "user"),
    deleted_at: new Date().toISOString(),
  };
  it("creates an idea with only a title", () =>
    expect(makeIdea(" 작은 생각 ", "user")).toMatchObject({
      title: "작은 생각",
      links: [],
      images: [],
      version: 0,
    }));
  it("finds completed ideas by body and tag", () => {
    expect(selectIdeas([a, b], "completed", "", "파형", "updated")).toEqual([
      a,
    ]);
    expect(selectIdeas([a, b], "all", "", "수학", "updated")).toEqual([a]);
    expect(a.title).toBe("푸리에 급수 시각화");
  });
  it("keeps pinned ideas first and soft-deleted ideas separate", () => {
    expect(selectIdeas([a, deleted, b], "all", "", "", "title")).toEqual([
      b,
      a,
    ]);
    expect(selectIdeas([a, deleted, b], "trash", "", "", "updated")).toEqual([
      deleted,
    ]);
  });
  it("handles hundreds of ideas with long titles and bodies", () => {
    const batch = Array.from({ length: 500 }, (_, n) => ({
      ...makeIdea(`생각 ${n} ${"긴 제목 ".repeat(50)}`, "user"),
      plain_text: "본문 ".repeat(2000),
    }));
    expect(selectIdeas(batch, "all", "", "생각 499", "updated")).toHaveLength(
      1,
    );
  });
});
