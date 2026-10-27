import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const paths = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const findings = [];
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  ],
  ["Supabase secret", /\bsb_secret_[A-Za-z0-9_-]{16,}\b/],
  ["Supabase publishable value", /\bsb_publishable_[A-Za-z0-9_-]{16,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  [
    "JWT value",
    /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/,
  ],
  ["credential in URL", /https?:\/\/[^\s/@:'"`]+:[^\s/@'"`]+@/],
  [
    "hardcoded credential",
    /(?:password|client_secret|api_secret|access_token)\s*[:=]\s*["'][A-Za-z0-9+_\/-]{16,}["']/i,
  ],
];
for (const path of paths) {
  if (
    (/(^|\/)\.env(?:\.|$)/.test(path) && path !== ".env.example") ||
    /(^|\/)(?:\.vercel|\.aws|\.ssh|node_modules|\.next)\//.test(path) ||
    /\.(?:pem|p12|pfx|key)$/.test(path)
  )
    findings.push({ path, reason: "excluded or credential file" });
  if (!existsSync(path)) continue;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const source = bytes.toString("utf8");
  // Exact, intentionally rejected example from URL-validation tests; never a live credential.
  const scanned =
    path === "tests/model.test.ts"
      ? source.replaceAll(
          "https://name:" + "password@example.com",
          "https://example.com",
        )
      : source;
  for (const [reason, pattern] of patterns)
    if (pattern.test(scanned)) findings.push({ path, reason });
  if (
    path === ".env.example" &&
    source
      .split(/\r?\n/)
      .some((line) => /^\s*[A-Z][A-Z0-9_]*\s*=\s*\S/.test(line))
  )
    findings.push({ path, reason: "environment example contains a value" });
}
if (findings.length) {
  console.error("FAIL: possible sensitive data (values hidden)");
  for (const finding of findings)
    console.error(`${finding.path}: ${finding.reason}`);
  process.exit(1);
}
console.log(
  `PASS: ${paths.length} Git candidate files scanned. No matching credentials or excluded files found. Pattern scanning is not a guarantee.`,
);
const example = readFileSync(".env.example", "utf8");
for (const name of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
]) {
  for (const path of [
    "src/lib/supabase.ts",
    "scripts/security-test.mjs",
    "docs/SETUP.md",
  ])
    if (!readFileSync(path, "utf8").includes(name) || !example.includes(name))
      throw new Error(`Configuration mismatch: ${name} in ${path}`);
}
console.log(
  "PASS: public environment names agree across app, API tests, example and setup documentation.",
);
if (!existsSync(".env.local")) {
  console.log(
    "NOT CONFIGURED: .env.local does not exist. No cloud connection tested.",
  );
  process.exit(0);
}
process.loadEnvFile(".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
  key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.log("NOT CONFIGURED: Supabase URL or public key is empty.");
  process.exit(0);
}
const project = new URL(url);
if (
  project.protocol !== "https:" ||
  !/^([a-z0-9]{20})\.supabase\.co$/.test(project.hostname)
)
  throw new Error(
    "Use the HTTPS URL of the dedicated hosted IdeaDock project.",
  );
let type = key.startsWith("sb_publishable_")
  ? "publishable"
  : key.startsWith("sb_secret_")
    ? "secret"
    : "unknown";
if (type === "unknown") {
  try {
    type = JSON.parse(
      Buffer.from(key.split(".")[1], "base64url").toString(),
    ).role;
  } catch {}
}
if (!["publishable", "anon"].includes(type))
  throw new Error(
    "Only a publishable or legacy anon key is allowed in browser configuration. Value hidden.",
  );
console.log(
  `LOCAL CONFIG ONLY: project ref ${project.hostname.split(".")[0]}, key type ${type}. Ownership and API access have not been verified.`,
);
