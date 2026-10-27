import { describe, expect, it } from "vitest";
import { assertPreviewTarget } from "../scripts/preview-guard.mjs";

describe("Preview deployment boundary", () => {
  it("allows local production compilation and explicit Vercel Preview", () => {
    expect(() => assertPreviewTarget({ NODE_ENV: "production" })).not.toThrow();
    expect(() =>
      assertPreviewTarget({ VERCEL: "1", VERCEL_ENV: "preview" }),
    ).not.toThrow();
  });
  it("rejects production and unknown Vercel targets before Next builds", () => {
    expect(() => assertPreviewTarget({ VERCEL_ENV: "production" })).toThrow(
      "Only Vercel Preview",
    );
    expect(() => assertPreviewTarget({ VERCEL: "1" })).toThrow(
      "Only Vercel Preview",
    );
  });
});
