import { expect, type BrowserContext } from "@playwright/test";
import { createHash } from "node:crypto";
type Stored = {
  id: string;
  appProperties: { key?: string; kind?: string; ideadockRoot?: string };
  name?: string;
  parents?: string[];
  mimeType: string;
  bytes: Buffer;
};
export type DriveStats = {
  list: number;
  media: number;
  upload: number;
  other: number;
  mediaKeys: string[];
};
const emptyStats = (): DriveStats => ({
  list: 0,
  media: 0,
  upload: 0,
  other: 0,
  mediaKeys: [],
});
/**
 * pageSize 1 (default) exercises multi-page listing; benchmarks pass Drive's
 * real limit of 1000 and a per-request latency to resemble the live API.
 */
export function mockDrive(
  options: { pageSize?: number; latency?: number } = {},
) {
  const pageSize = options.pageSize ?? 1;
  let stats = emptyStats();
  const failMedia = new Map<string, number>();
  let slow = 0;
  const files = new Map<string, Stored>();
  const uploads = new Map<string, Omit<Stored, "bytes">>();
  let allocation = 0,
    revisions = 0;
  let loseSecondRevision = false;
  let rejectWrites = false;
  let expired = false;
  return {
    files,
    /** Returns the counters since the last call and resets them. */
    takeStats: () => {
      const taken = stats;
      stats = emptyStats();
      return taken;
    },
    /** The next `times` downloads of each key answer 503, then succeed. */
    failMedia: (keys: string[], times = 1) => {
      for (const key of keys) failMedia.set(key, times);
    },
    /** Extra latency for every Drive request, e.g. a slow network. */
    setSlow: (ms: number) => {
      slow = ms;
    },
    expireToken: (value: boolean) => {
      expired = value;
    },
    rejectWrites: (value: boolean) => {
      rejectWrites = value;
    },
    failSecond: () => {
      loseSecondRevision = true;
    },
    attach: async (context: BrowserContext) => {
      await context.route("https://accounts.google.com/gsi/client", (route) =>
        route.fulfill({
          contentType: "application/javascript",
          body: `window.google={accounts:{oauth2:{initTokenClient(options){if(!options.scope.includes("drive.file") || options.scope.includes("drive.appdata")) throw new Error("Unexpected Drive scope"); return {requestAccessToken(request){(window.__gisRequests ||= []).push({prompt:request.prompt,login_hint:options.login_hint ?? null});options.callback({access_token:"test-only",expires_in:3600,scope:options.scope});}}}}}};`,
        }),
      );
      await context.route(
        "https://openidconnect.googleapis.com/v1/userinfo",
        (route) =>
          route.fulfill({
            json: { sub: "alice", email: "alice@example.com", name: "Alice" },
          }),
      );
      await context.route("https://www.googleapis.com/**", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (request.method() === "OPTIONS")
          return route.fulfill({
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "*",
              "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
            },
          });
        const headers = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "Location",
        };
        if (expired) return route.fulfill({ headers, status: 401 });
        const delay = (options.latency ?? 0) + slow;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (url.searchParams.get("alt") === "media") {
          stats.media++;
          const key = files.get(url.pathname.split("/").at(-1)!)?.appProperties
            .key;
          if (key) stats.mediaKeys.push(key);
          const left = key ? (failMedia.get(key) ?? 0) : 0;
          if (key && left > 0) {
            failMedia.set(key, left - 1);
            return route.fulfill({ headers, status: 503 });
          }
        } else if (url.pathname.startsWith("/upload/")) stats.upload++;
        else if (
          url.pathname === "/drive/v3/files" &&
          request.method() === "GET"
        )
          stats.list++;
        else stats.other++;
        if (url.pathname.endsWith("generateIds")) {
          expect(url.searchParams.get("space")).toBe("drive");
          return route.fulfill({
            headers,
            json: { ids: [`file-${++allocation}`] },
          });
        }
        if (url.pathname === "/drive/v3/files" && request.method() === "POST") {
          const folder = request.postDataJSON() as Omit<Stored, "bytes">;
          expect(folder.mimeType).toBe("application/vnd.google-apps.folder");
          expect(folder.name).toBe("IdeaDock");
          if (files.has(folder.id))
            return route.fulfill({ headers, status: 409 });
          files.set(folder.id, { ...folder, bytes: Buffer.alloc(0) });
          return route.fulfill({ headers, json: { id: folder.id } });
        }
        if (
          url.pathname.startsWith("/upload/") &&
          request.method() === "POST"
        ) {
          const metadata = request.postDataJSON() as Omit<Stored, "bytes">;
          if (rejectWrites)
            return route.fulfill({
              headers,
              status: 503,
              body: "test write failure",
            });
          if (files.has(metadata.id))
            return route.fulfill({ headers, status: 409, body: "exists" });
          uploads.set(metadata.id, metadata);
          return route.fulfill({
            headers: {
              ...headers,
              Location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${metadata.id}`,
            },
            status: 200,
            body: "",
          });
        }
        if (url.pathname.startsWith("/upload/") && request.method() === "PUT") {
          const id = url.searchParams.get("upload_id")!,
            metadata = uploads.get(id)!;
          const bytes = request.postDataBuffer()!;
          expect(
            metadata.parents?.every(
              (id) => files.get(id)?.appProperties.ideadockRoot === "v1",
            ),
          ).toBe(true);
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(
            metadata.appProperties.key,
          );
          files.set(id, { ...metadata, bytes });
          if (
            metadata.appProperties.kind === "revision" &&
            ++revisions === 2 &&
            loseSecondRevision
          ) {
            loseSecondRevision = false;
            return route.abort("failed"); // committed, but the client lost the response
          }
          return route.fulfill({ headers, json: { id } });
        }
        if (url.searchParams.get("alt") === "media") {
          const file = files.get(url.pathname.split("/").at(-1)!);
          return file
            ? route.fulfill({
                headers,
                contentType: file.mimeType,
                body: file.bytes,
              })
            : route.fulfill({ headers, status: 404 });
        }
        const query = url.searchParams.get("q") || "";
        const kind = query.match(/value='([^']+)'/)?.[1];
        const parentIds = [...query.matchAll(/'([^']+)' in parents/g)].map(
          (m) => m[1],
        );
        const rows = [...files.values()].filter((f) =>
          query.includes("ideadockRoot")
            ? f.appProperties.ideadockRoot === "v1"
            : f.appProperties.kind === kind &&
              !!f.parents?.some((id) => parentIds.includes(id)),
        );
        const index = Number(url.searchParams.get("pageToken") || 0);
        return route.fulfill({
          headers,
          json: {
            files: rows
              .slice(index, index + pageSize)
              .map(({ id, appProperties }) => ({ id, appProperties })),
            ...(index + pageSize < rows.length
              ? { nextPageToken: String(index + pageSize) }
              : {}),
          },
        });
      });
    },
  };
}
