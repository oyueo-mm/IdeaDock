import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { mockDrive } from "../support/mock-drive";
import { seedDrive } from "../support/seed-drive";

// Benchmark, not a pass/fail test: run with `npm run bench` and compare the
// JSON written to bench-results/. Numbers depend on the machine.
const IDEAS = Number(process.env.BENCH_IDEAS || 200),
  REVISIONS = 3,
  LATENCY = Number(process.env.BENCH_LATENCY || 80);
const rows = (page: Page) => page.locator(".explorer-items article.idea-row");

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __idb: { get: number; put: number };
      __longTasks: number;
    };
    w.__idb = { get: 0, put: 0 };
    w.__longTasks = 0;
    const store = IDBObjectStore.prototype;
    const get = store.get,
      put = store.put;
    store.get = function (...args: Parameters<typeof get>) {
      w.__idb.get++;
      return get.apply(this, args);
    };
    store.put = function (...args: Parameters<typeof put>) {
      w.__idb.put++;
      return put.apply(this, args);
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__longTasks += entry.duration;
    }).observe({ type: "longtask", buffered: true });
  });
}
const counters = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __idb: { get: number; put: number };
      __longTasks: number;
    };
    const value = {
      idb: { ...w.__idb },
      longTaskMs: Math.round(w.__longTasks),
    };
    w.__idb = { get: 0, put: 0 };
    w.__longTasks = 0;
    return value;
  });
/** Waits until no Drive request has been made for `quiet` ms. */
async function settle(page: Page, quiet = 1500) {
  let last = Date.now();
  const bump = (r: { url(): string }) => {
    if (r.url().includes("googleapis.com")) last = Date.now();
  };
  page.on("request", bump);
  page.on("requestfinished", bump);
  while (Date.now() - last < quiet) await page.waitForTimeout(100);
  page.off("request", bump);
  page.off("requestfinished", bump);
  return last;
}

test("Drive load benchmark", async ({ page, context }) => {
  test.setTimeout(600_000);
  const api = mockDrive({ pageSize: 1000, latency: LATENCY });
  await api.attach(context);
  const seeded = seedDrive(api, {
    ideas: IDEAS,
    revisions: REVISIONS,
    folders: 8,
    images: 25,
  });
  await instrument(page);
  const result: Record<string, unknown> = {
    dataset: {
      ideas: IDEAS,
      revisionsPerIdea: REVISIONS,
      revisionFiles: IDEAS * REVISIONS,
      folders: 8,
      images: 25,
      latencyMs: LATENCY,
    },
  };

  // 1. Cold sign-in: empty device cache.
  await page.goto("./");
  api.takeStats();
  let t0 = Date.now();
  await page
    .getByRole("button", { name: "Google로 시작하기", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(IDEAS, { timeout: 300_000 });
  const coldList = Date.now() - t0;
  const coldEnd = (await settle(page)) - t0;
  result.coldSignIn = {
    listAllMs: coldList,
    syncIdleMs: coldEnd,
    drive: api.takeStats(),
    ...(await counters(page)),
  };
  delete (result.coldSignIn as { drive: { mediaKeys?: unknown } }).drive
    .mediaKeys;

  // 2. Warm reload (F5): cache present, token kept in sessionStorage.
  t0 = Date.now();
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  const warmFirst = Date.now() - t0;
  await expect(rows(page)).toHaveCount(IDEAS);
  const warmAll = Date.now() - t0;
  const warmEnd = (await settle(page)) - t0;
  const warmStats = api.takeStats();
  result.warmReload = {
    firstRowMs: warmFirst,
    allRowsMs: warmAll,
    syncIdleMs: warmEnd,
    drive: { ...warmStats, mediaKeys: undefined },
    duplicateImageDownloads:
      warmStats.mediaKeys.length -
      new Set(warmStats.mediaKeys.filter((k) => seeded.images.includes(k)))
        .size -
      warmStats.mediaKeys.filter((k) => !seeded.images.includes(k)).length,
    ...(await counters(page)),
  };

  // 3. One periodic sync with no remote change.
  t0 = Date.now();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const idleEnd = (await settle(page)) - t0;
  result.idleSync = {
    durationMs: idleEnd,
    drive: { ...api.takeStats(), mediaKeys: undefined },
    ...(await counters(page)),
  };

  // 4. Toggle completion on one idea.
  const before = api.files.size;
  const scroll = await page
    .locator(".explorer-list")
    .evaluate((el) => (el.scrollTop = 600));
  const target = rows(page).nth(10);
  const itemId = await target.evaluate(
    (el) => (el as HTMLElement).dataset.itemId,
  );
  t0 = Date.now();
  await target.locator(".completion-check").check();
  const clickMs = Date.now() - t0;
  await expect
    .poll(() => api.files.size, { timeout: 120_000 })
    .toBe(before + 1);
  const savedMs = Date.now() - t0;
  await settle(page);
  result.toggleCompletion = {
    uiMs: clickMs,
    savedToDriveMs: savedMs,
    rowStayed:
      (await rows(page)
        .nth(10)
        .evaluate((el) => (el as HTMLElement).dataset.itemId)) === itemId,
    scrollStayed:
      (await page.locator(".explorer-list").evaluate((el) => el.scrollTop)) ===
      scroll,
    drive: { ...api.takeStats(), mediaKeys: undefined },
    ...(await counters(page)),
  };

  // 5. Interaction while Drive is slow (2 s per request).
  api.setSlow(2000);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(300);
  t0 = Date.now();
  await rows(page).nth(3).locator(".idea-summary").click();
  await expect(page.locator(".detail-title")).toBeVisible();
  result.interactionDuringSlowSync = { openDetailMs: Date.now() - t0 };
  api.setSlow(0);
  await settle(page, 2500);
  api.takeStats();

  // 6. Relaunch in a new tab (no token): cached list before reconnect.
  await page.close();
  const relaunch = await context.newPage();
  await instrument(relaunch);
  t0 = Date.now();
  await relaunch.goto("./");
  await expect(rows(relaunch).first()).toBeVisible();
  result.relaunchCachedFirstRowMs = Date.now() - t0;

  mkdirSync("bench-results", { recursive: true });
  const file = `bench-results/${process.env.BENCH_LABEL || "run"}.json`;
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
});
