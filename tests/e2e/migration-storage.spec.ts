import { openData, openNav } from "./helpers";
import { test, expect } from "@playwright/test";
import { makeIdea } from "../../src/lib/model";

test("JSON preview can be edited, backed up and restored without overwriting the legacy demo", async ({
  page,
}) => {
  await page.goto("./");
  const existing = makeIdea("기존 데이터 유지", "demo");
  await page.evaluate(
    (idea) =>
      localStorage.setItem(
        "ideadock:data:demo",
        JSON.stringify({ ideas: [idea], pending: {} }),
      ),
    existing,
  );
  await openData(page);
  await page
    .getByRole("button", { name: "JSON 가져오기", exact: true })
    .click();
  const candidate = makeIdea("가져올 제목", "demo");
  candidate.is_pinned = true;
  candidate.content = {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "본문 서식 보존" }],
      },
    ],
  };
  await page.getByLabel("JSON 백업 파일 확인", { exact: true }).setInputFiles({
    name: "old-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ exported_at: "2025-01-01", ideas: [candidate] }),
    ),
  });
  const preview = page.getByRole("textbox", { name: "가져오기 미리보기" });
  await expect(preview).toBeVisible();
  const value = JSON.parse(await preview.inputValue());
  value[0].ideas[0].title = "검토 후 수정한 제목";
  await preview.fill(JSON.stringify(value));
  await page
    .getByRole("button", { name: "수정한 결과 확인", exact: true })
    .click();
  await page.getByRole("checkbox", { name: /JSON 백업 \(demo\)/ }).check();
  await page
    .getByRole("button", {
      name: "선택한 1개 무결성 검사 및 복구 백업 만들기",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Google Drive로 데이터 이전 승인",
      exact: true,
    }),
  ).toBeDisabled();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "이미지 포함 복구 백업 다운로드",
      exact: true,
    })
    .click();
  await download;
  await page
    .getByRole("checkbox", { name: "복구 백업 파일을 내려받아 보관했습니다." })
    .check();
  await page
    .getByRole("button", {
      name: "복구 백업을 체험 모드에 병합 승인",
      exact: true,
    })
    .click();
  await expect(page.getByText(/1개 복구 완료/)).toBeVisible();
  const cache = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ideadock:data:demo")!),
  );
  expect(cache.ideas).toHaveLength(2);
  expect(cache.ideas[0]).toEqual(existing);
  expect(cache.ideas[1]).toMatchObject({
    id: candidate.id,
    title: "검토 후 수정한 제목",
    is_pinned: true,
    content: candidate.content,
  });
  await page
    .getByRole("button", { name: "데이터 관리 닫기", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "체험 모드 열기", exact: true })
    .click();
  await expect(
    page.getByRole("article").filter({ hasText: "검토 후 수정한 제목" }),
  ).toHaveCount(1);
});

test("a corrupt demo cache is reported and preserved instead of being initialized away", async ({
  page,
}) => {
  await page.goto("./");
  const raw = '{"ideas": [broken original bytes';
  await page.evaluate(
    (value) => localStorage.setItem("ideadock:data:demo", value),
    raw,
  );
  await page
    .getByRole("button", { name: "체험 모드 열기", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: /JSON|Unexpected|Expected/ }),
  ).toBeVisible();
  await openNav(page);
  await page.getByRole("button", { name: "새 아이디어", exact: true }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("ideadock:data:demo")),
  ).toBe(raw);
  await openData(page);
  await page
    .getByRole("button", { name: "기존 데이터 찾기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "저장소 다시 조사", exact: true })
    .click();
  await expect(
    page.getByRole("listitem").filter({ hasText: "체험 모드" }),
  ).toContainText("검토 필요");
  await expect(
    page.getByRole("button", {
      name: "선택한 0개 무결성 검사 및 복구 백업 만들기",
      exact: true,
    }),
  ).toBeDisabled();
});
