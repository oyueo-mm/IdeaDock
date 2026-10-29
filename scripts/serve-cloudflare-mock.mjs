// Local stand-in for the Cloudflare Pages trial: serves dist-cloudflare/ and
// runs the real /api/auth handler against node:sqlite (for D1) and a mock
// Google OAuth server. For tests and demos only; it holds no real credential.
// /__mock/control lets tests move the server clock, revoke grants or cut
// Google off. Usage: node scripts/serve-cloudflare-mock.mjs --port 4186
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { handleAuth } from "../server/auth/handler.ts";
import { sqliteD1 } from "../server/dev/sqlite-d1.ts";
import { createMockGoogle } from "../server/dev/mock-google.ts";
import { base64url } from "../server/auth/crypto.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4186" },
    hostname: { type: "string", default: "localhost" },
  },
});
const origin = `http://${values.hostname}:${values.port}`;
const clock = { offset: 0 };
const now = () => Date.now() + clock.offset;
const google = createMockGoogle({
  clientId: "mock-client.apps.googleusercontent.com",
  clientSecret: "mock-secret-not-a-real-credential",
  now,
  base: `${origin}/__mock/google`,
});
const { DB, raw } = sqliteD1();
const env = {
  DB,
  GOOGLE_CLIENT_ID: "mock-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "mock-secret-not-a-real-credential",
  TOKEN_ENCRYPTION_KEY: base64url(crypto.getRandomValues(new Uint8Array(32))),
  APP_ORIGIN: origin,
};
const deps = {
  google: google.endpoints,
  now,
  fetch: (input, init) => google.fetch(new Request(input, init)),
};
const root = resolve("dist-cloudflare");
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
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function send(response, reply) {
  const headers = {};
  reply.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = reply.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  response.writeHead(reply.status, headers);
  response.end(Buffer.from(await reply.arrayBuffer()));
}

async function serve(request, response) {
  try {
    const url = new URL(request.url, origin);
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith("/api/")) {
      const data = await body(request);
      return send(
        response,
        await handleAuth(
          new Request(url, {
            method: request.method,
            headers: Object.entries(request.headers).flatMap(([k, v]) =>
              Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : [],
            ),
            body: ["GET", "HEAD"].includes(request.method) ? undefined : data,
          }),
          env,
          deps,
        ),
      );
    }
    if (path.startsWith("/__mock/google/"))
      return send(response, await google.fetch(new Request(url)));
    if (path === "/__mock/control" && request.method === "POST") {
      const input = JSON.parse((await body(request)).toString() || "{}");
      if (typeof input.advance === "number") clock.offset += input.advance;
      if (typeof input.revoke === "string") google.revoke(input.revoke);
      if (typeof input.outage === "boolean") google.state.outage = input.outage;
      if (typeof input.nextUser === "string")
        google.state.nextUser = input.nextUser;
      if (typeof input.deny === "boolean") google.state.deny = input.deny;
      const sessions = raw
        .prepare("SELECT sub, COUNT(*) AS n FROM sessions GROUP BY sub")
        .all();
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(
        JSON.stringify({
          ...google.state,
          sessions: Object.fromEntries(sessions.map((r) => [r.sub, r.n])),
          ...(typeof input.accepts === "string"
            ? { accepts: google.accepts(input.accepts) }
            : {}),
        }),
      );
    }
    if (path === "/" || path === "/IdeaDock") {
      response.writeHead(302, { Location: "/IdeaDock/" });
      return response.end();
    }
    let file = resolve(root, path.slice(1) || ".");
    const location = relative(root, file);
    if (location.startsWith("..") || isAbsolute(location)) {
      response.writeHead(403);
      return response.end();
    }
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const content = await readFile(file);
    response.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}
createServer(serve).listen(Number(values.port), values.hostname, () =>
  console.log(`Mock Cloudflare IdeaDock: ${origin}/IdeaDock/`),
);
// The same server on 127.0.0.1 is a different site: tests use it as the
// attacker page for cross-site request checks.
if (values.hostname === "localhost")
  createServer(serve)
    .on("error", () => {}) // localhost may already be 127.0.0.1
    .listen(Number(values.port), "127.0.0.1");
