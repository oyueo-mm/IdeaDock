import type { Idea, IdeaLink } from "./model";

/**
 * Why an incoming idea is believed to exist already:
 * - id: the same idea id (a backup imported before)
 * - source: it was imported from this very item (provenance)
 * - content: same title and same text
 * - file: an earlier item of the same file has the same title and text
 */
export type MatchReason = "id" | "source" | "content" | "file";
export type ReviewAction = "create" | "skip" | "update";
/** What an approved update changes. Nothing else of the idea is touched. */
export type IdeaChanges = { completed?: boolean; github: IdeaLink[] };
export type ReviewItem = {
  idea: Idea;
  match?: { existing: Idea; reason: MatchReason };
  changes?: IdeaChanges;
  action: ReviewAction;
};
export type IdeaUpdate = {
  /** The idea in Drive to update. */
  id: string;
  /** Its version when the user reviewed it; a different one means it changed since. */
  version: number;
  changes: IdeaChanges;
};

const squash = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
const urlKey = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();
export const githubLinks = (idea: Idea) =>
  idea.links.filter((l) => l.type === "github");

/** The completion state and GitHub links an incoming idea would add to an existing one. */
export function changesFor(incoming: Idea, existing: Idea): IdeaChanges {
  const known = new Set(githubLinks(existing).map((l) => urlKey(l.url)));
  const github: IdeaLink[] = [];
  for (const link of githubLinks(incoming)) {
    const key = urlKey(link.url);
    if (known.has(key)) continue;
    known.add(key);
    github.push(link);
  }
  return {
    ...(incoming.is_completed !== existing.is_completed
      ? { completed: incoming.is_completed }
      : {}),
    github,
  };
}
export const hasChanges = (changes?: IdeaChanges) =>
  !!changes && (changes.completed !== undefined || changes.github.length > 0);

/**
 * Compares incoming ideas with those already in the workspace. Matching ideas
 * are skipped by default; the user decides in the preview. An idea with no
 * text is matched by id or source only, so empty "제목 없음" notes are never
 * merged by their title.
 */
export function reviewImport(incoming: Idea[], existing: Idea[]): ReviewItem[] {
  const byId = new Map(existing.map((i) => [i.id, i]));
  const bySource = new Map<string, Idea>();
  const byContent = new Map<string, Idea>();
  for (const idea of existing) {
    if (idea.provenance)
      bySource.set(
        `${idea.provenance.source}\n${idea.provenance.source_id}`,
        idea,
      );
    const text = squash(idea.plain_text);
    if (text) byContent.set(`${squash(idea.title)}\n${text}`, idea);
  }
  const inFile = new Map<string, Idea>();
  return incoming.map((idea): ReviewItem => {
    let match: ReviewItem["match"];
    const same = byId.get(idea.id);
    if (same) match = { existing: same, reason: "id" };
    const origin =
      idea.provenance &&
      bySource.get(`${idea.provenance.source}\n${idea.provenance.source_id}`);
    if (!match && origin) match = { existing: origin, reason: "source" };
    const text = squash(idea.plain_text);
    const key = `${squash(idea.title)}\n${text}`;
    if (!match && text) {
      const content = byContent.get(key);
      if (content) match = { existing: content, reason: "content" };
      else if (inFile.has(key))
        match = { existing: inFile.get(key)!, reason: "file" };
    }
    if (text && !inFile.has(key)) inFile.set(key, idea);
    if (!match) return { idea, action: "create" };
    // An in-file repeat has nothing in Drive to update.
    const changes =
      match.reason === "file" ? undefined : changesFor(idea, match.existing);
    return { idea, match, changes, action: "skip" };
  });
}

/** The existing idea with only its completion state and new GitHub links changed. */
export function applyChanges(
  existing: Idea,
  changes: IdeaChanges,
  now = new Date().toISOString(),
): Idea {
  const known = new Set(githubLinks(existing).map((l) => urlKey(l.url)));
  return {
    ...existing,
    is_completed: changes.completed ?? existing.is_completed,
    links: [
      ...existing.links,
      ...changes.github.filter((l) => !known.has(urlKey(l.url))),
    ],
    updated_at: now,
  };
}
/** True when the idea already shows every requested change (a re-run). */
export function alreadyApplied(existing: Idea, changes: IdeaChanges) {
  const known = new Set(githubLinks(existing).map((l) => urlKey(l.url)));
  return (
    (changes.completed === undefined ||
      existing.is_completed === changes.completed) &&
    changes.github.every((l) => known.has(urlKey(l.url)))
  );
}

export const REASON_TEXT: Record<MatchReason, string> = {
  id: "같은 ID의 아이디어가 이미 있습니다",
  source: "이전에 이 항목에서 가져온 아이디어가 있습니다",
  content: "제목과 본문이 같은 아이디어가 이미 있습니다",
  file: "같은 파일의 앞선 항목과 제목·본문이 같습니다",
};
export function describeChanges(changes?: IdeaChanges) {
  if (!hasChanges(changes)) return "바뀌는 내용 없음";
  return [
    changes!.completed === undefined
      ? ""
      : `완료 상태 → ${changes!.completed ? "완료" : "미완료"}`,
    changes!.github.length
      ? `GitHub 링크 ${changes!.github.length}개 추가`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
