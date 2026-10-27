import { createIdea, openData } from "./helpers";
import { test, expect, BrowserContext, Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { makeIdea } from "../../src/lib/model";
import { canonical } from "../../src/lib/integrity";

test.skip(
  process.env.IDEADOCK_E2E_DRIVE !== "1",
  "Run npm run test:e2e:drive for isolated mock OAuth and Drive API",
);
test("connected Drive with no ideas shows the authenticated empty state", async ({
  page,
  context,
}) => {
  const api = mockDrive();
  await api.attach(context);
  await page.goto("./");
  await expect(
    page.getByText("아이디어가 없습니다", { exact: true }),
  ).toHaveCount(0);
  await login(page);
  await page
    .getByRole("button", { name: "데이터 관리 닫기", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByText("아이디어가 없습니다", { exact: true }),
  ).toBeVisible();
  expect(api.files.size).toBe(0);
});
const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
type Stored = {
  id: string;
  appProperties: { key?: string; kind?: string; ideadockRoot?: string };
  name?: string;
  parents?: string[];
  mimeType: string;
  bytes: Buffer;
};
function mockDrive() {
  const files = new Map<string, Stored>();
  const uploads = new Map<string, Omit<Stored, "bytes">>();
  let allocation = 0,
    revisions = 0;
  let loseSecondRevision = false;
  let rejectWrites = false;
  return {
    files,
    rejectWrites: (value: boolean) => {
      rejectWrites = value;
    },
    failSecond: () => {
      loseSecondRevision = true;
    },
    attach: async (context: BrowserContext) => {
      await context.route("https://accounts.google.com/gsi/client", (route) =>
        route.fulfill({
          contentType: "application/javascript",
          body: `window.google={accounts:{oauth2:{initTokenClient(options){if(!options.scope.includes("drive.file") || options.scope.includes("drive.appdata")) throw new Error("Unexpected Drive scope"); return {requestAccessToken(){options.callback({access_token:"test-only",expires_in:3600,scope:options.scope});}}}}}};`,
        }),
      );
      await context.route(
        "https://openidconnect.googleapis.com/v1/userinfo",
        (route) =>
          route.fulfill({
            json: { sub: "alice", email: "alice@example.com", name: "Alice" },
          }),
      );
      await context.route("https://www.googleapis.com/**", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (request.method() === "OPTIONS")
          return route.fulfill({
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "*",
              "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
            },
          });
        const headers = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "Location",
        };
        if (url.pathname.endsWith("generateIds")) {
          expect(url.searchParams.get("space")).toBe("drive");
          return route.fulfill({
            headers,
            json: { ids: [`file-${++allocation}`] },
          });
        }
        if (url.pathname === "/drive/v3/files" && request.method() === "POST") {
          const folder = request.postDataJSON() as Omit<Stored, "bytes">;
          expect(folder.mimeType).toBe("application/vnd.google-apps.folder");
          expect(folder.name).toBe("IdeaDock");
          if (files.has(folder.id))
            return route.fulfill({ headers, status: 409 });
          files.set(folder.id, { ...folder, bytes: Buffer.alloc(0) });
          return route.fulfill({ headers, json: { id: folder.id } });
        }
        if (
          url.pathname.startsWith("/upload/") &&
          request.method() === "POST"
        ) {
          const metadata = request.postDataJSON() as Omit<Stored, "bytes">;
          if (rejectWrites)
            return route.fulfill({
              headers,
              status: 503,
              body: "test write failure",
            });
          if (files.has(metadata.id))
            return route.fulfill({ headers, status: 409, body: "exists" });
          uploads.set(metadata.id, metadata);
          return route.fulfill({
            headers: {
              ...headers,
              Location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${metadata.id}`,
            },
            status: 200,
            body: "",
          });
        }
        if (url.pathname.startsWith("/upload/") && request.method() === "PUT") {
          const id = url.searchParams.get("upload_id")!,
            metadata = uploads.get(id)!;
          const bytes = request.postDataBuffer()!;
          expect(
            metadata.parents?.every(
              (id) => files.get(id)?.appProperties.ideadockRoot === "v1",
            ),
          ).toBe(true);
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(
            metadata.appProperties.key,
          );
          files.set(id, { ...metadata, bytes });
          if (
            metadata.appProperties.kind === "revision" &&
            ++revisions === 2 &&
            loseSecondRevision
          ) {
            loseSecondRevision = false;
            return route.abort("failed"); // committed, but the client lost the response
          }
          return route.fulfill({ headers, json: { id } });
        }
        if (url.searchParams.get("alt") === "media") {
          const file = files.get(url.pathname.split("/").at(-1)!);
          return file
            ? route.fulfill({
                headers,
                contentType: file.mimeType,
                body: file.bytes,
              })
            : route.fulfill({ headers, status: 404 });
        }
        const query = url.searchParams.get("q") || "";
        const kind = query.match(/value='([^']+)'/)?.[1];
        const parentIds = [...query.matchAll(/'([^']+)' in parents/g)].map(
          (m) => m[1],
        );
        const rows = [...files.values()].filter((f) =>
          query.includes("ideadockRoot")
            ? f.appProperties.ideadockRoot === "v1"
            : f.appProperties.kind === kind &&
              !!f.parents?.some((id) => parentIds.includes(id)),
        );
        // Deliberately paginate at one file to exercise multi-page listing.
        const index = Number(url.searchParams.get("pageToken") || 0);
        return route.fulfill({
          headers,
          json: {
            files: rows
              .slice(index, index + 1)
              .map(({ id, appProperties }) => ({ id, appProperties })),
            ...(index + 1 < rows.length
              ? { nextPageToken: String(index + 1) }
              : {}),
          },
        });
      });
    },
  };
}
function demoData() {
  const image = {
    id: "image-one",
    storage_path: pixel,
    original_filename: "원본.png",
  };
  const first = {
    ...makeIdea("보존할 아이디어", "demo"),
    is_completed: true,
    is_pinned: true,
    tags: ["이전"],
    images: [image],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "굵은 본문", marks: [{ type: "bold" }] },
          ],
        },
        { type: "ideaImage", attrs: image },
      ],
    },
  };
  const second = {
    ...makeIdea("휴지통 아이디어", "demo"),
    deleted_at: "2024-01-01T00:00:00.000Z",
  };
  return JSON.stringify({ ideas: [first, second], pending: {} });
}
async function login(page: Page) {
  await page.getByRole("button", { name: "Google로 시작하기" }).click();
  await expect(
    page.getByRole("button", { name: "Google로 시작하기" }),
  ).toHaveCount(0);
  await openData(page);
  await page
    .getByRole("button", { name: "기존 데이터 찾기", exact: true })
    .click();
}
async function approve(page: Page) {
  await page
    .getByRole("button", {
      name: "체험 모드 데이터를 Google Drive로 이전",
      exact: true,
    })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "이미지 포함 복구 백업 다운로드" })
    .click();
  expect((await download).suggestedFilename()).toMatch(/^ideadock-recovery-/);
  await page
    .getByRole("checkbox", { name: "복구 백업 파일을 내려받아 보관했습니다." })
    .check();
  await page
    .getByRole("button", {
      name: "Google Drive로 데이터 이전 승인",
      exact: true,
    })
    .click();
}
test("approval, image backup, repeated migration and second-device reload", async ({
  page,
  context,
  browser,
}, testInfo) => {
  const api = mockDrive();
  await api.attach(context);
  const raw = demoData();
  await page.goto("./");
  await page.evaluate(
    (value) => localStorage.setItem("ideadock:data:demo", value),
    raw,
  );
  await login(page);
  await expect(
    page.getByRole("button", { name: "나중에 이전", exact: true }),
  ).toBeVisible();
  expect(api.files.size).toBe(0);
  await approve(page);
  await expect(page.getByText(/이전 및 서버 재조회 검증 완료/)).toBeVisible();
  expect(
    [...api.files.values()].filter(
      (f) => f.appProperties.ideadockRoot === "v1",
    ),
  ).toHaveLength(1);
  expect(
    await page.evaluate(() => localStorage.getItem("ideadock:data:demo")),
  ).toBe(raw);
  expect(
    [...api.files.values()].filter((f) => f.appProperties.kind === "image"),
  ).toHaveLength(1);
  expect(
    [...api.files.values()].filter((f) => f.appProperties.kind === "revision"),
  ).toHaveLength(2);
  const revision = [...api.files.values()]
    .filter((f) => f.appProperties.kind === "revision")
    .map((f) => JSON.parse(f.bytes.toString()))
    .find((r) => r.idea.title === "보존할 아이디어");
  expect(revision.idea).toMatchObject({
    is_completed: true,
    is_pinned: true,
    tags: ["이전"],
    provenance: { source: "demo" },
  });
  expect(revision.idea.content.content[0].content[0].marks).toEqual([
    { type: "bold" },
  ]);
  expect(revision.idea.images[0].storage_path).toMatch(/^drive-sha:/);
  await page
    .getByRole("button", {
      name: "Google Drive로 데이터 이전 승인",
      exact: true,
    })
    .click();
  await expect(page.getByText(/이전 및 서버 재조회 검증 완료/)).toBeVisible();
  expect(
    [...api.files.values()].filter((f) => f.appProperties.kind === "revision"),
  ).toHaveLength(2);
  const other = await browser.newContext();
  try {
    await api.attach(other);
    const second = await other.newPage();
    await second.goto(testInfo.project.use.baseURL!);
    await login(second);
    await second
      .getByRole("button", { name: "데이터 관리 닫기", exact: true })
      .click();
    await second.keyboard.press("Escape");
    await expect(
      second.getByRole("article").filter({ hasText: "보존할 아이디어" }),
    ).toHaveCount(1);
    await second
      .getByRole("article")
      .filter({ hasText: "보존할 아이디어" })
      .locator("button.idea-summary")
      .click();
    const body = second.getByRole("textbox", { name: "아이디어 본문" });
    await expect(body.getByRole("img", { name: "원본.png" })).toBeVisible();
    await expect(body.locator("strong")).toHaveText("굵은 본문");
    await second
      .getByRole("button", { name: "상세 패널 닫기", exact: true })
      .click();
    if (
      !(await second
        .getByRole("button", { name: "휴지통", exact: false })
        .first()
        .isVisible())
    )
      await second.getByRole("button", { name: "탐색 패널 열기" }).click();
    await second
      .getByRole("button", { name: "휴지통", exact: false })
      .first()
      .click();
    await expect(
      second.getByRole("article").filter({ hasText: "휴지통 아이디어" }),
    ).toHaveCount(1);
    await expect(second.getByText("이전한 아이디어").first()).toBeVisible();
    expect(
      await second.evaluate(() => localStorage.getItem("ideadock:data:demo")),
    ).toBeNull();
  } finally {
    await other.close().catch(() => {});
  }
});

test("Drive save failures, retry and concurrent-edit warnings remain visible while editing", async ({
  page,
  context,
}) => {
  const api = mockDrive();
  await api.attach(context);
  await page.goto("./");
  await login(page);
  await page
    .getByRole("button", { name: "데이터 관리 닫기", exact: true })
    .click();
  await page.keyboard.press("Escape");
  api.rejectWrites(true);
  await createIdea(page, "저장 실패 확인");
  await expect(
    page.getByRole("alert").filter({ hasText: /503/ }),
  ).toBeVisible();
  await expect(
    page.getByText(/Drive에 저장되지 않은 변경 사항 1개/),
  ).toBeVisible();
  api.rejectWrites(false);
  await page.getByRole("button", { name: "저장 재시도", exact: true }).click();
  await expect(page.getByText(/Drive에 저장되지 않은 변경 사항/)).toHaveCount(
    0,
  );
  await expect(page.locator(".sync-alerts").getByRole("alert")).toHaveCount(0);
  const original = [...api.files.values()].find(
    (f) => f.appProperties.kind === "revision",
  )!;
  const remote = JSON.parse(original.bytes.toString());
  remote.parent = original.appProperties.key;
  remote.idea.title = "다른 기기의 변경";
  remote.idea.version++;
  const bytes = Buffer.from(canonical(remote));
  api.files.set("external-revision", {
    ...original,
    id: "external-revision",
    bytes,
    appProperties: {
      kind: "revision",
      key: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  await page
    .getByRole("textbox", { name: "아이디어 제목 편집" })
    .fill("내 기기의 변경");
  await expect(
    page.getByRole("alert").filter({ hasText: "동시 편집 충돌" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "내 초안을 복사하고 서버 버전 불러오기",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    [...api.files.values()].filter((f) => f.appProperties.kind === "revision"),
  ).toHaveLength(2);
});
test("deferral preserves the original demo and lost upload replies can be retried", async ({
  page,
  context,
}) => {
  const api = mockDrive();
  api.failSecond();
  await api.attach(context);
  const raw = demoData();
  await page.goto("./");
  await page.evaluate(
    (value) => localStorage.setItem("ideadock:data:demo", value),
    raw,
  );
  await login(page);
  await page.getByRole("button", { name: "나중에 이전", exact: true }).click();
  expect(api.files.size).toBe(0);
  expect(
    await page.evaluate(() => localStorage.getItem("ideadock:data:demo")),
  ).toBe(raw);
  await openData(page);
  await page
    .getByRole("button", { name: "기존 데이터 찾기", exact: true })
    .click();
  await approve(page);
  await expect(
    page.getByRole("button", { name: "이전 재시도 승인", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "이전 재시도 승인", exact: true })
    .click();
  await expect(page.getByText(/이전 및 서버 재조회 검증 완료/)).toBeVisible();
  expect(
    [...api.files.values()].filter((f) => f.appProperties.kind === "revision"),
  ).toHaveLength(2);
  expect(
    await page.evaluate(() => localStorage.getItem("ideadock:data:demo")),
  ).toBe(raw);
});
