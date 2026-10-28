import { createHash, randomUUID } from "node:crypto";
import { canonical } from "../../src/lib/integrity";
import { makeIdea, type Idea } from "../../src/lib/model";
import { makeFolder } from "../../src/lib/folders";
import type { mockDrive } from "./mock-drive";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// A distinct, valid 1×1 PNG per index (the colour byte changes the hash).
function png(index: number) {
  const base = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  return Buffer.concat([base, Buffer.from(`ideadock-${index}`)]);
}

/**
 * Seeds the mock Drive the way a heavy Word import leaves it: many ideas, each
 * with a chain of immutable revisions, a few folders and shared images.
 */
export function seedDrive(
  api: ReturnType<typeof mockDrive>,
  options: {
    ideas: number;
    revisions: number;
    folders: number;
    images: number;
    account?: string;
    /** Leave ideas in the root instead of spreading them over the folders. */
    root?: boolean;
  },
) {
  const account = options.account ?? "google:alice";
  const root = randomUUID();
  api.files.set(root, {
    id: root,
    name: "IdeaDock",
    mimeType: "application/vnd.google-apps.folder",
    appProperties: { ideadockRoot: "v1" },
    bytes: Buffer.alloc(0),
  });
  const put = (kind: string, bytes: Buffer, mimeType: string) => {
    const key = sha(bytes),
      id = randomUUID();
    api.files.set(id, {
      id,
      name: `ideadock-${kind}-${key}`,
      parents: [root],
      mimeType,
      appProperties: { key, kind },
      bytes,
    });
    return key;
  };
  const images = Array.from({ length: options.images }, (_, n) =>
    put("image", png(n), "image/png"),
  );
  const folders = Array.from({ length: options.folders }, (_, n) =>
    makeFolder(`폴더 ${n + 1}`, account, null),
  );
  for (const folder of folders)
    put(
      "folder-revision",
      Buffer.from(canonical({ schema: 1, parent: null, folder })),
      "application/json",
    );
  const ideas: Idea[] = [];
  const start = Date.UTC(2026, 0, 1);
  for (let n = 0; n < options.ideas; n++) {
    let idea: Idea = {
      ...makeIdea(`가져온 아이디어 ${String(n + 1).padStart(3, "0")}`, account),
      created_at: new Date(start + n * 60000).toISOString(),
      updated_at: new Date(start + n * 60000).toISOString(),
      folder_id:
        folders.length && !options.root ? folders[n % folders.length].id : null,
      plain_text: `Word 문서에서 가져온 본문 ${n + 1}. `.repeat(8),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: `Word 문서에서 가져온 본문 ${n + 1}.` },
            ],
          },
        ],
      },
      images: images.length
        ? [
            {
              id: randomUUID(),
              storage_path: `drive-sha:${images[n % images.length]}`,
              original_filename: `image-${n % images.length}.png`,
            },
          ]
        : [],
    };
    let parent: string | null = null;
    for (let r = 0; r < options.revisions; r++) {
      idea = { ...idea, version: r + 1 };
      parent = put(
        "revision",
        Buffer.from(canonical({ schema: 1, parent, idea })),
        "application/json",
      );
    }
    ideas.push(idea);
  }
  return { root, ideas, folders, images };
}
