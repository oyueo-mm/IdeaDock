import { createIdea, openNav } from "./helpers";
import { test, expect, type Page, type Locator } from "@playwright/test";

test.beforeEach(async ({ page, context }) => {
  // Link shortcuts open real sites in a new tab; answer them locally.
  await context.route(/^https:\/\/(github\.com|example\.com)\//, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>ok</title>" }),
  );
  await page.goto("./");
  await page.getByRole("button", { name: "체험 모드 열기" }).click();
});
const box = async (l: Locator) => (await l.boundingBox())!;
const body = (page: Page) =>
  page.getByRole("textbox", { name: "아이디어 본문" });
const row = (page: Page, title: string) =>
  page.getByRole("article").filter({ hasText: title });
async function addLink(
  page: Page,
  type: "website" | "github",
  label: string,
  url: string,
) {
  await page.getByRole("button", { name: "관련 링크 추가" }).click();
  await page.getByRole("combobox", { name: "링크 종류" }).selectOption(type);
  await page.getByRole("textbox", { name: "링크 이름" }).fill(label);
  await page.getByRole("textbox", { name: "링크 URL" }).fill(url);
  await page.getByRole("button", { name: "링크 저장" }).click();
}
async function closeDetail(page: Page) {
  await page.getByRole("button", { name: "상세 패널 닫기" }).click();
}

test("the body starts under the title, grows with long text and survives a reload", async ({
  page,
}, info) => {
  const mobile = info.project.name === "mobile";
  await createIdea(page, "긴 글 아이디어");
  const title = await box(
    page.getByRole("textbox", { name: "아이디어 제목 편집", exact: true }),
  );
  const toolbar = await box(page.locator(".editor-toolbar"));
  expect(toolbar.y - (title.y + title.height)).toBeLessThanOrEqual(12);
  await expect(page.getByText("아이디어 메모")).toHaveCount(0);
  const editor = page.locator(".tiptap");
  await expect(editor.locator("p.is-editor-empty")).toHaveAttribute(
    "data-placeholder",
    /아이디어/,
  );
  const empty = await box(editor);
  expect(empty.height).toBeGreaterThanOrEqual(mobile ? 180 : 260);
  expect(empty.height).toBeLessThanOrEqual(mobile ? 230 : 310);

  // Typing many lines keeps focus and the cursor at the end while saves run.
  await body(page).click();
  for (let i = 1; i <= 25; i++) {
    await page.keyboard.type(`줄 ${i}`);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.type("마지막 줄");
  await expect(body(page)).toBeFocused();
  await expect(editor.locator("p").last()).toHaveText("마지막 줄");
  await expect(editor.locator("p")).toHaveCount(26);
  const grown = await box(editor);
  expect(grown.height).toBeGreaterThan(empty.height + 200);
  // The editor itself never scrolls; only the panel does.
  expect(
    await editor.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  ).toBe(true);
  expect(
    await page
      .locator(".detail-scroll")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);

  await page.reload();
  await page.getByRole("button", { name: "체험 모드 열기" }).click();
  await expect(editor.locator("p")).toHaveCount(26);
  await expect(editor.locator("p").first()).toHaveText("줄 1");
  await expect(editor.locator("p").last()).toHaveText("마지막 줄");
});

test("tags are added with a visible button, Enter and Escape, without duplicates", async ({
  page,
}) => {
  await createIdea(page, "태그 아이디어");
  const chips = page.locator(".editable-tags .tag-chip");
  await expect(chips).toHaveCount(0);
  const add = page.getByRole("button", { name: "태그 추가" });
  await expect(add).toBeVisible();
  await add.click();
  const input = page.getByRole("textbox", { name: "태그 추가" });
  await expect(input).toBeFocused();
  await input.fill("수학");
  await input.press("Enter");
  // The field stays open for the next tag; a duplicate is ignored.
  await expect(input).toBeFocused();
  await input.fill("#수학");
  await input.press("Enter");
  await input.fill("시각화");
  await input.press("Enter");
  await expect(chips).toHaveText(["수학", "시각화"]);
  // Escape throws away what was typed.
  await input.fill("버릴 태그");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(chips).toHaveCount(2);
  await expect(
    page.getByRole("textbox", { name: "아이디어 제목 편집", exact: true }),
  ).toBeVisible();
  // Over-long tags are refused as before.
  await add.click();
  await input.fill("가".repeat(51));
  await input.press("Enter");
  await expect(
    page.getByText("태그는 50자 이하로 입력해 주세요."),
  ).toBeVisible();
  await expect(chips).toHaveCount(2);
  await input.press("Escape");
  await page.getByRole("button", { name: "수학 태그 삭제" }).click();
  await expect(chips).toHaveText(["시각화"]);
});

test("list rows open GitHub and website links directly without touching the row", async ({
  page,
  context,
}, info) => {
  const mobile = info.project.name === "mobile";
  await createIdea(page, "링크 없는 아이디어");
  await closeDetail(page);
  await createIdea(page, "링크 아이디어");
  await addLink(
    page,
    "github",
    "저장소",
    "https://github.com/oyueo-mm/IdeaDock",
  );
  await addLink(page, "website", "배포", "https://example.com/app");
  await addLink(page, "website", "문서", "https://example.com/docs");
  await addLink(page, "github", "포크", "https://github.com/someone/fork");
  // The detail keeps every link and its type.
  await expect(page.locator(".link-row")).toHaveCount(4);
  await closeDetail(page);

  await expect(
    row(page, "링크 없는 아이디어").locator(".row-link"),
  ).toHaveCount(0);
  const target = row(page, "링크 아이디어");
  const github = target.getByRole("link", {
    name: "링크 아이디어 GitHub 열기",
  });
  const site = target.getByRole("link", {
    name: "링크 아이디어 웹사이트 열기",
  });
  await expect(target.locator(".row-link")).toHaveCount(2);
  // The first link of each type represents it.
  await expect(github).toHaveAttribute(
    "href",
    "https://github.com/oyueo-mm/IdeaDock",
  );
  await expect(site).toHaveAttribute("href", "https://example.com/app");
  for (const l of [github, site]) {
    await expect(l).toHaveAttribute("target", "_blank");
    await expect(l).toHaveAttribute("rel", "noopener noreferrer");
    await expect(l).toBeVisible();
  }

  const summary = target.locator(".idea-summary");
  const check = target.locator(".completion-check");
  const pressed = await summary.getAttribute("aria-pressed");
  const url = page.url();
  for (const [l, expected] of [
    [github, "https://github.com/oyueo-mm/IdeaDock"],
    [site, "https://example.com/app"],
  ] as const) {
    const popup = context.waitForEvent("page");
    if (mobile) await l.tap();
    else await l.click();
    const tab = await popup;
    await expect.poll(() => tab.url()).toBe(expected);
    await tab.close();
  }
  // Nothing else happened: no selection, no detail, no completion, same page.
  expect(page.url()).toBe(url);
  await expect(summary).toHaveAttribute("aria-pressed", pressed ?? "false");
  await expect(check).not.toBeChecked();
  await expect(
    page.getByRole("textbox", { name: "아이디어 제목 편집", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /개 선택됨/ })).toHaveCount(0);
  // Touch targets stay large enough to hit.
  if (mobile) expect((await box(github)).width).toBeGreaterThanOrEqual(32);

  // Completion and pinning still work from the same row.
  await check.check();
  await expect(check).toBeChecked();
  await openNav(page);
});
