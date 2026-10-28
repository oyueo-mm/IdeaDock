import { test, expect, type Page } from "@playwright/test";
import { createIdea, openNav, openData } from "./helpers";
import { docxFixture } from "../support/docx-fixture";
import AxeBuilder from "@axe-core/playwright";
async function folder(page: Page, name: string) {
  await openNav(page);
  page.once("dialog", (d) => d.accept(name));
  await page
    .getByRole("button", { name: "새 폴더 만들기", exact: true })
    .click();
  await expect(
    page.locator(".folder-list-row").filter({ hasText: name }),
  ).toBeVisible();
}
async function list(page: Page) {
  const close = page.getByRole("button", {
    name: "상세 패널 닫기",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
}
test.beforeEach(async ({ page }) => {
  await page.goto("./");
  await page
    .getByRole("button", { name: "체험 모드 열기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "체험 데이터 안내 닫기", exact: true })
    .click();
});
test("folders, nested membership, trash and restore survive reload", async ({
  page,
}) => {
  await folder(page, "인공지능");
  await page
    .locator(".folder-list-row")
    .filter({ hasText: "인공지능" })
    .locator(".idea-summary")
    .dblclick();
  await folder(page, "강화학습");
  await page
    .locator(".folder-list-row")
    .filter({ hasText: "강화학습" })
    .locator(".idea-summary")
    .dblclick();
  await createIdea(page, "오목 AI");
  await page
    .getByRole("textbox", { name: "아이디어 본문", exact: true })
    .fill("원본 설명");
  await list(page);
  await expect(
    page.getByRole("navigation", { name: "폴더 경로" }),
  ).toContainText("강화학습");
  await page.reload();
  await page
    .getByRole("button", { name: "체험 모드 열기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "체험 데이터 안내 닫기", exact: true })
    .click();
  await openNav(page);
  await page
    .getByRole("button", { name: "내 아이디어", exact: true })
    .first()
    .click();
  const root = page.locator(".folder-list-row").filter({ hasText: "인공지능" });
  await root.locator(".idea-summary").click();
  await page
    .getByRole("button", { name: "휴지통으로 이동", exact: true })
    .click();
  await openNav(page);
  await page.getByRole("button", { name: /^휴지통/ }).click();
  await expect(
    page.getByRole("article").filter({ hasText: "오목 AI" }),
  ).toHaveCount(1);
  await page
    .locator(".folder-list-row")
    .filter({ hasText: "인공지능" })
    .locator(".idea-summary")
    .click();
  await page
    .getByRole("button", { name: "선택 항목 복원", exact: true })
    .click();
  const cache = await page.evaluate(() => ({
    ideas: JSON.parse(localStorage.getItem("ideadock:data:demo")!),
    folders: JSON.parse(localStorage.getItem("ideadock:folders:demo:v2")!),
  }));
  expect(cache.ideas.ideas[0].plain_text).toBe("원본 설명");
  expect(cache.folders.folders).toHaveLength(2);
  expect(
    cache.folders.folders.every(
      (f: { deleted_at: string | null }) => f.deleted_at === null,
    ),
  ).toBe(true);
  expect(cache.ideas.ideas[0].folder_id).toBe(
    cache.folders.folders.find((f: { name: string }) => f.name === "강화학습")
      .id,
  );
});
test("Ctrl and Shift selection, keyboard scope and multi-item drag move", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Mouse and keyboard path");
  await folder(page, "목적지");
  for (const name of ["하나", "둘", "셋"]) {
    await createIdea(page, name);
    await list(page);
  }
  const rows = page
    .locator(".explorer-list article")
    .filter({ has: page.locator(".completion-check") });
  await rows.nth(0).locator(".idea-summary").click();
  await rows
    .nth(1)
    .locator(".idea-summary")
    .click({ modifiers: ["Control"] });
  await expect(
    page.getByRole("heading", { name: "2개 선택됨", exact: true }),
  ).toBeVisible();
  await rows
    .nth(2)
    .locator(".idea-summary")
    .click({ modifiers: ["Shift"] });
  await expect(
    page.getByRole("heading", { name: "2개 선택됨", exact: true }),
  ).toBeVisible();
  await page.getByRole("region", { name: "폴더와 아이디어 목록" }).focus();
  await page.keyboard.press("Control+a");
  await expect(
    page.getByRole("heading", { name: "4개 선택됨", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await rows.nth(0).locator(".idea-summary").click();
  await rows
    .nth(1)
    .locator(".idea-summary")
    .click({ modifiers: ["Control"] });
  await rows
    .nth(0)
    .dragTo(page.locator(".folder-list-row").filter({ hasText: "목적지" }));
  await page
    .locator(".folder-list-row")
    .filter({ hasText: "목적지" })
    .locator(".idea-summary")
    .dblclick();
  await expect(page.locator(".explorer-list article")).toHaveCount(2);
  await page
    .locator(".explorer-list article")
    .first()
    .locator(".idea-summary")
    .click();
  const title = page.getByRole("textbox", {
    name: "아이디어 제목 편집",
    exact: true,
  });
  await title.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await expect(title).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(title).toBeVisible();
  await expect(page.locator(".explorer-list article")).toHaveCount(2);
});
test("rectangle selection and folder context rename", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Mouse path");
  await folder(page, "이름 전");
  const row = page.locator(".folder-list-row");
  await row.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "항목 작업" })).toBeVisible();
  page.once("dialog", (d) => d.accept("이름 후"));
  await page.getByRole("menuitem", { name: "이름 변경", exact: true }).click();
  await expect(row).toContainText("이름 후");
  for (const name of ["A", "B"]) {
    await createIdea(page, name);
    await list(page);
  }
  const region = page.getByRole("region", { name: "폴더와 아이디어 목록" });
  const blank = page.locator(".explorer-blank");
  await blank.scrollIntoViewIfNeeded();
  const b = await blank.boundingBox(),
    r = await region.boundingBox();
  await page.mouse.move(b!.x + b!.width - 8, b!.y + 15);
  await page.mouse.down();
  await page.mouse.move(r!.x + 3, r!.y + 3, { steps: 15 });
  await expect(page.locator(".selection-marquee")).toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole("heading", { name: /개 선택됨/ })).toBeVisible();
});
test("mobile long press enters selection mode and explicit move works", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "mobile", "Touch path");
  await folder(page, "모바일 폴더");
  for (const name of ["모바일 하나", "모바일 둘"]) {
    await createIdea(page, name);
    await list(page);
  }
  const rows = page
    .locator(".explorer-list article")
    .filter({ has: page.locator(".completion-check") });
  const bounds = await rows.first().locator(".idea-summary").boundingBox();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: bounds!.x + 30, y: bounds!.y + 15 }],
  });
  await page.waitForTimeout(650);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(
    page.getByRole("heading", { name: "1개 선택됨", exact: true }),
  ).toBeVisible();
  await rows.nth(1).locator(".idea-summary").tap();
  await expect(
    page.getByRole("heading", { name: "2개 선택됨", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "이동", exact: true }).click();
  await page
    .getByRole("combobox", { name: "이동할 폴더", exact: true })
    .selectOption({ label: "모바일 폴더" });
  await page
    .getByRole("button", { name: "선택 항목 이동", exact: true })
    .click();
  await page.locator(".folder-list-row").locator(".idea-summary").dblclick();
  await expect(page.locator(".explorer-list article")).toHaveCount(2);
});
test("Word preview preserves paragraphs and images and does not write on selection", async ({
  page,
}) => {
  await openData(page);
  await page
    .getByRole("button", { name: "Word 가져오기", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "Word 가져오기",
    exact: true,
  });
  await page.getByLabel("Word 문서 선택", { exact: true }).setInputFiles({
    name: "만들거.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from(docxFixture()),
  });
  await expect(
    modal.getByRole("textbox", { name: "항목 1 제목", exact: true }),
  ).toHaveValue("오목 AI");
  await expect(
    modal.getByRole("textbox", { name: "항목 2 제목", exact: true }),
  ).toHaveValue("명지대 통닭트럭");
  await expect(
    modal.getByRole("img", { name: "map.png", exact: true }),
  ).toBeVisible();
  await expect(
    modal
      .locator(".word-body")
      .filter({ hasText: "여러 문단을 하나로 보존합니다." }),
  ).toBeVisible();
  await expect(
    modal.getByRole("checkbox", { name: "항목 1 완료", exact: true }),
  ).not.toBeChecked();
  await expect(
    modal.getByRole("button", {
      name: "복구 백업 생성 후 선택 항목 가져오기 승인",
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => localStorage.getItem("ideadock:data:demo")),
  ).toBeNull();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});
