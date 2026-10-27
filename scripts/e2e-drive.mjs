import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "tests/e2e/drive-migration.spec.ts",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: { ...process.env, IDEADOCK_E2E_DRIVE: "1" },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
