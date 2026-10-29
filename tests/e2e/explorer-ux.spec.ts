import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { mockDrive } from "../support/mock-drive";
import { seedDrive } from "../support/seed-drive";
import type { Idea } from "../../src/lib/model";
import type { Folder } from "../../src/lib/folders";
test.skip(process.env.IDEADOCK_E2E_DRIVE !== "1", "Dedicated mock Drive build");

type Seed = Parameters<typeof seedDrive>[1];
const rows = (page: Page) =>
  page.locator(".explorer-items article.idea-row:not(.folder-list-row)");
const folderRows = (page: Page) => page.locator(".folder-list-row");
const list = (page: Page) => page.locator(".explorer-list");
const ids = (page: Page) =>
  rows(page).evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).dataset.itemId),
  );
const checked = (page: Page) =>
  rows(page).evaluateAll((els) =>
    els
      .filter(
        (el) =>
          el.querySelector<HTMLInputElement>(".completion-check")!.checked,
      )
      .map((el) => (el as HTMLElement).dataset.itemId),
  );
const selectedHeading = (page: Page, n: number) =>
  page.getByRole("heading", { name: `${n}개 선택됨`, exact: true });

async function open(
  page: Page,
  context: BrowserContext,
  seed: Seed,
  options: { count?: number } = {},
) {
  const api = mockDrive({ pageSize: 1000 });
  await api.attach(context);
  const data = seedDrive(api, seed);
  await page.goto("./");
  await page
    .getByRole("button", { name: "Google로 시작하기", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(options.count ?? seed.ideas, {
    timeout: 30_000,
  });
  return { api, data };
}
const stored = (api: ReturnType<typeof mockDrive>) =>
  [...api.files.values()].map((f) => ({
    kind: f.appProperties.kind,
    json:
      f.mimeType === "application/json"
        ? JSON.parse(f.bytes.toString())
        : undefined,
  }));
const savedIdea = (api: ReturnType<typeof mockDrive>, id: string) =>
  stored(api)
    .filter((f) => f.kind === "revision" && f.json.idea.id === id)
    .map((f) => f.json.idea as Idea)
    .sort((a, b) => b.version - a.version)[0];
const savedFolder = (api: ReturnType<typeof mockDrive>, name: string) =>
  stored(api)
    .filter((f) => f.kind === "folder-revision" && f.json.folder.name === name)
    .map((f) => f.json.folder as Folder)
    .sort((a, b) => b.version - a.version)[0];
async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}
/** A row that is completely inside the list's viewport. */
async function visibleRow(page: Page, from = 1) {
  const area = await box(list(page));
  const count = await rows(page).count();
  for (let i = from; i < count; i++) {
    const b = await box(rows(page).nth(i));
    if (b.y >= area.y + 8 && b.y + b.height <= area.y + area.height - 8)
      return i;
  }
  throw new Error("No fully visible row");
}
/** Where a rectangle drag may start: the margin beside the rows. */
async function gutter(page: Page) {
  const first = await box(rows(page).first());
  return { x: first.x + first.width + 12, first, left: first.x + 60 };
}

test("shows the cached list at once while Drive answers slowly", async ({
  page,
  context,
}) => {
  const { api } = await open(page, context, {
    ideas: 40,
    revisions: 2,
    folders: 2,
    images: 3,
  });
  await page.waitForTimeout(1500);
  api.setSlow(5000);
  const started = Date.now();
  await page.reload();
  await expect(rows(page).first()).toBeVisible({ timeout: 3000 });
  expect(Date.now() - started).toBeLessThan(3000);
  await expect(rows(page)).toHaveCount(40);
  await expect(page.getByText("작업 공간을 불러오는 중")).toHaveCount(0);
});

test("stays interactive while a slow Drive sync is in flight and syncs afterwards", async ({
  page,
  context,
}, info) => {
  const { api, data } = await open(page, context, {
    ideas: 40,
    revisions: 2,
    folders: 2,
    images: 3,
  });
  await page.waitForTimeout(1500);
  api.setSlow(5000);
  await page.reload();
  await expect(rows(page).first()).toBeVisible({ timeout: 3000 });
  const target = data.ideas[39]; // newest, listed first
  const checkbox = rows(page).first().locator(".completion-check");
  const t0 = Date.now();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await rows(page).first().locator(".idea-summary").click();
  const title = page.getByRole("textbox", {
    name: "아이디어 제목 편집",
    exact: true,
  });
  await expect(title).toBeVisible({ timeout: 1500 });
  await title.fill("느린 Drive에서 수정");
  expect(Date.now() - t0).toBeLessThan(4000);
  if (info.project.name === "desktop")
    await expect(rows(page).first().locator(".idea-title")).toContainText(
      "느린 Drive에서 수정",
    );
  api.setSlow(0);
  await expect
    .poll(() => savedIdea(api, target.id)?.title, { timeout: 30_000 })
    .toBe("느린 Drive에서 수정");
  expect(savedIdea(api, target.id).is_completed).toBe(true);
});

test("downloads each picture once and recovers failed thumbnails", async ({
  page,
  context,
}) => {
  const api = mockDrive({ pageSize: 1000 });
  await api.attach(context);
  const data = seedDrive(api, {
    ideas: 12,
    revisions: 1,
    folders: 0,
    images: 2,
  });
  // Three failures in a row exhaust the request-level retries; the thumbnail
  // itself must then try again.
  api.failMedia([data.images[0]], 3);
  await page.goto("./");
  await page
    .getByRole("button", { name: "Google로 시작하기", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(12, { timeout: 30_000 });
  // Thumbnails load lazily: the ones below the fold only once scrolled to.
  const thumbs = page.locator(".idea-thumbnail img");
  await expect
    .poll(() => thumbs.count(), { timeout: 30_000 })
    .toBeGreaterThan(2);
  const height = await list(page).evaluate((el) => el.scrollHeight);
  for (let y = 0; y <= height; y += 250) {
    await list(page).evaluate((el, top) => el.scrollTo(0, top), y);
    await page.waitForTimeout(100);
  }
  await expect(thumbs).toHaveCount(12, { timeout: 30_000 });
  const downloads = api.takeStats().mediaKeys;
  const count = (key: string) => downloads.filter((k) => k === key).length;
  expect(count(data.images[0])).toBe(4); // 3 failures + 1 success, no repeats
  expect(count(data.images[1])).toBe(1); // six thumbnails, one download
});

test("completing an idea keeps its row, scroll, selection and detail", async ({
  page,
  context,
}, info) => {
  const { api } = await open(page, context, {
    ideas: 30,
    revisions: 1,
    folders: 2,
    images: 0,
  });
  const desktop = info.project.name === "desktop";
  let selectedId: string | undefined;
  if (desktop) {
    await rows(page).nth(6).locator(".idea-summary").click();
    selectedId = (await ids(page))[6]!;
    await expect(rows(page).nth(6)).toHaveClass(/is-selected/);
  }
  await list(page).evaluate((el) => el.scrollBy(0, 220));
  const index = await visibleRow(page, desktop ? 8 : 3);
  const before = await ids(page);
  const scroll = await list(page).evaluate((el) => el.scrollTop);
  expect(scroll).toBeGreaterThan(100);
  await rows(page).nth(index).locator(".completion-check").check();
  await expect(
    rows(page).nth(index).locator(".completion-check"),
  ).toBeChecked();
  await page.waitForTimeout(400); // let any re-sort or scroll jump happen
  expect(await ids(page)).toEqual(before);
  expect(await list(page).evaluate((el) => el.scrollTop)).toBe(scroll);
  if (desktop) {
    await expect(rows(page).nth(6)).toHaveClass(/is-selected/);
    await expect(
      page.getByRole("textbox", { name: "아이디어 제목 편집", exact: true }),
    ).toHaveValue(/가져온 아이디어/);
  }
  // Unchecking keeps the place just as well.
  await rows(page).nth(index).locator(".completion-check").uncheck();
  await page.waitForTimeout(300);
  expect(await ids(page)).toEqual(before);
  await rows(page).nth(index).locator(".completion-check").check();
  await expect
    .poll(() => savedIdea(api, before[index]!.slice(2))?.is_completed, {
      timeout: 20_000,
    })
    .toBe(true);
  // Choosing another sort applies the current order: the idea changed last.
  const sort = page.getByRole("combobox", { name: "아이디어 정렬" });
  await sort.selectOption("title");
  await sort.selectOption("updated");
  expect((await ids(page))[0]).toBe(before[index]);
  void selectedId;
});

test("consecutive checks change exactly the clicked ideas", async ({
  page,
  context,
}) => {
  await open(page, context, {
    ideas: 24,
    revisions: 1,
    folders: 0,
    images: 0,
  });
  const before = await ids(page);
  for (const i of [1, 2, 3]) {
    await rows(page).nth(i).locator(".completion-check").check();
    expect(await ids(page)).toEqual(before);
  }
  expect(await checked(page)).toEqual([before[1], before[2], before[3]]);
  await rows(page).nth(2).locator(".completion-check").uncheck();
  expect(await ids(page)).toEqual(before);
  expect(await checked(page)).toEqual([before[1], before[3]]);
});

test("in the open-ideas filter a completed idea stays until the list is tidied", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "desktop", "Sidebar filters");
  await open(page, context, { ideas: 12, revisions: 1, folders: 0, images: 0 });
  await page
    .locator(".sidebar nav button")
    .filter({ hasText: "미완료" })
    .click();
  await expect(rows(page)).toHaveCount(12);
  const before = await ids(page);
  await rows(page).nth(1).locator(".completion-check").check();
  await rows(page).nth(2).locator(".completion-check").check();
  await page.waitForTimeout(300);
  // Nothing moved or vanished, so the second click hit the idea aimed at.
  expect(await ids(page)).toEqual(before);
  expect(await checked(page)).toEqual([before[1], before[2]]);
  await expect(rows(page).nth(1)).toContainText("완료로 이동됨");
  await rows(page).nth(1).locator(".completion-check").uncheck(); // undo in place
  await expect(rows(page).nth(1)).not.toContainText("완료로 이동됨");
  await page.getByRole("button", { name: /목록 정리/ }).click();
  // Tidying applies the real sort and filter: the completed idea leaves, and
  // the one reopened last is now the most recently edited.
  expect(await ids(page)).toEqual([
    before[1],
    ...before.filter((_, i) => i !== 1 && i !== 2),
  ]);
  await expect(page.getByRole("button", { name: /목록 정리/ })).toHaveCount(0);
});

test("a dragged rectangle selects ideas, scrolls and leaves the text alone", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "desktop", "Mouse path");
  await open(page, context, { ideas: 40, revisions: 1, folders: 2, images: 0 });
  const { x, first, left } = await gutter(page);
  const row3 = await box(rows(page).nth(3));
  await page.mouse.move(x, first.y + 10);
  await page.mouse.down();
  await page.mouse.move(left, row3.y + row3.height - 6, { steps: 12 });
  await expect(page.locator(".selection-marquee")).toBeVisible();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
  await page.mouse.up();
  await expect(selectedHeading(page, 4)).toBeVisible();
  const selected = await rows(page).evaluateAll(
    (els) => els.filter((el) => el.classList.contains("is-selected")).length,
  );
  expect(selected).toBe(4);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
  // A plain click on the margin clears the selection.
  await page.mouse.click(x, first.y + 10);
  await expect(selectedHeading(page, 4)).toHaveCount(0);

  // Holding the pointer at the bottom edge scrolls and keeps selecting.
  const area = await box(list(page));
  await page.mouse.move(x, first.y + 10);
  await page.mouse.down();
  await page.mouse.move(left, area.y + area.height - 6, { steps: 10 });
  await page.waitForTimeout(900);
  expect(await list(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(150);
  await page.mouse.up();
  const many = await rows(page).evaluateAll(
    (els) => els.filter((el) => el.classList.contains("is-selected")).length,
  );
  expect(many).toBeGreaterThan(5);
});

test("Ctrl adds to the selection and rows still start their own drag", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "desktop", "Mouse path");
  await open(page, context, { ideas: 20, revisions: 1, folders: 0, images: 0 });
  await rows(page).nth(4).locator(".idea-summary").click();
  const { x, first, left } = await gutter(page);
  const row1 = await box(rows(page).nth(1));
  await page.keyboard.down("Control");
  await page.mouse.move(x, first.y + 10);
  await page.mouse.down();
  await page.mouse.move(left, row1.y + row1.height - 6, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(selectedHeading(page, 3)).toBeVisible();
  await expect(rows(page).nth(4)).toHaveClass(/is-selected/);
  // Pressing on a row must not start a rectangle.
  const row5 = await box(rows(page).nth(5));
  await page.mouse.move(row5.x + 200, row5.y + 20);
  await page.mouse.down();
  await page.mouse.move(row5.x + 220, row5.y + 60, { steps: 4 });
  await expect(page.locator(".selection-marquee")).toHaveCount(0);
  await page.mouse.up();
});

test("a rectangle selection can be dragged into a folder", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "desktop", "Mouse path");
  const { api, data } = await open(page, context, {
    ideas: 14,
    revisions: 1,
    folders: 3,
    images: 0,
    root: true,
  });
  await page.locator(".explorer-breadcrumb button").first().click();
  await expect(folderRows(page)).toHaveCount(3);
  const first = await box(rows(page).first());
  const third = await box(rows(page).nth(2));
  const x = first.x + first.width + 12;
  await page.mouse.move(x, first.y + 8);
  await page.mouse.down();
  await page.mouse.move(first.x + 80, third.y + third.height - 6, {
    steps: 10,
  });
  await page.mouse.up();
  await expect(selectedHeading(page, 3)).toBeVisible();
  const moved = (await ids(page)).slice(0, 3).map((id) => id!.slice(2));
  await rows(page)
    .first()
    .dragTo(folderRows(page).filter({ hasText: "폴더 2" }));
  await expect(rows(page)).toHaveCount(11);
  const target = data.folders.find((f) => f.name === "폴더 2")!;
  for (const id of moved)
    await expect
      .poll(() => savedIdea(api, id)?.folder_id, { timeout: 20_000 })
      .toBe(target.id);
  await folderRows(page)
    .filter({ hasText: "폴더 2" })
    .locator(".idea-summary")
    .dblclick();
  await expect(rows(page)).toHaveCount(3);
});

test("right-click on empty space creates folders and ideas where you are", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "desktop", "Mouse path");
  const { api, data } = await open(page, context, {
    ideas: 6,
    revisions: 1,
    folders: 2,
    images: 0,
    root: true,
  });
  await page.locator(".explorer-breadcrumb button").first().click();
  const menu = page.getByRole("menu", { name: "목록 작업" });
  const rightClickBlank = async () => {
    await page.locator(".explorer-blank").scrollIntoViewIfNeeded();
    await page.locator(".explorer-blank").click({ button: "right" });
    await expect(menu).toBeVisible();
  };

  // The selection survives a right-click on empty space; Escape closes the menu.
  await rows(page).nth(0).locator(".idea-summary").click();
  await rows(page)
    .nth(1)
    .locator(".idea-summary")
    .click({ modifiers: ["Control"] });
  await expect(selectedHeading(page, 2)).toBeVisible();
  await rightClickBlank();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "새 폴더",
    "새 아이디어",
  ]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(selectedHeading(page, 2)).toBeVisible();

  // At the root a new folder is created in the root.
  await rightClickBlank();
  page.once("dialog", (d) => d.accept("루트 새 폴더"));
  await menu.getByRole("menuitem", { name: "새 폴더", exact: true }).click();
  await expect(
    folderRows(page).filter({ hasText: "루트 새 폴더" }),
  ).toBeVisible();
  await expect
    .poll(() => savedFolder(api, "루트 새 폴더")?.parent_id, {
      timeout: 20_000,
    })
    .toBeNull();

  // Inside a folder both entries create inside that folder.
  const parent = data.folders.find((f) => f.name === "폴더 1")!;
  await folderRows(page)
    .filter({ hasText: "폴더 1" })
    .locator(".idea-summary")
    .dblclick();
  await rightClickBlank();
  page.once("dialog", (d) => d.accept("안쪽 폴더"));
  await menu.getByRole("menuitem", { name: "새 폴더", exact: true }).click();
  await expect(folderRows(page).filter({ hasText: "안쪽 폴더" })).toBeVisible();
  await expect
    .poll(() => savedFolder(api, "안쪽 폴더")?.parent_id, { timeout: 20_000 })
    .toBe(parent.id);
  await rightClickBlank();
  await menu
    .getByRole("menuitem", { name: "새 아이디어", exact: true })
    .click();
  await expect
    .poll(
      () =>
        stored(api)
          .filter((f) => f.kind === "revision")
          .map((f) => f.json.idea as Idea)
          .find((i) => i.title === "제목 없는 아이디어")?.folder_id,
      { timeout: 20_000 },
    )
    .toBe(parent.id);
});

test("the menu stays inside the window, closes on outside click and is disabled in the trash", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "desktop", "Mouse path");
  await open(page, context, { ideas: 30, revisions: 1, folders: 1, images: 0 });
  const menu = page.getByRole("menu", { name: "목록 작업" });
  const area = await box(list(page));
  // Bottom-right corner of the list: the menu is pulled back into view.
  await page.mouse.click(area.x + area.width - 4, area.y + area.height - 4, {
    button: "right",
  });
  await expect(menu).toBeVisible();
  const m = await box(menu);
  const viewport = page.viewportSize()!;
  expect(m.x + m.width).toBeLessThanOrEqual(viewport.width);
  expect(m.y + m.height).toBeLessThanOrEqual(viewport.height);
  expect(m.x).toBeGreaterThanOrEqual(0);
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);
  await page
    .locator(".sidebar nav button")
    .filter({ hasText: "휴지통" })
    .click();
  await page.locator(".explorer-blank").click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "새 폴더" })).toBeDisabled();
  await expect(
    menu.getByRole("menuitem", { name: "새 아이디어" }),
  ).toBeDisabled();
});

test("right-click on a folder offers the folder menu in the list and the tree", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "desktop", "Mouse path");
  const { api, data } = await open(page, context, {
    ideas: 6,
    revisions: 1,
    folders: 2,
    images: 0,
    root: true,
  });
  await page.locator(".explorer-breadcrumb button").first().click();
  const menu = page.getByRole("menu", { name: "항목 작업" });
  const one = data.folders.find((f) => f.name === "폴더 1")!;
  await folderRows(page)
    .filter({ hasText: "폴더 1" })
    .click({ button: "right" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "열기",
    "이 폴더 안에 새 폴더",
    "이름 변경",
    "이동",
    "삭제",
  ]);
  page.once("dialog", (d) => d.accept("하위 폴더 가"));
  await menu
    .getByRole("menuitem", { name: "이 폴더 안에 새 폴더", exact: true })
    .click();
  await expect(
    folderRows(page).filter({ hasText: "하위 폴더 가" }),
  ).toBeVisible();
  await expect
    .poll(() => savedFolder(api, "하위 폴더 가")?.parent_id, {
      timeout: 20_000,
    })
    .toBe(one.id);
  // The same menu from the folder tree on the left.
  await page.locator(".explorer-breadcrumb button").first().click();
  const two = data.folders.find((f) => f.name === "폴더 2")!;
  await page
    .locator(".folder-tree-row")
    .filter({ hasText: "폴더 2" })
    .click({ button: "right" });
  page.once("dialog", (d) => d.accept("하위 폴더 나"));
  await menu
    .getByRole("menuitem", { name: "이 폴더 안에 새 폴더", exact: true })
    .click();
  await expect
    .poll(() => savedFolder(api, "하위 폴더 나")?.parent_id, {
      timeout: 20_000,
    })
    .toBe(two.id);
  await page
    .locator(".folder-tree-row")
    .filter({ hasText: "폴더 1" })
    .click({ button: "right" });
  await menu.getByRole("menuitem", { name: "열기", exact: true }).click();
  await expect(
    folderRows(page).filter({ hasText: "하위 폴더 가" }),
  ).toBeVisible();
});

test("the list header is compact and the detail panel packs its sections", async ({
  page,
  context,
}, info) => {
  const mobile = info.project.name === "mobile";
  await open(page, context, { ideas: 8, revisions: 1, folders: 1, images: 2 });
  const header = await box(page.locator(".list-header"));
  expect(header.height).toBeLessThan(mobile ? 120 : 100);
  expect((await box(rows(page).first())).y).toBeLessThan(mobile ? 175 : 150);
  expect((await box(page.locator(".topbar"))).height).toBeLessThanOrEqual(
    mobile ? 48 : 40,
  );
  // No control in the header overlaps another.
  const parts = [
    page.locator(".list-title-row h1"),
    page.locator(".sort-field"),
    page.locator(".explorer-breadcrumb"),
    ...(await page.locator(".explorer-toolbar button").all()),
  ];
  const boxes = await Promise.all(parts.map(box));
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a],
        q = boxes[b];
      const apart =
        p.x + p.width <= q.x + 0.5 ||
        q.x + q.width <= p.x + 0.5 ||
        p.y + p.height <= q.y + 0.5 ||
        q.y + q.height <= p.y + 0.5;
      expect(apart, `header parts ${a} and ${b} overlap`).toBe(true);
    }

  await rows(page).first().locator(".idea-summary").click();
  const title = page.getByRole("textbox", {
    name: "아이디어 제목 편집",
    exact: true,
  });
  await expect(title).toBeVisible();
  const one = await box(title);
  expect(one.height).toBeLessThan(40); // a short title uses one line
  // The body starts right under the title: toolbar first, then the editor.
  const toolbar = await box(page.locator(".editor-toolbar"));
  expect(toolbar.y - (one.y + one.height)).toBeLessThanOrEqual(12);
  const body = await box(page.locator(".tiptap"));
  expect(body.y - (toolbar.y + toolbar.height)).toBeLessThanOrEqual(8);
  expect(body.height).toBeGreaterThanOrEqual(mobile ? 180 : 260);
  // Then tags, links and dates, with the reference images last.
  const order = await page
    .locator(
      ".detail-scroll > .memo-section, .detail-scroll > .detail-section, .detail-scroll > .detail-dates",
    )
    .evaluateAll((els) =>
      els.map((el) =>
        el.classList.contains("memo-section")
          ? "body"
          : el.classList.contains("detail-dates")
            ? "dates"
            : el.querySelector(".image-grid")
              ? "images"
              : el.querySelector(".editable-tags")
                ? "tags"
                : "links",
      ),
    );
  expect(order).toEqual(["body", "tags", "links", "dates", "images"]);
  // A long title grows the box, and nothing scrolls sideways.
  await title.fill("아주 긴 제목 ".repeat(14));
  await expect
    .poll(async () => (await box(title)).height)
    .toBeGreaterThan(one.height + 30);
  expect(
    await page
      .locator(".detail-scroll")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
});
