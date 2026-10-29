import { makeIdea, type Idea } from "../../src/lib/model";

export const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const words =
  "아이디어 기록 정리 프로젝트 검토 구현 테스트 배포 설계 메모".split(" ");
/** Deterministic Korean-looking text of about `size` characters. */
function text(seed: number, size: number) {
  let out = "";
  for (let i = seed; out.length < size; i += 3)
    out += `${words[i % words.length]} ${words[(i * 7 + 1) % words.length]} `;
  return out.trim();
}
export function paragraphs(body: string) {
  return {
    type: "doc",
    content: body.split("\n").map((line) => ({
      type: "paragraph",
      content: [{ type: "text", text: line }],
    })),
  };
}
export type FixtureOptions = {
  ideas: number;
  /** Put one picture (a data URL, as an old export has) in the first idea. */
  image?: boolean;
  /** Characters of body text per idea; ~1,750 gives a 27-idea file of ~250 KB. */
  size?: number;
  owner?: string;
};
export function fixtureIdeas(options: FixtureOptions): Idea[] {
  const owner = options.owner ?? "local-user";
  const base = Date.UTC(2026, 2, 1);
  return Array.from({ length: options.ideas }, (_, n) => {
    const body = Array.from({ length: 6 }, (_, p) =>
      text(n * 11 + p, Math.round((options.size ?? 1750) / 6)),
    ).join("\n");
    const image = options.image && n === 0;
    const picture = {
      id: "picture-1",
      storage_path: pixel,
      original_filename: "스케치.png",
    };
    const content = paragraphs(body);
    if (image)
      (content.content as unknown[]).push({
        type: "ideaImage",
        attrs: picture,
      });
    return {
      ...makeIdea(`JSON 아이디어 ${String(n + 1).padStart(2, "0")}`, owner),
      content,
      plain_text: body.replace(/\n/g, " "),
      tags: n % 3 === 0 ? ["가져옴"] : [],
      images: image ? [picture] : [],
      is_completed: n % 4 === 0,
      created_at: new Date(base + n * 3600_000).toISOString(),
      updated_at: new Date(base + n * 3600_000).toISOString(),
    } satisfies Idea;
  });
}
export const jsonText = (ideas: Idea[]) => JSON.stringify({ ideas });

/** Copies of ideas that exist in Drive, as a second import of the same notes. */
export function duplicatesOf(
  existing: Idea[],
  owner = "local-user",
  change: (idea: Idea, index: number) => Partial<Idea> = () => ({}),
): Idea[] {
  return existing.map((idea, index) => ({
    ...idea,
    id: crypto.randomUUID(),
    user_id: owner,
    folder_id: null,
    provenance: undefined,
    imports: undefined,
    version: 0,
    ...change(idea, index),
  }));
}
