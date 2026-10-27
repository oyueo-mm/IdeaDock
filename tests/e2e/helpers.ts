import { expect, type Page } from "@playwright/test";

export async function openNav(page: Page) {
  if (
    !(await page
      .getByRole("button", { name: "새 아이디어", exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", { name: "탐색 패널 열기", exact: true })
      .click();
}
export async function createIdea(page: Page, title: string) {
  await openNav(page);
  await page.getByRole("button", { name: "새 아이디어", exact: true }).click();
  const input = page.getByRole("textbox", {
    name: "아이디어 제목 편집",
    exact: true,
  });
  await expect(input).toBeFocused();
  await input.fill(title);
}
export async function openData(page: Page) {
  await openNav(page);
  const toggle = page.getByRole("button", { name: "데이터 관리", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}
