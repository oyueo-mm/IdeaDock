// Builds the Cloudflare Pages trial bundle in dist-cloudflare/:
//   dist-cloudflare/IdeaDock/...  the static app in server sign-in mode
//   dist-cloudflare/_routes.json  only /api/* runs Pages Functions
// The GitHub Pages export in out/ is moved away, so it can never be published
// from this build by mistake; `npm run build` recreates it.
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";

const env = {
  ...process.env,
  NEXT_PUBLIC_AUTH_MODE: "server",
  NEXT_PUBLIC_STORAGE_BACKEND: "drive",
  NEXT_PUBLIC_GOOGLE_DRIVE_SPACE: "drive",
};
for (const args of [
  ["node_modules/next/dist/bin/next", "build"],
  ["scripts/verify-static.mjs"],
]) {
  const run = spawnSync(process.execPath, args, { stdio: "inherit", env });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
rmSync("dist-cloudflare", { recursive: true, force: true });
mkdirSync("dist-cloudflare");
renameSync("out", "dist-cloudflare/IdeaDock");
writeFileSync(
  "dist-cloudflare/_routes.json",
  JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }, null, 2),
);
writeFileSync(
  "dist-cloudflare/_redirects",
  "/ /IdeaDock/ 302\n/IdeaDock /IdeaDock/ 308\n",
);
writeFileSync(
  "dist-cloudflare/_headers",
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/IdeaDock/_next/static/*
  Cache-Control: public, max-age=31536000, immutable
`,
);
console.log("Cloudflare Pages bundle: dist-cloudflare/");
