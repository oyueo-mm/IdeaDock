import { Idea, validUrl } from "./model";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function digest(value: Blob | string): Promise<string> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : await value.arrayBuffer();
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function imageNodes(
  node: Record<string, unknown>,
): Record<string, unknown>[] {
  return [
    ...(node.type === "ideaImage" ? [node] : []),
    ...(Array.isArray(node.content)
      ? node.content.flatMap((child) => imageNodes(child))
      : []),
  ];
}
export function validateIdeas(input: unknown): asserts input is Idea[] {
  if (!Array.isArray(input)) throw new Error("아이디어 배열이 없습니다.");
  const ids = new Set<string>();
  const fail = (id: unknown, field: string): never => {
    throw new Error(`무결성 오류: ${String(id)} · ${field}`);
  };
  for (const row of input) {
    if (!row || typeof row !== "object") fail("?", "레코드");
    const i = row as Idea;
    if (typeof i.id !== "string" || !i.id || ids.has(i.id))
      fail(i.id, "중복 또는 잘못된 ID");
    ids.add(i.id);
    if (
      i.imports !== undefined &&
      (!Array.isArray(i.imports) ||
        i.imports.some(
          (r) =>
            !r ||
            typeof r.file_hash !== "string" ||
            typeof r.item_id !== "string",
        ))
    )
      fail(i.id, "imports");
    if (
      i.folder_id !== undefined &&
      i.folder_id !== null &&
      (typeof i.folder_id !== "string" || !i.folder_id)
    )
      fail(i.id, "folder_id");
    for (const key of ["title", "plain_text", "user_id"] as const)
      if (typeof i[key] !== "string") fail(i.id, key);
    for (const key of ["is_completed", "is_pinned"] as const)
      if (typeof i[key] !== "boolean") fail(i.id, key);
    for (const key of ["created_at", "updated_at"] as const)
      if (typeof i[key] !== "string" || !Number.isFinite(Date.parse(i[key])))
        fail(i.id, key);
    if (
      i.deleted_at !== null &&
      (typeof i.deleted_at !== "string" ||
        !Number.isFinite(Date.parse(i.deleted_at)))
    )
      fail(i.id, "deleted_at");
    if (!Number.isSafeInteger(i.version) || i.version < 0)
      fail(i.id, "version");
    if (
      i.provenance !== undefined &&
      (!i.provenance ||
        ["source", "source_id", "original_owner", "fingerprint"].some(
          (key) =>
            typeof (i.provenance as unknown as Record<string, unknown>)[key] !==
            "string",
        ))
    )
      fail(i.id, "provenance");
    if (!Array.isArray(i.tags) || i.tags.some((t) => typeof t !== "string"))
      fail(i.id, "tags");
    if (!Array.isArray(i.links) || !Array.isArray(i.images))
      fail(i.id, "관계 정보");
    for (const items of [i.links, i.images]) {
      const childIds = new Set<string>();
      for (const item of items) {
        if (
          !item ||
          typeof item.id !== "string" ||
          !item.id ||
          childIds.has(item.id)
        )
          fail(i.id, "중복 관계 ID");
        childIds.add(item.id);
      }
    }
    for (const link of i.links)
      if (
        !["website", "github"].includes(link.type) ||
        typeof link.label !== "string" ||
        !validUrl(link.url)
      )
        fail(i.id, "link");
    for (const image of i.images)
      if (
        typeof image.storage_path !== "string" ||
        !image.storage_path ||
        typeof image.original_filename !== "string"
      )
        fail(i.id, "image");
    const visit = (node: unknown) => {
      if (!node || typeof node !== "object" || Array.isArray(node))
        fail(i.id, "문서 노드");
      const n = node as Record<string, unknown>;
      if (typeof n.type !== "string") fail(i.id, "문서 노드 type");
      if (n.content !== undefined) {
        if (!Array.isArray(n.content)) fail(i.id, "문서 content");
        (n.content as unknown[]).forEach(visit);
      }
    };
    visit(i.content);
    if (i.content.type !== "doc") fail(i.id, "Tiptap 문서");
    for (const node of imageNodes(i.content)) {
      const attrs = node.attrs as Record<string, unknown> | undefined;
      const image = i.images.find((im) => im.id === attrs?.id);
      if (!image || attrs?.storage_path !== image.storage_path)
        fail(i.id, "본문 이미지 참조");
    }
  }
}
