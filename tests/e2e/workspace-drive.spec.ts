import { test, expect, type Page } from "@playwright/test";
import { mockDrive } from "../support/mock-drive";
import { docxFixture } from "../support/docx-fixture";
import { createIdea, openData, openNav } from "./helpers";
test.skip(process.env.IDEADOCK_E2E_DRIVE !== "1", "Dedicated mock Drive build");
async function connect(page: Page) {
  await page.goto("./");
  await page
    .getByRole("button", { name: "Google로 시작하기", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Google로 시작하기", exact: true }),
  ).toHaveCount(0);
}
test("folder changes persist across two sessions after an upload failure", async ({
  page,
  context,
  browser,
}, info) => {
  const api = mockDrive();
  await api.attach(context);
  await connect(page);
  await openNav(page);
  api.rejectWrites(true);
  page.once("dialog", (d) => d.accept("Drive 폴더"));
  await page
    .getByRole("button", { name: "새 폴더 만들기", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: /503/ }),
  ).toBeVisible();
  await expect(
    page.getByText("미저장 폴더 변경 1개", { exact: true }),
  ).toBeVisible();
  api.rejectWrites(false);
  await page
    .getByRole("button", { name: "폴더 저장 재시도", exact: true })
    .click();
  await expect(
    page.getByText("미저장 폴더 변경 1개", { exact: true }),
  ).toHaveCount(0);
  await openNav(page);
  page.once("dialog", (d) => d.accept("상위 폴더"));
  await page
    .getByRole("button", { name: "새 폴더 만들기", exact: true })
    .click();
  await expect(page.getByText(/미저장 폴더 변경/)).toHaveCount(0);
  await page
    .locator(".folder-list-row")
    .filter({ hasText: "Drive 폴더" })
    .locator(".idea-summary")
    .click();
  page.once("dialog", (d) => d.accept("Drive 폴더 수정"));
  await page.getByRole("button", { name: "이름 변경", exact: true }).click();
  await expect(page.getByText(/미저장 폴더 변경/)).toHaveCount(0);
  await page.getByRole("button", { name: "이동", exact: true }).click();
  await page
    .getByRole("combobox", { name: "이동할 폴더", exact: true })
    .selectOption({ label: "상위 폴더" });
  await page
    .getByRole("button", { name: "선택 항목 이동", exact: true })
    .click();
  await expect(page.getByText(/미저장 폴더 변경/)).toHaveCount(0);
  const other = await browser.newContext({
    viewport: info.project.use.viewport,
  });
  try {
    await api.attach(other);
    const second = await other.newPage();
    await second.goto(info.project.use.baseURL!);
    await second
      .getByRole("button", { name: "Google로 시작하기", exact: true })
      .click();
    await openNav(second);
    await second
      .getByRole("button", { name: "상위 폴더 펼치기", exact: true })
      .click();
    await expect(
      second
        .locator(".folder-tree-name")
        .filter({ hasText: "Drive 폴더 수정" }),
    ).toBeVisible();
    expect(
      [...api.files.values()].filter(
        (f) => f.appProperties.kind === "folder-revision",
      ),
    ).toHaveLength(4);
    expect(
      [...api.files.values()].filter(
        (f) => f.appProperties.ideadockRoot === "v1",
      ),
    ).toHaveLength(1);
  } finally {
    await other.close();
  }
});
test("Word import recovers a lost upload reply by itself, rechecks images and skips the same file", async ({
  page,
  context,
}) => {
  const api = mockDrive();
  await api.attach(context);
  await connect(page);
  await createIdea(page, "기존 보존 아이디어");
  await page
    .getByRole("textbox", { name: "아이디어 본문", exact: true })
    .fill("변경하면 안 되는 원문");
  await expect(page.getByText(/Drive에 저장되지 않은 변경 사항/)).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "상세 패널 닫기", exact: true })
    .click();
  const original = [...api.files.values()]
    .find((f) => f.appProperties.kind === "revision")!
    .bytes.toString();
  await openData(page);
  await page
    .getByRole("button", { name: "Word 가져오기", exact: true })
    .click();
  const file = {
    name: "만들거.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from(docxFixture()),
  };
  await page.getByLabel("Word 문서 선택", { exact: true }).setInputFiles(file);
  await expect(
    page.getByRole("textbox", { name: "항목 2 제목", exact: true }),
  ).toHaveValue("명지대 통닭트럭");
  api.failSecond();
  await page
    .getByRole("button", {
      name: "복구 백업 생성 후 선택 항목 가져오기 승인",
      exact: true,
    })
    .click();
  // The lost reply is looked up by hash and retried by the import itself.
  await expect(
    page.getByText(/Drive 문서·이미지 재조회 검증 완료/),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("button", {
      name: "실패 지점부터 Word 가져오기 재시도 승인",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    [...api.files.values()].filter((f) => f.appProperties.kind === "revision"),
  ).toHaveLength(3);
  expect(
    [...api.files.values()].filter((f) => f.appProperties.kind === "image"),
  ).toHaveLength(1);
  expect(
    [...api.files.values()].some((f) => f.bytes.toString() === original),
  ).toBe(true);
  await expect(
    page.getByLabel("Word 문서 선택", { exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Word 문서 선택", { exact: true }).setInputFiles(file);
  await expect(
    page.getByRole("combobox", { name: "항목 1 중복 처리", exact: true }),
  ).toHaveValue("skip");
  await expect(
    page.getByRole("combobox", { name: "항목 2 중복 처리", exact: true }),
  ).toHaveValue("skip");
  await expect(
    page.getByRole("button", {
      name: "복구 백업 생성 후 선택 항목 가져오기 승인",
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    [...api.files.values()].filter((f) => f.appProperties.kind === "revision"),
  ).toHaveLength(3);
});
