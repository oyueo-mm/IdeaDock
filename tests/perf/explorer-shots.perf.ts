import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mockDrive } from "../support/mock-drive";
import { seedDrive } from "../support/seed-drive";

// Screenshot capture for before/after comparison:
//   SHOT_LABEL=before npx playwright test --config playwright.perf.config.ts explorer-shots
const label = process.env.SHOT_LABEL || "after";
const dir = "docs/screenshots/explorer-ux";

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`explorer screenshots · ${name}`, async ({ browser }) => {
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({
      viewport,
      hasTouch: name === "mobile",
      isMobile: name === "mobile",
    });
    const api = mockDrive({ pageSize: 1000 });
    await api.attach(context);
    seedDrive(api, { ideas: 14, revisions: 1, folders: 3, images: 3 });
    const page = await context.newPage();
    await page.goto("./");
    await page
      .getByRole("button", { name: "Google로 시작하기", exact: true })
      .click();
    await expect(page.locator(".explorer-items article.idea-row")).toHaveCount(
      14,
    );
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${dir}/${label}-${name}-list.png` });
    await page
      .locator(".explorer-items article.idea-row")
      .nth(2)
      .locator(".idea-summary")
      .click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/${label}-${name}-detail.png` });
    await context.close();
  });
}
