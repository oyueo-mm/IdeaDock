// Builds the mock-Drive static site and runs the load benchmark.
// Usage: BENCH_LABEL=before npm run bench
import { spawnSync } from "node:child_process";
const env = {
  ...process.env,
  NEXT_PUBLIC_GOOGLE_CLIENT_ID: "test-client-not-a-real-credential",
  NEXT_PUBLIC_STORAGE_BACKEND: "drive",
  NEXT_PUBLIC_GOOGLE_DRIVE_SPACE: "drive",
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
};
const run = (args) =>
  spawnSync(process.execPath, args, { stdio: "inherit", env }).status ?? 1;
const built = run(["node_modules/next/dist/bin/next", "build"]);
if (built) process.exit(built);
process.exit(
  run([
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "playwright.perf.config.ts",
    ...process.argv.slice(2),
  ]),
);
