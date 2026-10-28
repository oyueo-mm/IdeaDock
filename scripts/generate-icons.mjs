// Renders the IdeaDock app icons into public/icons. Run after changing the glyph:
//   node scripts/generate-icons.mjs
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const primary = "#486a91";
// An idea (spark) resting on a dock (tray), drawn on a 512 grid.
const glyph = `<path d="M256 104Q268 190 352 202Q268 214 256 300Q244 214 160 202Q244 190 256 104Z" fill="#fff"/>
<rect x="140" y="340" width="232" height="40" rx="20" fill="#fff"/>`;
const svg = (maskable) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
  (maskable
    ? `<rect width="512" height="512" fill="${primary}"/>` +
      // Keep the glyph inside the 80% maskable safe zone with extra margin.
      `<g transform="translate(256 256) scale(0.8) translate(-256 -256)">${glyph}</g>`
    : `<rect width="512" height="512" rx="112" fill="${primary}"/>${glyph}`) +
  `</svg>`;

const outputs = [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, true],
];

await mkdir("public/icons", { recursive: true });
await writeFile("public/icons/icon.svg", svg(false) + "\n");
const browser = await chromium.launch();
try {
  for (const [name, size, maskable] of outputs) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
    });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg(maskable)}`,
    );
    await page.screenshot({
      path: `public/icons/${name}`,
      omitBackground: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log("Generated", outputs.map(([name]) => name).join(", "));
