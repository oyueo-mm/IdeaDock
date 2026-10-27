import { describe, expect, it } from "vitest";
import config from "../next.config";
import { verifyStaticHtml } from "../scripts/verify-static.mjs";

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
});
