import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mockDrive } from "../support/mock-drive";
import { seedDrive } from "../support/seed-drive";
import {
  duplicatesOf,
  fixtureIdeas,
  jsonText,
} from "../support/import-fixture";
import type { Idea } from "../../src/lib/model";
import { openData } from "./helpers";
test.skip(process.env.IDEADOCK_E2E_DRIVE !== "1", "Dedicated mock Drive build");
test.skip(({ isMobile }) => isMobile, "Dialog flow is the same on desktop");

type Api = ReturnType<typeof mockDrive>;
const revisions = (api: Api) =>
  [...api.files.values()]
    .filter((f) => f.appProperties.kind === "revision")
    .map((f) => JSON.parse(f.bytes.toString()).idea as Idea);
const latest = (api: Api, id: string) =>
  revisions(api)
    .filter((i) => i.id === id)
    .sort((a, b) => b.version - a.version)[0];
const kinds = (api: Api, kind: string) =>
  [...api.files.values()].filter((f) => f.appProperties.kind === kind).length;

async function start(page: Page, context: BrowserContext, api: Api) {
  await api.attach(context);
  await page.goto("./");
  await page
    .getByRole("button", { name: "Google로 시작하기", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Google로 시작하기" }),
  ).toHaveCount(0);
  await page.waitForTimeout(800);
}
/** Choose the file and go through the preview up to "backup created". */
async function prepare(page: Page, ideas: Idea[]) {
  await openData(page);
  await page
    .getByRole("button", { name: "JSON 가져오기", exact: true })
    .click();
  await page.getByLabel("JSON 백업 파일 확인", { exact: true }).setInputFiles({
    name: "ideas.json",
    mimeType: "application/json",
    buffer: Buffer.from(jsonText(ideas)),
  });
  await page.getByRole("button", { name: "수정한 결과 확인" }).click();
  await page.getByRole("checkbox", { name: /JSON 백업/ }).check();
  await page
    .getByRole("button", { name: /무결성 검사 및 복구 백업 만들기/ })
    .click();
  await page
    .getByRole("checkbox", { name: "복구 백업 파일을 내려받아 보관했습니다." })
    .check();
}
const approve = (page: Page) =>
  page.getByRole("button", {
    name: /Google Drive로 데이터 이전 승인|이전 재시도 승인/,
  });
const done = (page: Page) => page.getByText(/이전 및 서버 재조회 검증 완료/);

test("shows 'n/27개 저장 완료' with the current step, then per-step timings", async ({
  page,
  context,
}) => {
  const api = mockDrive({ pageSize: 1000, latency: 120 });
  await start(page, context, api);
  await prepare(page, fixtureIdeas({ ideas: 27, image: true }));
  await approve(page).click();
  const status = page
    .locator('[role="status"]')
    .filter({ hasText: "저장 완료" });
  await expect(status).toContainText(/\d+\/27개 저장 완료 · /);
  await expect(
    page.getByText(/[1-9]\d*\/27개 저장 완료 · 아이디어 저장/),
  ).toBeVisible({ timeout: 30_000 });
  await expect(done(page)).toBeVisible({ timeout: 60_000 });
  const stages = page.getByRole("list", { name: "단계별 소요 시간" });
  await expect(stages.locator("li")).toHaveCount(5);
  await expect(stages).toContainText("아이디어 저장");
  await expect(stages).toContainText(/요청 \d+회 · 평균 응답 \d+ms/);
  expect(kinds(api, "revision")).toBe(27);
  expect(kinds(api, "image")).toBe(1);
  expect(kinds(api, "backup")).toBe(1);
  // at most three uploads were ever in flight at once
  expect(api.takeStats().peakWrites).toBeLessThanOrEqual(3);
});

test("duplicates are reviewed: skip by default, add on request, or update status and GitHub link only", async ({
  page,
  context,
}) => {
  const api = mockDrive({ pageSize: 1000 });
  const data = seedDrive(api, {
    ideas: 40,
    revisions: 1,
    folders: 0,
    images: 2,
    root: true,
  });
  await start(page, context, api);
  const dups = duplicatesOf(data.ideas.slice(0, 3));
  const statusOnly = duplicatesOf(data.ideas.slice(3, 5), "local-user", () => ({
    is_completed: true,
    links: [
      {
        id: "g1",
        type: "github" as const,
        label: "repo",
        url: "https://github.com/example/new-repo",
      },
    ],
  }));
  const fresh = fixtureIdeas({ ideas: 4 });
  await prepare(page, [...dups, ...statusOnly, ...fresh]);
  const review = page.getByRole("region", { name: "중복 검토" });
  await expect(review).toContainText("기존 아이디어와 겹치는 항목 5개");
  await expect(review).toContainText(
    "새로 추가 4개 · 기존 갱신 0개 · 건너뜀 5개",
  );
  await expect(review).toContainText(
    "제목과 본문이 같은 아이디어가 이미 있습니다",
  );
  await expect(review).toContainText("바뀌는 내용 없음");
  await expect(review).toContainText("GitHub 링크 1개 추가");
  // an unchanged duplicate cannot be "updated"
  const plain = review.getByRole("combobox", {
    name: `${dups[0].title} 처리`,
  });
  await expect(plain.locator('option[value="update"]')).toBeDisabled();
  await plain.selectOption("create"); // the user insists on a copy
  for (const idea of statusOnly)
    await review
      .getByRole("combobox", { name: `${idea.title} 처리` })
      .selectOption("update");
  await expect(review).toContainText(
    "새로 추가 5개 · 기존 갱신 2개 · 건너뜀 2개",
  );
  await page
    .getByRole("button", { name: /무결성 검사 및 복구 백업 만들기/ })
    .click();
  await page
    .getByRole("checkbox", { name: "복구 백업 파일을 내려받아 보관했습니다." })
    .check();
  const before = revisions(api).length;
  await approve(page).click();
  await expect(done(page)).toBeVisible({ timeout: 60_000 });
  // 4 new + 1 copy + 2 updates; the two untouched duplicates wrote nothing
  expect(revisions(api).length - before).toBe(7);
  for (const original of data.ideas.slice(3, 5)) {
    const after = latest(api, original.id);
    expect(after.is_completed).toBe(true);
    expect(after.links.map((l) => l.url)).toEqual([
      "https://github.com/example/new-repo",
    ]);
    // description, image, title and tags stay exactly as they were
    expect(after.title).toBe(original.title);
    expect(after.plain_text).toBe(original.plain_text);
    expect(after.content).toEqual(original.content);
    expect(after.images).toEqual(original.images);
    expect(after.version).toBe(original.version + 1);
  }
  for (const original of data.ideas.slice(0, 3).concat(data.ideas.slice(5)))
    expect(latest(api, original.id).version).toBe(original.version);
  expect(revisions(api).filter((i) => i.title === dups[0].title)).toHaveLength(
    2,
  ); // the original and the copy the user asked for
  expect(kinds(api, "image")).toBe(2); // none added: only seeded pictures
  // Running it again changes nothing.
  await approve(page).click();
  await expect(done(page)).toBeVisible();
  expect(revisions(api).length - before).toBe(7);
});

test("a rate-limited burst, a lost reply and brief 503s still import every idea once", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const api = mockDrive({ pageSize: 1000, latency: 30 });
  await start(page, context, api);
  await prepare(page, fixtureIdeas({ ideas: 20, image: true }));
  api.limitWrites(1); // Drive accepts one upload at a time
  api.failPut(2); // two content uploads fail with 503
  api.losePut(2); // two are stored but their replies are lost
  api.takeStats();
  await approve(page).click();
  await expect(done(page)).toBeVisible({ timeout: 120_000 });
  const stats = api.takeStats();
  expect(stats.limited).toBeGreaterThan(0);
  expect(kinds(api, "revision")).toBe(20);
  expect(kinds(api, "image")).toBe(1);
  expect(new Set(revisions(api).map((i) => i.id)).size).toBe(20);
});

test("an interrupted import can be retried and finishes without duplicates", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const api = mockDrive({ pageSize: 1000, latency: 20 });
  await start(page, context, api);
  await prepare(page, fixtureIdeas({ ideas: 12, image: true }));
  api.breakAfter(5); // after a few files Drive refuses every upload with 503
  await approve(page).click();
  await expect(
    page.getByText(/실패 지점부터 재시도할 수 있습니다/),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/\/12개 저장 완료 · 실패/)).toBeVisible();
  expect(kinds(api, "revision")).toBeLessThan(12);
  expect(kinds(api, "revision")).toBeGreaterThan(0);
  api.breakAfter(null);
  await page.getByRole("button", { name: "이전 재시도 승인" }).click();
  await expect(done(page)).toBeVisible({ timeout: 60_000 });
  expect(kinds(api, "revision")).toBe(12);
  expect(new Set(revisions(api).map((i) => i.id)).size).toBe(12);
  expect(kinds(api, "image")).toBe(1);
});
