import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mockDrive } from "../support/mock-drive";
import { seedDrive } from "../support/seed-drive";
import { fixtureIdeas, jsonText } from "../support/import-fixture";

// Benchmark of the JSON import, step by step, through the real dialog:
//   BENCH_LABEL=before npx playwright test --config playwright.perf.config.ts json-import
// BENCH_SCENARIOS filters, e.g. "27+0@80,27+200@300" (ideas + existing @ latency).
const all = [
  { ideas: 27, existing: 0, latency: 80 },
  { ideas: 27, existing: 0, latency: 300 },
  { ideas: 27, existing: 200, latency: 80 },
  { ideas: 27, existing: 200, latency: 300 },
];
const wanted = (process.env.BENCH_SCENARIOS ?? "").split(",").filter(Boolean);
const scenarios = all.filter(
  (s) =>
    !wanted.length || wanted.includes(`${s.ideas}+${s.existing}@${s.latency}`),
);
const label = process.env.BENCH_LABEL || "run";

async function openImport(page: Page) {
  await page.getByRole("button", { name: "데이터 관리", exact: true }).click();
  await page
    .getByRole("button", { name: "JSON 가져오기", exact: true })
    .click();
}

for (const s of scenarios) {
  test(`JSON import · ${s.ideas} ideas into ${s.existing} existing @ ${s.latency} ms`, async ({
    browser,
  }) => {
    test.setTimeout(900_000);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const api = mockDrive({ pageSize: 1000, latency: s.latency });
    await api.attach(context);
    if (s.existing)
      seedDrive(api, {
        ideas: s.existing,
        revisions: 1,
        folders: 0,
        images: 3,
        root: true,
      });
    const page = await context.newPage();
    await page.goto("./");
    await page
      .getByRole("button", { name: "Google로 시작하기", exact: true })
      .click();
    if (s.existing)
      await expect(
        page.locator(".explorer-items article.idea-row"),
      ).toHaveCount(s.existing, { timeout: 300_000 });
    await page.waitForTimeout(2500); // let the first sync settle
    const file = Buffer.from(
      jsonText(fixtureIdeas({ ideas: s.ideas, image: true })),
    );

    await openImport(page);
    const at: Record<string, number> = {};
    const t0 = Date.now();
    await page
      .getByLabel("JSON 백업 파일 확인", { exact: true })
      .setInputFiles({
        name: "ideas.json",
        mimeType: "application/json",
        buffer: file,
      });
    await page.getByRole("textbox", { name: "가져오기 미리보기" }).waitFor();
    at.preview = Date.now() - t0;
    await page.getByRole("button", { name: "수정한 결과 확인" }).click();
    const source = page.getByRole("checkbox", { name: /JSON 백업/ });
    await source.waitFor();
    at.accepted = Date.now() - t0;
    await source.check();
    await page
      .getByRole("button", { name: /무결성 검사 및 복구 백업 만들기/ })
      .click();
    await page
      .getByRole("checkbox", {
        name: "복구 백업 파일을 내려받아 보관했습니다.",
      })
      .waitFor();
    at.backup = Date.now() - t0;
    await page
      .getByRole("checkbox", {
        name: "복구 백업 파일을 내려받아 보관했습니다.",
      })
      .check();
    api.takeStats();
    const approved = Date.now();
    await page
      .getByRole("button", { name: "Google Drive로 데이터 이전 승인" })
      .click();
    await expect(page.getByText(/이전 및 서버 재조회 검증 완료/)).toBeVisible({
      timeout: 800_000,
    });
    at.drive = Date.now() - approved;
    const drive = api.takeStats();
    const stages = await page
      .getByRole("list", { name: "단계별 소요 시간" })
      .locator("li")
      .allInnerTexts();
    const revisions = [...api.files.values()].filter(
      (f) => f.appProperties.kind === "revision",
    ).length;
    const result = {
      scenario: s,
      fileBytes: file.length,
      localMs: at,
      driveMs: at.drive,
      requests: {
        total: drive.list + drive.media + drive.upload + drive.other,
        list: drive.list,
        media: drive.media,
        ids: drive.ids,
        uploadStart: drive.start,
        uploadPut: drive.put,
        other: drive.other,
        peakWrites: drive.peakWrites,
        limited: drive.limited,
      },
      stages,
      revisionFiles: revisions,
    };
    expect(revisions).toBe(s.existing + s.ideas);
    mkdirSync("bench-results", { recursive: true });
    writeFileSync(
      `bench-results/json-${label}-${s.ideas}+${s.existing}@${s.latency}.json`,
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
    await context.close();
  });
}
