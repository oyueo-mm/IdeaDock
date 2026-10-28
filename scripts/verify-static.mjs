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

/**
 * Keeps the PWA identity inside /IdeaDock/ so it never claims the shared
 * oyueo-mm.github.io origin or collides with sibling apps such as /TransitLog/.
 * @param {string} html
 * @param {string} source
 * @param {(path: string) => boolean} hasFile
 */
export function verifyManifest(html, source, hasFile) {
  if (
    !html.includes('<link rel="manifest" href="/IdeaDock/manifest.webmanifest"')
  )
    throw new Error("Page does not link the /IdeaDock/ manifest.");
  const manifest = JSON.parse(source);
  for (const key of ["id", "start_url", "scope"])
    if (manifest[key] !== "/IdeaDock/")
      throw new Error(`Manifest ${key} must be /IdeaDock/.`);
  if (manifest.display !== "standalone" || !manifest.name)
    throw new Error("Manifest is not installable.");
  const icons = manifest.icons ?? [];
  for (const [sizes, purpose] of [
    ["192x192", "any"],
    ["512x512", "any"],
    ["512x512", "maskable"],
  ])
    if (!icons.some((icon) => icon.sizes === sizes && icon.purpose === purpose))
      throw new Error(`Manifest lacks a ${sizes} ${purpose} icon.`);
  for (const { src } of icons) {
    if (!src.startsWith("/IdeaDock/icons/"))
      throw new Error("Manifest icon escapes the /IdeaDock base path.");
    if (!hasFile(src.slice("/IdeaDock/".length)))
      throw new Error("Manifest icon is missing.");
  }
  return icons.length;
}

export function verifyStaticExport(directory = "out") {
  const root = resolve(directory);
  const html = readFileSync(join(root, "index.html"), "utf8");
  const hasFile = (/** @type {string} */ path) => existsSync(join(root, path));
  const assets = verifyStaticHtml(html, hasFile);
  const icons = verifyManifest(
    html,
    readFileSync(join(root, "manifest.webmanifest"), "utf8"),
    hasFile,
  );
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
  return { assets, icons, files: files.length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  console.log("Static export verified:", verifyStaticExport());
}
