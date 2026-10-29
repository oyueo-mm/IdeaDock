export type IdeaLink = {
  id: string;
  type: "website" | "github";
  label: string;
  url: string;
};
export type IdeaImage = {
  id: string;
  storage_path: string;
  original_filename: string;
};
export type Idea = {
  // Optional: never normalize old documents before checking their revision hash.
  folder_id?: string | null;
  imports?: { file_hash: string; item_id: string }[];
  id: string;
  user_id: string;
  title: string;
  content: Record<string, unknown>;
  plain_text: string;
  tags: string[];
  links: IdeaLink[];
  images: IdeaImage[];
  is_completed: boolean;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  provenance?: {
    source: string;
    source_id: string;
    original_owner: string;
    fingerprint: string;
  };
};
export type Filter = "all" | "active" | "completed" | "pinned" | "trash";
export function removeImageContent(
  node: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  if (!Array.isArray(node.content)) return node;
  return {
    ...node,
    content: node.content
      .filter(
        (child: Record<string, unknown>) =>
          child.type !== "ideaImage" ||
          (child.attrs as { id?: string } | undefined)?.id !== id,
      )
      .map((child: Record<string, unknown>) => removeImageContent(child, id)),
  };
}
export function validUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
/** The first safe GitHub and website link, the ones a list row opens directly. */
export function shortcutLinks(links: IdeaLink[]) {
  const first = (type: IdeaLink["type"]) =>
    links.find((l) => l.type === type && validUrl(l.url));
  return { github: first("github"), website: first("website") };
}
export function validateImage(file: Pick<File, "type" | "size">) {
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
  )
    throw new Error("PNG, JPG, WebP, GIF 이미지만 첨부할 수 있습니다.");
  if (file.size > 5 * 1024 * 1024)
    throw new Error("이미지는 한 장당 5MB까지 첨부할 수 있습니다.");
}
export function makeIdea(title: string, user_id: string): Idea {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    user_id,
    title: title.trim(),
    content: { type: "doc", content: [{ type: "paragraph" }] },
    plain_text: "",
    tags: [],
    links: [],
    images: [],
    is_completed: false,
    is_pinned: false,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    version: 0,
  };
}
export function selectIdeas(
  ideas: Idea[],
  filter: Filter,
  tag: string,
  query: string,
  sort: string,
) {
  const q = query.toLocaleLowerCase();
  return ideas
    .filter(
      (i) =>
        (filter === "trash" ? !!i.deleted_at : !i.deleted_at) &&
        (filter !== "active" || !i.is_completed) &&
        (filter !== "completed" || i.is_completed) &&
        (filter !== "pinned" || i.is_pinned) &&
        (!tag || i.tags.includes(tag)) &&
        `${i.title} ${i.plain_text} ${i.tags.join(" ")}`
          .toLocaleLowerCase()
          .includes(q),
    )
    .sort(
      (a, b) =>
        Number(b.is_pinned) - Number(a.is_pinned) ||
        (sort === "title"
          ? a.title.localeCompare(b.title, "ko")
          : sort === "oldest"
            ? a.created_at.localeCompare(b.created_at)
            : sort === "created"
              ? b.created_at.localeCompare(a.created_at)
              : b.updated_at.localeCompare(a.updated_at)),
    );
}
