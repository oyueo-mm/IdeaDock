// Server sign-in mode (Cloudflare Pages build) against the local mock
// deployment: real /api/auth handler, node:sqlite for D1, mock Google OAuth
// and mock Drive. Run with `npm run test:e2e:server`.
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { mockDrive } from "../support/mock-drive";
import { seedDrive } from "../support/seed-drive";
import { createIdea, openNav } from "./helpers";
test.skip(process.env.IDEADOCK_E2E_SERVER !== "1", "Mock Cloudflare build");

const origin = `http://localhost:${process.env.IDEADOCK_E2E_SERVER_PORT || 4186}`;
const MIN = 60_000,
  DAY = 86_400_000;
type Control = {
  refreshCalls: number;
  refreshTokensIssued: number;
  sessions: Record<string, number>;
  accepts?: boolean;
};
async function control(input: Record<string, unknown> = {}): Promise<Control> {
  const reply = await fetch(`${origin}/__mock/control`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return reply.json();
}
const drive = () =>
  mockDrive({
    accepts: async (token) => (await control({ accepts: token })).accepts!,
  });
const userFor = () =>
  `u${test
    .info()
    .testId.replace(/[^a-z0-9]/gi, "")
    .slice(-10)}`;
const welcome = (page: Page) =>
  page.getByRole("button", { name: "Google로 시작하기", exact: true });
const relogin = (page: Page) =>
  page.getByRole("button", { name: "Google 다시 로그인", exact: true });
const rows = (page: Page) =>
  page.locator(".explorer-items article.idea-row:not(.folder-list-row)");
const row = (page: Page, title: string) =>
  rows(page).filter({ hasText: title });
/** Every request that started a Google sign-in, i.e. a visible login. */
function logins(page: Page) {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/auth/login")) seen.push(r.url());
  });
  return seen;
}
async function signIn(page: Page, user: string) {
  await control({ nextUser: user });
  await page.goto("./");
  await welcome(page).click();
  await expect(page).toHaveURL(`${origin}/IdeaDock/`);
  await expect(welcome(page)).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "폴더와 아이디어 목록" }),
  ).toBeVisible();
}
function onDrive(api: ReturnType<typeof mockDrive>, text: string) {
  return expect
    .poll(
      () =>
        [...api.files.values()].some((f) => f.bytes.toString().includes(text)),
      { timeout: 20_000 },
    )
    .toBe(true);
}
/** The app recorded every save (not just the bytes reaching Drive). */
const settled = (page: Page) =>
  expect(page.getByText(/Drive에 저장되지 않은 변경 사항/)).toHaveCount(0, {
    timeout: 20_000,
  });
async function rename(page: Page, from: string, to: string) {
  const title = page.getByRole("textbox", {
    name: "아이디어 제목 편집",
    exact: true,
  });
  // Phones show the open idea full-screen; edit it there or go back first.
  const open = (await title.isVisible()) && (await title.inputValue()) === from;
  if (!open) {
    const close = page.getByRole("button", { name: "상세 패널 닫기" });
    if (await close.isVisible()) await close.click();
    await row(page, from).locator(".idea-summary").click();
  }
  await expect(title).toHaveValue(from);
  await title.fill(to);
  await title.blur();
}
async function openSettings(page: Page) {
  // After a sign-in redirect the app must finish loading before the nav opens.
  await expect(
    page.getByRole("region", { name: "폴더와 아이디어 목록" }),
  ).toBeVisible();
  await openNav(page);
  await page
    .getByRole("button", { name: "작업 공간 설정", exact: true })
    .click();
}
/** Closes the browser and opens it again with what it keeps on disk. */
async function relaunch(browser: Browser, context: BrowserContext) {
  const state = await context.storageState({ indexedDB: true });
  await context.close();
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } =
    test.info().project.use;
  const next = await browser.newContext({
    storageState: state,
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    baseURL: `${origin}/IdeaDock/`,
  });
  return { context: next, page: await next.newPage() };
}

test("first sign-in shows existing Drive data and the session survives reloads and relaunches", async ({
  page,
  context,
  browser,
}) => {
  const user = userFor();
  const api = drive();
  await api.attach(context);
  // Data written earlier by the GitHub Pages (token model) app.
  seedDrive(api, {
    ideas: 3,
    revisions: 2,
    folders: 1,
    images: 1,
    root: true,
    account: `google:${user}`,
  });
  const gis: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("accounts.google.com/gsi")) gis.push(r.url());
  });
  await signIn(page, user);
  await expect(rows(page)).toHaveCount(3);
  await openNav(page);
  await expect(
    page.getByRole("button", { name: "폴더 1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /가져온 아이디어 001 대표 이미지/ }),
  ).toBeVisible();
  await createIdea(page, "서버 세션 아이디어");
  await onDrive(api, "서버 세션 아이디어");
  expect(gis).toEqual([]);

  // The session is an HttpOnly cookie; no Google token is kept by the page.
  const cookie = (await context.cookies()).find(
    (c) => c.name === "__Host-ideadock_session",
  )!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Lax");
  expect(cookie.expires * 1000).toBeGreaterThan(Date.now() + 59 * DAY);
  const stored = await page.evaluate(async () => {
    const dump: unknown[] = [
      document.cookie,
      { ...localStorage },
      { ...sessionStorage },
    ];
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name!);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      for (const store of db.objectStoreNames)
        dump.push(
          await new Promise((resolve) => {
            const all = db.transaction(store).objectStore(store).getAll();
            all.onsuccess = () => resolve(all.result);
          }),
        );
      db.close();
    }
    return JSON.stringify(dump);
  });
  expect(stored).not.toMatch(/mock-(at|rt)-|ideadock_session/);

  // F5: back without any sign-in screen.
  const seen = logins(page);
  await page.reload();
  await expect(row(page, "서버 세션 아이디어")).toBeVisible();
  await rename(page, "서버 세션 아이디어", "새로고침 후 수정");
  await onDrive(api, "새로고침 후 수정");
  await expect(relogin(page)).toHaveCount(0);
  await expect(welcome(page)).toHaveCount(0);
  expect(seen).toEqual([]);

  // Quit the browser (or PWA) entirely and start it again.
  const again = await relaunch(browser, context);
  await api.attach(again.context);
  const after = logins(again.page);
  await again.page.goto("./");
  await expect(row(again.page, "새로고침 후 수정")).toBeVisible();
  await rename(again.page, "새로고침 후 수정", "재실행 후 수정");
  await onDrive(api, "재실행 후 수정");
  await expect(relogin(again.page)).toHaveCount(0);
  expect(after).toEqual([]);
  await again.context.close();
});

test("an hour later the server refreshes the Drive token without a prompt", async ({
  page,
  context,
}) => {
  const user = userFor();
  const api = drive();
  await api.attach(context);
  await signIn(page, user);
  await createIdea(page, "한 시간 뒤");
  await onDrive(api, "한 시간 뒤");
  const before = await control({ advance: 61 * MIN });
  const seen = logins(page);
  await rename(page, "한 시간 뒤", "자동 갱신으로 저장");
  await onDrive(api, "자동 갱신으로 저장");
  expect((await control()).refreshCalls).toBeGreaterThan(before.refreshCalls);
  await expect(relogin(page)).toHaveCount(0);
  expect(seen).toEqual([]);
});

test("7 and 30 days later the session restores; after 60 idle days it asks again and keeps drafts", async ({
  page,
  context,
}) => {
  const user = userFor();
  const api = drive();
  await api.attach(context);
  await signIn(page, user);
  await createIdea(page, "장기 세션");
  await onDrive(api, "장기 세션");
  for (const [days, title] of [
    [7, "7일 뒤"],
    [30, "37일 뒤"],
  ] as const) {
    await control({ advance: days * DAY });
    await page.reload();
    const current = rows(page).first();
    await expect(current).toBeVisible();
    await rename(
      page,
      (await current.locator(".idea-title").innerText()).trim(),
      title,
    );
    await onDrive(api, title);
    await expect(relogin(page)).toHaveCount(0);
  }
  await control({ advance: 61 * DAY });
  await page.reload();
  // Cached ideas open at once; only now does it ask for a sign-in.
  await expect(row(page, "37일 뒤")).toBeVisible();
  await expect(relogin(page).first()).toBeVisible();
  await rename(page, "37일 뒤", "만료 중 작성한 초안");
  await expect(
    page.getByText("Drive에 저장되지 않은 변경 사항 1개"),
  ).toBeVisible();
  await relogin(page).first().click();
  // Back where the user was, with the idea still open.
  await expect(page).toHaveURL(/\/IdeaDock\/#idea=/);
  await onDrive(api, "만료 중 작성한 초안");
  await expect(relogin(page)).toHaveCount(0);
});

test("revoked Google access asks to sign in again and keeps the draft", async ({
  page,
  context,
}) => {
  const user = userFor();
  const api = drive();
  await api.attach(context);
  await signIn(page, user);
  await createIdea(page, "권한 취소");
  await onDrive(api, "권한 취소");
  await control({ revoke: user });
  await rename(page, "권한 취소", "취소 후 초안");
  await expect(relogin(page).first()).toBeVisible();
  await expect(
    page.getByText("Drive에 저장되지 않은 변경 사항 1개"),
  ).toBeVisible();
  await relogin(page).first().click();
  await onDrive(api, "취소 후 초안");
  expect((await control()).sessions[user]).toBe(1);
});

test("Google outages and offline periods keep the session and the drafts", async ({
  page,
  context,
}) => {
  const user = userFor();
  const api = drive();
  await api.attach(context);
  await signIn(page, user);
  await createIdea(page, "장애 테스트");
  await onDrive(api, "장애 테스트");
  await settled(page);

  await context.setOffline(true);
  await rename(page, "장애 테스트", "오프라인 초안");
  await expect(
    page.getByText("Drive에 저장되지 않은 변경 사항 1개"),
  ).toBeVisible();
  await context.setOffline(false);
  await onDrive(api, "오프라인 초안");
  await settled(page);

  await control({ outage: true, advance: 61 * MIN });
  await rename(page, "오프라인 초안", "장애 중 초안");
  await expect(page.getByText(/Google 연결을 기다리는 중/)).toBeVisible();
  await expect(relogin(page)).toHaveCount(0);
  await control({ outage: false });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await onDrive(api, "장애 중 초안");
  await expect(page.getByText(/Google 연결을 기다리는 중/)).toHaveCount(0);
});

test("two browsers share one Google grant and see each other's ideas", async ({
  browser,
}) => {
  const user = userFor();
  const api = drive();
  const make = async () => {
    const { viewport, userAgent, isMobile, hasTouch } = test.info().project.use;
    const context = await browser.newContext({
      viewport,
      userAgent,
      isMobile,
      hasTouch,
      baseURL: `${origin}/IdeaDock/`,
    });
    await api.attach(context);
    return { context, page: await context.newPage() };
  };
  const issued = (await control()).refreshTokensIssued;
  const a = await make(),
    b = await make();
  await signIn(a.page, user);
  await signIn(b.page, user);
  expect((await control()).refreshTokensIssued).toBe(issued + 1);
  expect((await control()).sessions[user]).toBe(2);
  await createIdea(a.page, "다른 브라우저에서 보임");
  await onDrive(api, "다른 브라우저에서 보임");
  await b.page.reload();
  await expect(row(b.page, "다른 브라우저에서 보임")).toBeVisible();
  await a.context.close();
  await b.context.close();
});

test("switching accounts replaces the session; sign-out ends it for good", async ({
  page,
  context,
}) => {
  const user = userFor(),
    other = `${user}b`;
  const api = drive();
  await api.attach(context);
  await signIn(page, user);
  await control({ nextUser: other });
  await openSettings(page);
  await page
    .getByRole("button", { name: "다른 Google 계정으로 전환", exact: true })
    .click();
  await expect(page).toHaveURL(`${origin}/IdeaDock/`);
  await openSettings(page);
  await expect(page.getByText(`${other}@example.com`)).toBeVisible();
  let state = await control();
  expect(state.sessions[user]).toBeUndefined();
  expect(state.sessions[other]).toBe(1);

  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(welcome(page)).toBeVisible();
  state = await control();
  expect(state.sessions[other]).toBeUndefined();
  const seen = logins(page);
  await page.reload();
  await expect(welcome(page)).toBeVisible();
  expect(seen).toEqual([]);
});

test("other sites cannot read tokens or sign the user out", async ({
  page,
  context,
}) => {
  const user = userFor();
  await drive().attach(context);
  await signIn(page, user);
  // 127.0.0.1 is a different site from localhost: a stand-in attacker page.
  const evil = await context.newPage();
  await evil.goto(`${origin.replace("localhost", "127.0.0.1")}/IdeaDock/`);
  const read = await evil.evaluate(async (target) => {
    try {
      const r = await fetch(`${target}/api/auth/token`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-IdeaDock-Auth": "1" },
        body: "{}",
      });
      return `status ${r.status}: ${await r.text()}`;
    } catch {
      return "blocked";
    }
  }, origin);
  expect(read).toBe("blocked");
  await evil.evaluate((target) => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `${target}/api/auth/logout`;
    document.body.append(form);
    form.submit();
  }, origin);
  await expect(evil.locator("body")).toContainText('"reason":"csrf"');
  expect((await control()).sessions[user]).toBe(1);
  await page.reload();
  await expect(welcome(page)).toHaveCount(0);
  await expect(relogin(page)).toHaveCount(0);
});
