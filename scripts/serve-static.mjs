import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname, join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4173" },
    hostname: { type: "string", default: "127.0.0.1" },
  },
});
const root = resolve("out");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    if (path === "/IdeaDock") {
      response.writeHead(308, { Location: "/IdeaDock/" });
      response.end();
      return;
    }
    if (!path.startsWith("/IdeaDock/")) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    let file = resolve(root, path.slice("/IdeaDock/".length) || ".");
    const location = relative(root, file);
    if (location.startsWith("..") || isAbsolute(location)) {
      response.writeHead(403);
      response.end();
      return;
    }
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(Number(values.port), values.hostname, () =>
  console.log(
    `Static IdeaDock: http://${values.hostname}:${values.port}/IdeaDock/`,
  ),
);
