import { createIdea, openNav } from "./helpers";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.beforeEach(async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "체험 모드 열기" }).click();
});
test("sidebar creation, autosave, completion and reload", async ({ page }) => {
  await createIdea(page, "내가 읽은 책 관리 앱");
  await expect(
    page.getByRole("textbox", { name: "아이디어 제목 편집" }),
  ).toHaveValue("내가 읽은 책 관리 앱");
  const body = page.getByRole("textbox", { name: "아이디어 본문" });
  await body.fill("긴 생각도 차분하게 기록합니다.");
  await page.getByRole("checkbox", { name: "상세 아이디어 완료" }).check();
  await expect(
    page.getByRole("textbox", { name: "아이디어 제목 편집" }),
  ).toHaveCSS("text-decoration-line", "none");
  await page.reload();
  await page.getByRole("button", { name: "체험 모드 열기" }).click();
  await expect(page.getByRole("textbox", { name: "아이디어 본문" })).toHaveText(
    "긴 생각도 차분하게 기록합니다.",
  );
  await expect(
    page.getByRole("checkbox", { name: "상세 아이디어 완료" }),
  ).toBeChecked();
});
test("tags, safe links, trash and restore", async ({ page }) => {
  await createIdea(page, "푸리에 시각화");
  await page.getByRole("textbox", { name: "태그 추가" }).fill("수학");
  await page.getByRole("textbox", { name: "태그 추가" }).press("Enter");
  await page.getByRole("button", { name: "관련 링크 추가" }).click();
  await page
    .getByRole("textbox", { name: "링크 URL" })
    .fill("https://example.com");
  await page.getByRole("button", { name: "링크 저장" }).click();
  await expect(
    page.getByRole("link", {
      name: "웹사이트 https://example.com",
      exact: true,
    }),
  ).toHaveAttribute("target", "_blank");
  await page
    .getByRole("button", { name: "현재 아이디어 휴지통으로 이동" })
    .click();
  await page.getByRole("button", { name: "현재 아이디어 복원" }).click();
  await page.getByRole("button", { name: "상세 패널 닫기" }).click();
  await openNav(page);
  await page
    .locator(".sidebar-tags")
    .getByRole("button", { name: /수학/ })
    .click();
  await expect(
    page.getByRole("article").filter({ hasText: "푸리에 시각화" }),
  ).toHaveCount(1);
});
test("pasted images appear inside the memo and browser back returns to list", async ({
  page,
}) => {
  await createIdea(page, "붙여넣기 테스트");
  const body = page.getByRole("textbox", { name: "아이디어 본문" });
  await body.click();
  await body.evaluate((el) => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(body.getByRole("img", { name: "pasted.png" })).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("textbox", { name: "아이디어 제목 편집" }),
  ).toHaveCount(0);
});
test("workspace and editor pass automated WCAG checks", async ({ page }) => {
  await createIdea(page, "접근성 검사");
  await expect(
    page.getByRole("textbox", { name: "아이디어 본문" }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
  await page.evaluate(() => localStorage.setItem("ideadock:theme", "dark"));
  await page.reload();
  await page.getByRole("button", { name: "체험 모드 열기" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(darkResults.violations).toEqual([]);
});
test("layout and theme persist with no horizontal overflow", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "desktop") {
    await page
      .getByRole("button", { name: "작업 공간 설정", exact: true })
      .click();
    await page.getByRole("button", { name: "다크", exact: true }).click();
    await page.keyboard.press("Escape");
    const handle = page.getByRole("separator", {
      name: "탐색 패널 너비",
      exact: true,
    });
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "310");
    await page.getByRole("button", { name: "왼쪽 패널 접기" }).click();
    await page
      .getByRole("button", { name: "탐색 패널 열기", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "새 아이디어", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "왼쪽 패널 접기" }).click();
    await page
      .getByRole("button", { name: "오른쪽 패널 열기 또는 접기" })
      .click();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      page.getByRole("complementary", { name: "탐색", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("complementary", { name: "아이디어 상세" }),
    ).toHaveCount(0);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("removed inputs and shortcuts, data menu, backup and offline notice", async ({
  page,
  context,
}) => {
  await expect(
    page.locator(".quick-add, .search-field, .filter-tabs, kbd"),
  ).toHaveCount(0);
  const ignored = await page.evaluate(() =>
    [
      { key: "n" },
      { key: "n", ctrlKey: true },
      { key: "k", ctrlKey: true },
      { key: "k", metaKey: true },
    ].map((options) => {
      const event = new KeyboardEvent("keydown", {
        ...options,
        bubbles: true,
        cancelable: true,
      });
      return !document.body.dispatchEvent(event);
    }),
  );
  expect(ignored).toEqual([false, false, false, false]);
  await expect(page.getByRole("article")).toHaveCount(0);
  await openNav(page);
  const menu = page.getByRole("button", { name: "데이터 관리", exact: true });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  await expect(page.locator("#data-management-content button")).toHaveText([
    "JSON 백업",
    "JSON 가져오기",
    "기존 데이터 찾기",
  ]);
  await expect(
    page.locator(".sidebar").getByText(/IndexedDB|Supabase|무결성/),
  ).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON 백업", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Escape");
  await createIdea(page, "완료 상태 확인");
  await page
    .getByRole("textbox", { name: "아이디어 본문" })
    .fill("취소선 없이 표시");
  await page.getByRole("checkbox", { name: "상세 아이디어 완료" }).check();
  await expect(page.getByRole("textbox", { name: "아이디어 본문" })).toHaveCSS(
    "text-decoration-line",
    "none",
  );
  await context.setOffline(true);
  await expect(
    page.getByText("오프라인입니다. 연결이 복구되면 동기화를 재시도합니다.", {
      exact: true,
    }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(
    page.getByText("오프라인입니다. 연결이 복구되면 동기화를 재시도합니다.", {
      exact: true,
    }),
  ).toHaveCount(0);
});
test("JSON import validates in an accessible modal without changing existing data", async ({
  page,
}) => {
  await createIdea(page, "원본 보존");
  await page
    .getByRole("button", { name: "상세 패널 닫기", exact: true })
    .click();
  const before = await page.evaluate(() =>
    localStorage.getItem("ideadock:data:demo"),
  );
  await openNav(page);
  await page.getByRole("button", { name: "데이터 관리", exact: true }).click();
  await page
    .getByRole("button", { name: "JSON 가져오기", exact: true })
    .click();
  const modal = page.getByRole("dialog", {
    name: "JSON 가져오기",
    exact: true,
  });
  await expect(modal).toBeVisible();
  await expect(
    modal.getByRole("button", { name: "데이터 관리 닫기", exact: true }),
  ).toBeFocused();
  await page.getByLabel("JSON 백업 파일 확인", { exact: true }).setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"broken":'),
  });
  await expect(modal.getByRole("alert")).toBeVisible();
  await expect(
    modal.getByRole("button", {
      name: "Google Drive로 데이터 이전 승인",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("ideadock:data:demo")),
  ).toBe(before);
  const check = async () =>
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
  await check();
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await check();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "JSON 가져오기", exact: true }),
  ).toBeFocused();
});
test("image paste/upload, enlargement and deletion", async ({ page }) => {
  await createIdea(page, "이미지 메모");
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  await page.locator(".detail-scroll input[type=file]").setInputFiles([
    { name: "pixel.png", mimeType: "image/png", buffer: pixel },
    { name: "second.png", mimeType: "image/png", buffer: pixel },
  ]);
  const row = page.getByRole("article").filter({ hasText: "이미지 메모" });
  const thumbnail = row.locator(".idea-thumbnail");
  await expect(
    thumbnail.getByRole("img", {
      name: "이미지 메모 대표 이미지: pixel.png",
      exact: true,
    }),
  ).toBeVisible();
  const bounds = await thumbnail.boundingBox();
  const actions = await row.locator(".row-actions").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(actions!.x + actions!.width);
  await page
    .getByRole("button", { name: "상세 패널 닫기", exact: true })
    .click();
  await thumbnail.click();
  await page.getByRole("img", { name: "pixel.png", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "이미지 확대" })).toBeVisible();
  await page.getByRole("button", { name: "이미지 확대 닫기" }).click();
  await page.getByRole("button", { name: "pixel.png 이미지 삭제" }).click();
  await expect(
    page.getByRole("img", { name: "pixel.png", exact: true }),
  ).toHaveCount(0);
  await expect(
    thumbnail.getByRole("img", {
      name: "이미지 메모 대표 이미지: second.png",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "second.png 이미지 삭제", exact: true })
    .click();
  await expect(thumbnail).toHaveCount(0);
});
