import { describe, expect, it } from "vitest";
import config from "../next.config";
import manifest from "../src/app/manifest";
import { verifyManifest, verifyStaticHtml } from "../scripts/verify-static.mjs";

describe("GitHub Pages deployment boundary", () => {
  it("exports under the repository path without server-only configuration", () => {
    expect(config).toMatchObject({
      output: "export",
      basePath: "/IdeaDock",
      trailingSlash: true,
      images: { unoptimized: true },
    });
    expect(config).not.toHaveProperty("headers");
    expect(
      verifyStaticHtml(
        '<script src="/IdeaDock/_next/static/app.js"></script>',
        (path) => path === "_next/static/app.js",
      ),
    ).toBe(1);
  });
  it("rejects root-relative or missing export assets", () => {
    expect(() =>
      verifyStaticHtml(
        '<script src="/_next/static/app.js"></script>',
        () => true,
      ),
    ).toThrow("base path");
    expect(() =>
      verifyStaticHtml(
        '<script src="/IdeaDock/_next/static/missing.js"></script>',
        () => false,
      ),
    ).toThrow("missing");
  });
  it("keeps the PWA identity inside /IdeaDock/ apart from sibling apps", () => {
    const link = '<link rel="manifest" href="/IdeaDock/manifest.webmanifest"/>';
    const source = JSON.stringify(manifest());
    expect(verifyManifest(link, source, () => true)).toBe(3);
    expect(() => verifyManifest(link, source, () => false)).toThrow("missing");
    expect(() => verifyManifest("<html></html>", source, () => true)).toThrow(
      "manifest",
    );
    for (const key of ["id", "start_url", "scope"])
      for (const value of ["/", "/TransitLog/", "/IdeaDock/IdeaDock/"])
        expect(() =>
          verifyManifest(
            link,
            JSON.stringify({ ...manifest(), [key]: value }),
            () => true,
          ),
        ).toThrow(key);
  });
});
