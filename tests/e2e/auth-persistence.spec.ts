import { test, expect, type Page } from "@playwright/test";
import { mockDrive } from "../support/mock-drive";
import { createIdea, openNav } from "./helpers";
test.skip(process.env.IDEADOCK_E2E_DRIVE !== "1", "Dedicated mock Drive build");

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const reconnect = (page: Page) =>
  page.getByRole("button", { name: "Drive 다시 연결", exact: true });
const welcome = (page: Page) =>
  page.getByRole("button", { name: "Google로 시작하기", exact: true });
const thumbnail = (page: Page) =>
  page.getByRole("img", {
    name: "새로고침 유지 아이디어 대표 이미지: pixel.png",
    exact: true,
  });
const gisRequests = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __gisRequests?: unknown[] }).__gisRequests ?? [],
  );
const storedAuth = (page: Page) =>
  page.evaluate(() => ({
    account: localStorage.getItem("ideadock:drive-account"),
    session: sessionStorage.getItem("ideadock:drive-session"),
  }));

test("stays signed in across reloads, reconnects a relaunch in one tap and forgets at sign-out", async ({
  page,
  context,
}, info) => {
  const api = mockDrive();
  await api.attach(context);
  const onDrive = (title: string) =>
    expect
      .poll(
        () =>
          [...api.files.values()].some((f) =>
            f.bytes.toString().includes(title),
          ),
        { timeout: 20000 },
      )
      .toBe(true);
  await page.goto("./");
  await welcome(page).click();
  expect(await gisRequests(page)).toEqual([
    { prompt: "select_account", login_hint: null },
  ]);
  await createIdea(page, "새로고침 유지 아이디어");
  await page
    .locator(".detail-scroll input[type=file]")
    .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: pixel });
  await expect(thumbnail(page)).toBeVisible();
  await onDrive("pixel.png");
  const stored = await storedAuth(page);
  expect(JSON.parse(stored.account!)).toEqual({
    id: "google:alice",
    email: "alice@example.com",
    user_metadata: { full_name: "Alice" },
  });
  expect(stored.session).toContain("test-only");

  // F5: same tab, token still valid → no prompt, no reconnect banner.
  await page.reload();
  await expect(thumbnail(page)).toBeVisible();
  await expect(reconnect(page)).toHaveCount(0);
  await expect(welcome(page)).toHaveCount(0);
  expect(await gisRequests(page)).toEqual([]);

  // Relaunch: a new tab shares IndexedDB/localStorage but not sessionStorage.
  await page.close();
  const relaunch = await context.newPage();
  await relaunch.goto("./");
  await expect(reconnect(relaunch)).toBeVisible();
  // Cached ideas and images render before any Drive token exists.
  await expect(thumbnail(relaunch)).toBeVisible();
  await expect(relaunch.locator(".error-banner")).toHaveCount(0);
  await reconnect(relaunch).click();
  await expect(reconnect(relaunch)).toHaveCount(0);
  expect(await gisRequests(relaunch)).toEqual([
    { prompt: "", login_hint: "alice" },
  ]);

  // Offline edits stay on the device and sync when the network returns.
  await context.setOffline(true);
  await createIdea(relaunch, "오프라인 아이디어");
  await expect(
    relaunch.getByText("Drive에 저장되지 않은 변경 사항 1개", { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await context.setOffline(false);
  await onDrive("오프라인 아이디어");
  await expect(relaunch.getByText(/Drive에 저장되지 않은 변경/)).toHaveCount(0);

  // Sign-out forgets the workspace on this device.
  if (info.project.name === "mobile")
    await relaunch
      .getByRole("button", { name: "상세 패널 닫기", exact: true })
      .click();
  await openNav(relaunch);
  await relaunch
    .getByRole("button", { name: "작업 공간 설정", exact: true })
    .click();
  await relaunch.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(welcome(relaunch)).toBeVisible();
  expect(await storedAuth(relaunch)).toEqual({ account: null, session: null });
  await relaunch.reload();
  await expect(welcome(relaunch)).toBeVisible();
  await expect(relaunch.locator(".idea-summary")).toHaveCount(0);
  await expect(reconnect(relaunch)).toHaveCount(0);
});
test("a revoked or expired token asks for a one-tap reconnect and keeps the draft", async ({
  page,
  context,
}, info) => {
  const api = mockDrive();
  await api.attach(context);
  await page.goto("./");
  await welcome(page).click();
  await createIdea(page, "만료 전 아이디어");
  await expect(page.getByText(/Drive에 저장되지 않은 변경/)).toHaveCount(0, {
    timeout: 10000,
  });
  api.expireToken(true);
  if (info.project.name === "mobile")
    await page
      .getByRole("button", { name: "상세 패널 닫기", exact: true })
      .click();
  await createIdea(page, "만료 후 초안");
  await expect(reconnect(page)).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await expect(
    page.getByText("Drive에 저장되지 않은 변경 사항 1개", { exact: true }),
  ).toBeVisible();
  expect((await storedAuth(page)).session).toBeNull();
  api.expireToken(false);
  await reconnect(page).click();
  await expect(reconnect(page)).toHaveCount(0);
  await expect(page.getByText(/Drive에 저장되지 않은 변경/)).toHaveCount(0, {
    timeout: 10000,
  });
  expect(
    [...api.files.values()].some((f) =>
      f.bytes.toString().includes("만료 후 초안"),
    ),
  ).toBe(true);
  expect((await gisRequests(page)).at(-1)).toEqual({
    prompt: "",
    login_hint: "alice",
  });
});
