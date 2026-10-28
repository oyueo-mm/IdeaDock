import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";
const out = process.env.CAPTURE_OUTPUT || "docs/screenshots/v02",
  url = process.env.PREVIEW_URL || "http://127.0.0.1:4189/IdeaDock/";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const pageErrors = [],
  failedResources = [];
let driveRequests = 0;
async function guard(context) {
  await context.route("https://www.googleapis.com/**", (r) => {
    driveRequests++;
    return r.abort();
  });
  context.on("page", (p) => {
    p.on("pageerror", (e) => pageErrors.push(e.message));
    p.on("response", (r) => {
      if (r.url().startsWith(new URL(url).origin) && r.status() >= 400)
        failedResources.push(r.url());
    });
  });
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const docx = zipSync(
  {
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>',
    ),
    "word/document.xml": strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:t>오목 AI 실험</w:t></w:r></w:p><w:p><w:r><w:t>탐색 알고리즘과 평가 함수를 비교합니다.</w:t></w:r></w:p><w:p><w:r><w:t>여러 문단의 원문을 하나의 아이디어에 보관합니다.</w:t></w:r></w:p><w:p><w:r><w:t>=====</w:t></w:r></w:p><w:p><w:r><w:t>웹 서비스 구성안</w:t></w:r></w:p><w:p><w:r><w:t>화면과 참고 이미지를 함께 확인합니다.</w:t></w:r><w:r><w:drawing><a:blip r:embed="img"/></w:drawing></w:r></w:p></w:body></w:document>',
    ),
    "word/_rels/document.xml.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="img" Target="media/example.png"/></Relationships>',
    ),
    "word/media/example.png": png,
  },
  { mtime: new Date("2020-01-01") },
);
async function nav(page) {
  if (
    !(await page
      .getByRole("button", { name: "새 아이디어", exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", { name: "탐색 패널 열기", exact: true })
      .click();
}
async function folder(page, name) {
  await nav(page);
  page.once("dialog", (d) => d.accept(name));
  await page
    .getByRole("button", { name: "새 폴더 만들기", exact: true })
    .click();
  await expect(
    page.locator(".folder-list-row").filter({ hasText: name }),
  ).toBeVisible();
}
async function demo(page) {
  const response = await page.goto(url);
  expect(response.status()).toBe(200);
  await page
    .getByRole("button", { name: "체험 모드 열기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "체험 데이터 안내 닫기", exact: true })
    .click();
}
async function word(page) {
  await nav(page);
  const menu = page.getByRole("button", { name: "데이터 관리", exact: true });
  if ((await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
  await page
    .getByRole("button", { name: "Word 가져오기", exact: true })
    .click();
  await page.getByLabel("Word 문서 선택", { exact: true }).setInputFiles({
    name: "Word 가져오기 예제.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from(docx),
  });
  await expect(
    page.getByRole("textbox", { name: "항목 2 제목", exact: true }),
  ).toHaveValue("웹 서비스 구성안");
}
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: "light",
  });
  await guard(context);
  const page = await context.newPage();
  await demo(page);
  await folder(page, "인공지능");
  await page
    .locator(".folder-list-row")
    .filter({ hasText: "인공지능" })
    .locator(".idea-summary")
    .dblclick();
  await folder(page, "강화학습");
  await page
    .locator(".folder-list-row")
    .filter({ hasText: "강화학습" })
    .locator(".idea-summary")
    .dblclick();
  for (const [index, title] of [
    "오목 AI 탐색 실험",
    "학습 진행 시각화",
    "환경 설정 메모",
  ].entries()) {
    await nav(page);
    await page
      .getByRole("button", { name: "새 아이디어", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "아이디어 제목 편집", exact: true })
      .fill(title);
    await page
      .getByRole("textbox", { name: "아이디어 본문", exact: true })
      .fill(
        [
          "탐색 깊이와 평가 함수를 비교하고 실험 결과를 정리합니다.",
          "학습 단계별 보상과 정책의 변화를 차트로 기록합니다.",
          "실행 환경과 재현에 필요한 설정을 정리합니다.",
        ][index],
      );
    await page
      .getByRole("textbox", { name: "태그 추가", exact: true })
      .fill(index ? "실험" : "AI");
    await page
      .getByRole("textbox", { name: "태그 추가", exact: true })
      .press("Enter");
    if (!index) {
      const image = await page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = 240;
        c.height = 160;
        const g = c.getContext("2d");
        g.fillStyle = "#edf3f9";
        g.fillRect(0, 0, 240, 160);
        g.strokeStyle = "#486a91";
        for (let x = 20; x < 230; x += 20) {
          g.beginPath();
          g.moveTo(x, 10);
          g.lineTo(x, 150);
          g.stroke();
        }
        for (let y = 10; y < 160; y += 20) {
          g.beginPath();
          g.moveTo(20, y);
          g.lineTo(220, y);
          g.stroke();
        }
        for (const [x, y] of [
          [100, 70],
          [120, 90],
          [140, 70],
        ]) {
          g.fillStyle = "#1f2937";
          g.beginPath();
          g.arc(x, y, 8, 0, Math.PI * 2);
          g.fill();
        }
        return c.toDataURL("image/png").split(",")[1];
      });
      await page.locator(".detail-scroll input[type=file]").setInputFiles({
        name: "오목 화면 예시.png",
        mimeType: "image/png",
        buffer: Buffer.from(image, "base64"),
      });
    }
    if (index === 2)
      await page
        .getByRole("checkbox", { name: "상세 아이디어 완료", exact: true })
        .check();
    await page
      .getByRole("button", { name: "상세 패널 닫기", exact: true })
      .click();
  }
  await page
    .getByRole("button", { name: "오른쪽 패널 열기 또는 접기", exact: true })
    .click();
  await page.screenshot({ path: `${out}/desktop-folder.png`, fullPage: true });
  const rows = page.locator(".explorer-list article");
  await rows.nth(0).locator(".idea-summary").click();
  await rows
    .nth(1)
    .locator(".idea-summary")
    .click({ modifiers: ["Control"] });
  await page.screenshot({
    path: `${out}/desktop-multiple.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "선택 해제", exact: true }).click();
  await word(page);
  await page.screenshot({ path: `${out}/desktop-word.png`, fullPage: true });
  await page
    .getByRole("button", { name: "Word 가져오기 닫기", exact: true })
    .click();
  await nav(page);
  await page
    .getByRole("button", { name: "작업 공간 설정", exact: true })
    .click();
  await page.getByRole("button", { name: "다크", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.locator("h1").click();
  await page.screenshot({ path: `${out}/desktop-dark.png`, fullPage: true });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    storageState: await context.storageState(),
    colorScheme: "light",
  });
  await guard(mobile);
  await mobile.addInitScript((origin) => {
    if (location.origin === origin)
      localStorage.setItem("ideadock:theme", "light");
  }, new URL(url).origin);
  const mp = await mobile.newPage();
  await demo(mp);
  await nav(mp);
  await mp
    .getByRole("button", { name: "인공지능 펼치기", exact: true })
    .click();
  await mp.locator(".folder-tree-name").filter({ hasText: "강화학습" }).click();
  await mp.screenshot({ path: `${out}/mobile-folder.png`, fullPage: true });
  const target = await mp
      .locator(".explorer-list .idea-summary")
      .first()
      .boundingBox(),
    cdp = await mobile.newCDPSession(mp);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: target.x + 20, y: target.y + 15 }],
  });
  await mp.waitForTimeout(650);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await mp.locator(".explorer-list .idea-summary").nth(1).tap();
  await expect(
    mp.getByRole("heading", { name: "2개 선택됨", exact: true }),
  ).toBeVisible();
  await mp.screenshot({ path: `${out}/mobile-multiple.png`, fullPage: true });
  await mp.getByRole("button", { name: "선택 해제", exact: true }).click();
  await word(mp);
  await mp.screenshot({ path: `${out}/mobile-word.png`, fullPage: true });
  expect(driveRequests).toBe(0);
  expect(pageErrors).toEqual([]);
  expect(failedResources).toEqual([]);
  const report = {
    url,
    checkedAt: new Date().toISOString(),
    realGoogleLogin: false,
    liveDriveWrites: false,
    desktop: true,
    mobileEmulation: true,
    folderNavigation: true,
    multiSelection: true,
    wordPreview: true,
    driveRequests,
    pageErrors,
    failedResources,
  };
  await writeFile(`${out}/verification.json`, JSON.stringify(report, null, 2));
  await mobile.close();
  await context.close();
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
