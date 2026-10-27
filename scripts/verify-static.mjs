import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {string} html
 * @param {(path: string) => boolean} hasFile
 */
export function verifyStaticHtml(html, hasFile) {
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((url) => url.startsWith("/") && url.includes("_next/"));
  if (!assets.length) throw new Error("No exported Next.js assets found.");
  for (const url of assets) {
    if (!url.startsWith("/IdeaDock/_next/"))
      throw new Error("Static asset escapes the /IdeaDock base path.");
    const path = decodeURIComponent(
      url.slice("/IdeaDock/".length).split("?")[0],
    );
    if (path.split("/").includes("..") || !hasFile(path))
      throw new Error("Exported asset is missing.");
  }
  return assets.length;
}

export function verifyStaticExport(directory = "out") {
  const root = resolve(directory);
  const html = readFileSync(join(root, "index.html"), "utf8");
  const assets = verifyStaticHtml(html, (path) => existsSync(join(root, path)));
  if (!existsSync(join(root, ".nojekyll")))
    throw new Error("Missing .nojekyll marker.");
  const files = readdirSync(root, { recursive: true }).map(String);
  if (
    files.some((path) =>
      /(?:^|[/\\])(?:\.env[^/\\]*|\.git|\.local|\.vercel)(?:$|[/\\])/.test(
        path,
      ),
    )
  )
    throw new Error("Private files found in export.");
  if (process.env.IDEADOCK_PAGES_RELEASE === "1") {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
    if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId))
      throw new Error(
        "Configure the NEXT_PUBLIC_GOOGLE_CLIENT_ID Actions variable before publishing.",
      );
    const scripts = files
      .filter((path) => path.endsWith(".js"))
      .map((path) => readFileSync(join(root, path), "utf8"));
    if (
      !scripts.some((source) => source.includes(clientId)) ||
      scripts.some((source) =>
        source.includes("test-client-not-a-real-credential"),
      )
    )
      throw new Error(
        "Release export contains missing or mock OAuth configuration.",
      );
  }
  return { assets, files: files.length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  console.log("Static export verified:", verifyStaticExport());
}
