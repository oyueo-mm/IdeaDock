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
export function mockDrive() {
  const files = new Map<string, Stored>();
  const uploads = new Map<string, Omit<Stored, "bytes">>();
  let allocation = 0,
    revisions = 0;
  let loseSecondRevision = false;
  let rejectWrites = false;
  return {
    files,
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
          body: `window.google={accounts:{oauth2:{initTokenClient(options){if(!options.scope.includes("drive.file") || options.scope.includes("drive.appdata")) throw new Error("Unexpected Drive scope"); return {requestAccessToken(){options.callback({access_token:"test-only",expires_in:3600,scope:options.scope});}}}}}};`,
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
        // Deliberately paginate at one file to exercise multi-page listing.
        const index = Number(url.searchParams.get("pageToken") || 0);
        return route.fulfill({
          headers,
          json: {
            files: rows
              .slice(index, index + 1)
              .map(({ id, appProperties }) => ({ id, appProperties })),
            ...(index + 1 < rows.length
              ? { nextPageToken: String(index + 1) }
              : {}),
          },
        });
      });
    },
  };
}
