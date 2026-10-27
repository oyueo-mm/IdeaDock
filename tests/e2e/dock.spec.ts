import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.beforeEach(async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "체험 모드 열기" }).click();
});
test("quick capture, autosave, completion and reload", async ({ page }) => {
  await page
    .getByRole("textbox", { name: "새 아이디어 제목", exact: true })
    .fill("내가 읽은 책 관리 앱");
  await page
    .getByRole("textbox", { name: "새 아이디어 제목", exact: true })
    .press("Enter");
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
test("search, tags, safe links, trash and restore", async ({ page }) => {
  await page
    .getByRole("textbox", { name: "새 아이디어 제목", exact: true })
    .fill("푸리에 시각화");
  await page
    .getByRole("textbox", { name: "새 아이디어 제목", exact: true })
    .press("Enter");
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
  await page.getByRole("textbox", { name: "아이디어 검색" }).fill("수학");
  await expect(
    page.getByRole("article").filter({ hasText: "푸리에 시각화" }),
  ).toHaveCount(1);
  await page.getByRole("textbox", { name: "아이디어 검색" }).fill("없는검색어");
  await expect(page.getByText("검색 결과가 없어요")).toBeVisible();
});
test("pasted images appear inside the memo and browser back returns to list", async ({
  page,
}) => {
  await page
    .getByRole("textbox", { name: "새 아이디어 제목", exact: true })
    .fill("붙여넣기 테스트");
  await page
    .getByRole("textbox", { name: "새 아이디어 제목", exact: true })
    .press("Enter");
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
  await page
    .getByRole("textbox", { name: "새 아이디어 제목", exact: true })
    .fill("접근성 검사");
  await page
    .getByRole("textbox", { name: "새 아이디어 제목", exact: true })
    .press("Enter");
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
    await expect(handle).toHaveAttribute("aria-valuenow", "240");
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
test("image paste/upload, enlargement and deletion", async ({ page }) => {
  await page
    .getByRole("textbox", { name: "새 아이디어 제목", exact: true })
    .fill("이미지 메모");
  await page
    .getByRole("textbox", { name: "새 아이디어 제목", exact: true })
    .press("Enter");
  await page.locator("input[type=file]").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.getByRole("img", { name: "pixel.png", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "이미지 확대" })).toBeVisible();
  await page.getByRole("button", { name: "이미지 확대 닫기" }).click();
  await page.getByRole("button", { name: "pixel.png 이미지 삭제" }).click();
  await expect(
    page.getByRole("img", { name: "pixel.png", exact: true }),
  ).toHaveCount(0);
});
