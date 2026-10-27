import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const output = "docs/screenshots/ui-final";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  // Dedicated synthetic demo data; never connects to an account or changes an
  // existing browser profile, Drive idea, or backup.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  await page.goto(process.env.PREVIEW_URL || "http://127.0.0.1:4173/IdeaDock/");
  await page.screenshot({
    path: `${output}/desktop-login.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/mobile-login.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => {
    const preview = (variant) => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 200;
      const c = canvas.getContext("2d");
      c.fillStyle = "#f4f4f5";
      c.fillRect(0, 0, 320, 200);
      c.fillStyle = "#fff";
      c.fillRect(12, 12, 296, 176);
      c.fillStyle = "#e4e4e7";
      c.fillRect(12, 12, 60, 176);
      c.fillStyle = "#a1a1aa";
      for (let i = 0; i < 5; i++) c.fillRect(22, 32 + i * 20, 38, 4);
      c.fillStyle = "#d4d4d8";
      c.fillRect(88, 28, 130, 7);
      c.fillStyle = variant ? "#d1d9e4" : "#b7cad5";
      for (let i = 0; i < 3; i++) c.fillRect(88 + i * 68, 52, 58, 33);
      c.fillStyle = "#e4e4e7";
      for (let i = 0; i < 4; i++) c.fillRect(88, 102 + i * 16, 194 - i * 13, 7);
      return canvas.toDataURL("image/png");
    };
    const now = "2026-10-27T10:00:00.000Z";
    const data = [
      {
        title: "프로젝트 대시보드",
        text: "작업 현황과 마감일을 한 화면에서 확인하는 대시보드. 첨부한 화면 구성안을 기준으로 목록과 상세 화면을 구현합니다.",
        tags: ["웹", "UI"],
        image: true,
        pinned: true,
      },
      {
        title: "독서 기록 관리",
        text: "책 제목, 저자, 읽은 날짜와 메모를 정리합니다.",
        tags: ["개인 도구"],
        completed: true,
      },
      {
        title: "모바일에서 사용하는 일정 관리와 알림 화면 구성 검토",
        text: "주간 일정과 알림 설정의 모바일 화면을 검토합니다.",
        tags: ["모바일", "기획", "반응형"],
        image: true,
      },
      {
        title: "자료 링크 모음",
        text: "문서와 저장소 링크를 태그로 분류합니다.",
        tags: ["자료"],
      },
    ];
    const ideas = data.map((item, index) => {
      const image = {
        id: crypto.randomUUID(),
        storage_path: preview(index),
        original_filename: "화면 구성안.png",
      };
      return {
        id: crypto.randomUUID(),
        user_id: "demo",
        title: item.title,
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: item.text }] },
          ],
        },
        plain_text: item.text,
        tags: item.tags,
        links: [],
        images: item.image ? [image] : [],
        is_completed: !!item.completed,
        is_pinned: !!item.pinned,
        created_at: now,
        updated_at: new Date(Date.parse(now) - index * 86400000).toISOString(),
        deleted_at: null,
        version: 0,
      };
    });
    localStorage.setItem(
      "ideadock:data:demo",
      JSON.stringify({ ideas, pending: {} }),
    );
    localStorage.setItem("ideadock:theme", "light");
  });
  await page.reload();
  await page
    .getByRole("button", { name: "체험 모드 열기", exact: true })
    .click();
  await page.locator(".idea-thumbnail img").first().waitFor();
  await page
    .getByRole("button", { name: "체험 데이터 안내 닫기", exact: true })
    .click();
  await page.screenshot({ path: `${output}/desktop-list.png`, fullPage: true });
  await page.getByRole("button", { name: "데이터 관리", exact: true }).click();
  await page.screenshot({ path: `${output}/desktop-data.png`, fullPage: true });
  await page
    .getByRole("button", { name: "기존 데이터 찾기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "저장소 다시 조사", exact: true })
    .waitFor();
  await expect(
    page.getByRole("button", { name: "데이터 관리 닫기", exact: true }),
  ).toHaveAttribute("aria-disabled", "false");
  await page.screenshot({
    path: `${output}/desktop-discovery.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "데이터 관리 닫기", exact: true })
    .click();
  await page.getByRole("button", { name: "데이터 관리", exact: true }).click();
  await page
    .locator(".idea-summary")
    .filter({ hasText: "프로젝트 대시보드" })
    .click();
  await page
    .getByRole("img", { name: "화면 구성안.png", exact: true })
    .waitFor();
  await page.screenshot({
    path: `${output}/desktop-detail.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "작업 공간 설정", exact: true })
    .click();
  await page.getByRole("button", { name: "다크", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${output}/desktop-dark.png`, fullPage: true });
  await page
    .getByRole("button", { name: "작업 공간 설정", exact: true })
    .click();
  await page.getByRole("button", { name: "라이트", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${output}/mobile-detail.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "목록으로 돌아가기", exact: true })
    .click();
  await page.screenshot({ path: `${output}/mobile-list.png`, fullPage: true });
  await page
    .getByRole("button", { name: "탐색 패널 열기", exact: true })
    .click();
  await page.getByRole("button", { name: "데이터 관리", exact: true }).click();
  await page.screenshot({ path: `${output}/mobile-data.png`, fullPage: true });
  await page
    .getByRole("button", { name: "JSON 가져오기", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "JSON 가져오기", exact: true })
    .waitFor();
  await expect(
    page.getByRole("button", { name: "데이터 관리 닫기", exact: true }),
  ).toHaveAttribute("aria-disabled", "false");
  await page.screenshot({
    path: `${output}/mobile-import.png`,
    fullPage: true,
  });
  const empty = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: "light",
  });
  const emptyPage = await empty.newPage();
  await emptyPage.goto(
    process.env.PREVIEW_URL || "http://127.0.0.1:4173/IdeaDock/",
  );
  await emptyPage
    .getByRole("button", { name: "체험 모드 열기", exact: true })
    .click();
  await emptyPage
    .getByRole("button", { name: "체험 데이터 안내 닫기", exact: true })
    .click();
  await emptyPage.screenshot({
    path: `${output}/desktop-empty.png`,
    fullPage: true,
  });
  await empty.close();
  await context.close();
  console.log(
    `Saved twelve actual browser screenshots in ${output}; all data is synthetic.`,
  );
} finally {
  await browser.close();
}
