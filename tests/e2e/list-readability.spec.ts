import { test, expect, type Page } from "@playwright/test";
import { makeIdea } from "../../src/lib/model";

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const korean =
  "긴 한글 문장이 목록에서 어떻게 보이는지 확인하기 위해 같은 내용을 여러 번 반복해서 적어 둡니다. ".repeat(
    6,
  );
const ideas = {
  empty: { ...makeIdea("본문 없는 아이디어", "demo") },
  short: { ...makeIdea("짧은 아이디어", "demo"), plain_text: "한 줄 메모" },
  long: { ...makeIdea("긴 아이디어", "demo"), plain_text: korean },
  mixed: {
    ...makeIdea("혼합 아이디어", "demo"),
    plain_text:
      "React와 Next.js로 만드는 Idea tracker, offline-first sync 전략을 정리합니다. ".repeat(
        5,
      ),
  },
  url: {
    ...makeIdea("링크 아이디어", "demo"),
    plain_text: `참고 https://example.com/${"very-long-path-segment".repeat(12)} 끝`,
  },
  rich: {
    ...makeIdea("태그 이미지 아이디어", "demo"),
    is_completed: true,
    plain_text: korean,
    tags: ["디자인", "읽기"],
    images: [
      { id: "image-one", storage_path: pixel, original_filename: "원본.png" },
    ],
    links: [
      {
        id: "l1",
        type: "website" as const,
        label: "",
        url: "https://example.com",
      },
    ],
    provenance: {
      source: "demo",
      source_id: "old-1",
      original_owner: "demo",
      fingerprint: "f1",
    },
  },
};

async function open(page: Page) {
  await page.goto("./");
  await page.evaluate(
    (value) => localStorage.setItem("ideadock:data:demo", value),
    JSON.stringify({ ideas: Object.values(ideas), pending: {} }),
  );
  await page.reload();
  await page.getByRole("button", { name: "체험 모드 열기" }).click();
}
const row = (page: Page, title: string) =>
  page.locator("article.idea-row").filter({ hasText: title });
const preview = (page: Page, title: string) =>
  row(page, title).locator(".idea-preview");
/** Rendered lines of a row's summary, from its height and line height. */
const lines = (page: Page, title: string) =>
  preview(page, title).evaluate((el) => {
    const style = getComputedStyle(el);
    return Math.round(
      el.getBoundingClientRect().height / parseFloat(style.lineHeight),
    );
  });

test("summaries show up to two lines and the list hides dates", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator("article.idea-row")).toHaveCount(6);

  expect(await lines(page, "본문 없는 아이디어")).toBe(1);
  await expect(preview(page, "본문 없는 아이디어")).toHaveText("본문 없음");
  expect(await lines(page, "짧은 아이디어")).toBe(1);
  for (const title of ["긴 아이디어", "혼합 아이디어", "태그 이미지 아이디어"])
    expect(await lines(page, title), title).toBe(2);
  expect(await lines(page, "링크 아이디어")).toBeLessThanOrEqual(2);

  // Long text is clipped, not pushed out of the row or the list.
  const clipped = await preview(page, "긴 아이디어").evaluate(
    (el) => el.scrollHeight > el.clientHeight,
  );
  expect(clipped).toBe(true);
  const list = await page.locator(".explorer-items").evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  expect(list.scroll).toBeLessThanOrEqual(list.client);
  for (const title of ["링크 아이디어", "긴 아이디어"]) {
    const r = await row(page, title).boundingBox();
    const p = await preview(page, title).boundingBox();
    expect(p!.x + p!.width).toBeLessThanOrEqual(r!.x + r!.width + 1);
  }

  // A one-line row is shorter than a two-line one.
  const short = (await row(page, "짧은 아이디어").boundingBox())!.height;
  const long = (await row(page, "긴 아이디어").boundingBox())!.height;
  expect(long).toBeGreaterThan(short);

  // No dates or provenance label; tags, badge, image and link stay.
  const rich = row(page, "태그 이미지 아이디어");
  await expect(page.locator(".explorer-items")).not.toContainText(
    "이전한 아이디어",
  );
  await expect(page.locator(".explorer-items")).not.toContainText(
    /\d+월 \d+일/,
  );
  await expect(rich.locator(".completed-label")).toHaveText("완료");
  await expect(rich.locator(".tag-chip")).toHaveText(["디자인", "읽기"]);
  await expect(rich.locator(".idea-thumbnail")).toBeVisible();
  await expect(
    rich.getByRole("link", { name: "태그 이미지 아이디어 웹사이트 열기" }),
  ).toHaveAttribute("target", "_blank");
  await expect(row(page, "짧은 아이디어").locator(".idea-meta")).toHaveCount(0);

  // Dates stay in the detail panel and the data keeps its provenance.
  await rich.locator("button.idea-summary").click();
  await expect(page.getByText(/만든 날 \d+월 \d+일/)).toBeVisible();
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ideadock:data:demo")!),
  );
  const saved = stored.ideas.find(
    (i: { title: string }) => i.title === "태그 이미지 아이디어",
  );
  expect(saved.provenance).toMatchObject({
    source: "demo",
    source_id: "old-1",
  });
  expect(saved.created_at).toBeTruthy();
});

test("two-line rows still select, complete and keep the list scrollable", async ({
  page,
}) => {
  await open(page);
  const long = row(page, "긴 아이디어");
  await long.getByRole("checkbox", { name: "긴 아이디어 완료" }).check();
  await expect(long.locator(".completed-label")).toBeVisible();
  await long.locator("button.idea-summary").click();
  await expect(
    page.getByRole("textbox", { name: "아이디어 제목 편집" }),
  ).toHaveValue("긴 아이디어");
});
