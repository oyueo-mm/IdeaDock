import { expect, test } from "@playwright/test";

test("is an installable PWA scoped to /IdeaDock/ without a service worker", async ({
  page,
}) => {
  await page.goto("./");
  await expect(
    page.getByText("Google Drive에 연결하여 아이디어를 동기화하세요.", {
      exact: true,
    }),
  ).toBeVisible();
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/IdeaDock/manifest.webmanifest");

  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("manifest+json");
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: "/IdeaDock/",
    start_url: "/IdeaDock/",
    scope: "/IdeaDock/",
    display: "standalone",
    name: "IdeaDock",
  });
  for (const icon of manifest.icons as { src: string; sizes: string }[]) {
    const png = await page.request.get(icon.src);
    expect(png.status(), icon.src).toBe(200);
    const body = await png.body();
    // PNG IHDR width/height must match the declared size.
    expect(`${body.readUInt32BE(16)}x${body.readUInt32BE(20)}`).toBe(
      icon.sizes,
    );
  }

  // Chrome's own installability verdict for the parsed manifest.
  const cdp = await page.context().newCDPSession(page);
  const parsed = await cdp.send("Page.getAppManifest", {});
  expect(parsed.errors).toEqual([]);
  const origin = new URL(page.url()).origin;
  expect(parsed.manifest).toMatchObject({
    id: `${origin}/IdeaDock/`,
    startUrl: `${origin}/IdeaDock/`,
    scope: `${origin}/IdeaDock/`,
    display: "kStandalone",
  });
  const { installabilityErrors } = await cdp.send(
    "Page.getInstallabilityErrors",
  );
  expect(installabilityErrors).toEqual([]);

  // No service worker: nothing can pin an old build or intercept OAuth.
  expect(
    await page.evaluate(
      async () =>
        (await navigator.serviceWorker?.getRegistrations())?.length ?? 0,
    ),
  ).toBe(0);
});
