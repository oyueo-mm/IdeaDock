import type { Idea } from "./model";

export type Folder = {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
};
export function makeFolder(
  name: string,
  owner: string,
  parent: string | null,
): Folder {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    user_id: owner,
    name: name.trim(),
    parent_id: parent,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    version: 0,
  };
}
export function validateFolders(input: unknown): asserts input is Folder[] {
  if (!Array.isArray(input)) throw new Error("폴더 배열이 없습니다.");
  const ids = new Set<string>();
  for (const f of input as Folder[]) {
    if (
      !f ||
      typeof f.id !== "string" ||
      !f.id ||
      ids.has(f.id) ||
      typeof f.user_id !== "string" ||
      !f.user_id ||
      typeof f.name !== "string" ||
      !f.name.trim() ||
      f.name.length > 200 ||
      !(f.parent_id === null || typeof f.parent_id === "string") ||
      !Number.isSafeInteger(f.version) ||
      f.version < 0 ||
      !Number.isFinite(Date.parse(f.created_at)) ||
      !Number.isFinite(Date.parse(f.updated_at)) ||
      !(f.deleted_at === null || Number.isFinite(Date.parse(f.deleted_at)))
    )
      throw new Error("폴더 무결성 오류");
    ids.add(f.id);
  }
  const byId = new Map((input as Folder[]).map((f) => [f.id, f]));
  for (const f of input as Folder[]) {
    const visited = new Set([f.id]);
    let parent = f.parent_id;
    while (parent) {
      if (visited.has(parent))
        throw new Error("순환 폴더 관계는 허용되지 않습니다.");
      visited.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor || ancestor.user_id !== f.user_id)
        throw new Error("상위 폴더가 없거나 계정이 다릅니다.");
      parent = ancestor.parent_id;
    }
  }
}
export function folderPath(folders: Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: Folder[] = [],
    seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const f = byId.get(id);
    if (!f) break;
    path.unshift(f);
    id = f.parent_id;
  }
  return path;
}
export function folderTrashed(
  folders: Folder[],
  id: string | null | undefined,
) {
  return folderPath(folders, id ?? null).some((f) => !!f.deleted_at);
}
export function validateMove(
  folders: Folder[],
  owner: string,
  folderIds: string[],
  ideas: Idea[],
  target: string | null,
) {
  const destination = target ? folders.find((f) => f.id === target) : null;
  if (
    target &&
    (!destination ||
      destination.user_id !== owner ||
      folderTrashed(folders, target))
  )
    throw new Error("이동 대상 폴더를 사용할 수 없습니다.");
  for (const id of folderIds) {
    const f = folders.find((f) => f.id === id);
    if (
      !f ||
      f.user_id !== owner ||
      folderTrashed(folders, id) ||
      folderPath(folders, target).some((p) => p.id === id)
    )
      throw new Error(
        "자신·하위 폴더 또는 휴지통 항목으로 이동할 수 없습니다.",
      );
  }
  for (const i of ideas)
    if (
      i.user_id !== owner ||
      i.deleted_at ||
      folderTrashed(folders, i.folder_id)
    )
      throw new Error("다른 계정 또는 휴지통의 아이디어는 이동할 수 없습니다.");
  validateFolders(
    folders.map((f) =>
      folderIds.includes(f.id) ? { ...f, parent_id: target } : f,
    ),
  );
}
export function validateWorkspace(ideas: Idea[], folders: Folder[]) {
  validateFolders(folders);
  for (const i of ideas)
    if (
      i.folder_id != null &&
      !folders.some((f) => f.id === i.folder_id && f.user_id === i.user_id)
    )
      throw new Error(`아이디어의 폴더를 찾을 수 없습니다: ${i.title}`);
}
