import { expect, test } from "@playwright/test";
import { openNav } from "./helpers";

test("signed-out UI hides empty counts, preserves resized panels and distinguishes an empty demo", async ({
  page,
}, testInfo) => {
  await page.goto("./");
  await expect(
    page.getByText("Google Drive에 연결하여 아이디어를 동기화하세요.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("아이디어가 없습니다", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("태그 없음", { exact: true })).toHaveCount(0);
  await expect(page.locator(".sidebar nav small")).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "아이디어 정렬" }),
  ).toHaveCount(0);
  await openNav(page);
  await expect(
    page.getByRole("button", { name: "새 아이디어", exact: true }),
  ).toBeDisabled();
  if (testInfo.project.name === "desktop") {
    const left = page.getByRole("separator", {
      name: "탐색 패널 너비",
      exact: true,
    });
    await expect(left).toHaveAttribute("aria-valuenow", "290");
    await expect(page.locator(".topbar")).toHaveCSS("height", "54px");
  }
  await page.evaluate(() =>
    localStorage.setItem(
      "ideadock:layout",
      JSON.stringify({
        left: true,
        right: true,
        leftWidth: 246,
        rightWidth: 420,
      }),
    ),
  );
  await page.reload();
  if (testInfo.project.name === "desktop") {
    const left = page.getByRole("separator", {
      name: "탐색 패널 너비",
      exact: true,
    });
    await expect(left).toHaveAttribute("aria-valuenow", "246");
    await left.focus();
    await page.keyboard.press("ArrowRight");
    await expect(left).toHaveAttribute("aria-valuenow", "266");
  }
  await page
    .getByRole("button", { name: "체험 모드 열기", exact: true })
    .click();
  await expect(
    page.getByText("아이디어가 없습니다", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "체험 데이터 안내 닫기", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "체험 데이터 안내 닫기", exact: true })
    .click();
  await openNav(page);
  await expect(
    page.getByRole("button", { name: "새 아이디어", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "새 아이디어", exact: true }),
  ).toHaveCSS("opacity", "1");
});
