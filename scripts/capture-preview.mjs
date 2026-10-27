import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const now = new Date().toISOString();
const titles = [
  "푸리에 급수 시각화",
  "내가 읽은 책을 기록하는 작은 서재",
  "이미지 ASCII 변환기",
  "강화학습 레이싱",
  "산책하며 발견한 장소 지도",
  "매일 한 문장, 영어 기록",
];
const tags = [
  ["시각화", "수학"],
  ["일상", "웹서비스"],
  ["유틸리티"],
  ["강화학습", "게임"],
  ["일상"],
  ["학습"],
];
const rows = titles.map((title, n) => ({
  id: crypto.randomUUID(),
  user_id: "demo",
  title,
  content: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text:
              n === 0
                ? "복잡해 보이는 파형도 단순한 파동의 합으로 이해할 수 있지 않을까? 직접 슬라이더를 움직이며 푸리에 급수를 관찰하는 작은 실험실."
                : "떠오른 생각을 기록하고 조금씩 구체화해 보기.",
          },
        ],
      },
      ...(n === 0
        ? [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "만들고 싶은 경험" }],
            },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "주파수와 진폭을 조절하며 파형 살펴보기",
                        },
                      ],
                    },
                  ],
                },
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "여러 파형이 합쳐지는 과정을 애니메이션으로",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ]
        : []),
    ],
  },
  plain_text: [
    "슬라이더로 파형을 겹치며 푸리에 급수를 직관적으로 이해하기.",
    "읽고 싶은 책부터 인상 깊었던 문장까지, 한곳에 차분히.",
    "좋아하는 사진을 텍스트 아트로 바꾸는 간단한 도구.",
    "작은 자동차가 스스로 코스를 배우는 과정을 관찰하기.",
    "좋았던 카페와 조용한 골목을 나만의 지도로 남기기.",
    "부담 없이 한 문장씩. 꾸준히 쌓이는 나의 영어 노트.",
  ][n],
  tags: tags[n],
  links:
    n === 0
      ? [
          {
            id: crypto.randomUUID(),
            type: "website",
            label: "FourierLab · 웹사이트",
            url: "https://oyueo-mm.github.io/FourierLab/",
          },
          {
            id: crypto.randomUUID(),
            type: "github",
            label: "GitHub 저장소",
            url: "https://github.com/oyueo-mm/FourierLab",
          },
        ]
      : [],
  images: [],
  is_completed: n === 0 || n === 3,
  is_pinned: n === 0 || n === 1,
  created_at: now,
  updated_at: new Date(Date.now() - n * 86400000).toISOString(),
  deleted_at: null,
  version: 0,
}));
await mkdir("docs/screenshots", { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(
    (cache) => {
      localStorage.setItem("ideadock:data:demo", JSON.stringify(cache));
      localStorage.setItem("ideadock:theme", "light");
    },
    { ideas: rows, pending: {} },
  );
  const page = await context.newPage();
  await page.goto(process.env.PREVIEW_URL || "http://127.0.0.1:3000");
  await page.getByRole("button", { name: "체험 모드 열기" }).click();
  await page.locator(".idea-summary").filter({ hasText: titles[0] }).click();
  await page.getByRole("textbox", { name: "아이디어 본문" }).waitFor();
  await page.screenshot({
    path: "docs/screenshots/desktop-light.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "작업 공간 설정", exact: true })
    .click();
  await page.getByRole("button", { name: "다크", exact: true }).click();
  await page.getByRole("button", { name: "설정 닫기" }).click();
  await page.screenshot({
    path: "docs/screenshots/desktop-dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/screenshots/mobile-detail.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "목록으로 돌아가기" }).click();
  await page.screenshot({
    path: "docs/screenshots/mobile-list.png",
    fullPage: true,
  });
  await context.close();
  console.log(
    "Saved four actual browser previews in docs/screenshots. Preview data is test-only.",
  );
} finally {
  await browser.close();
}
