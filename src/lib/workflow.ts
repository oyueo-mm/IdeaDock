import type { Idea, IdeaCheckpoint, IdeaImprovement, IdeaSnapshot } from "./model";

export function addImprovement(idea: Idea, text: string): IdeaImprovement[] {
  const value = text.trim();
  if (!value) return idea.improvements ?? [];
  const now = new Date().toISOString();
  return [...(idea.improvements ?? []), { id: crypto.randomUUID(), text: value, is_done: false, created_at: now, updated_at: now, completed_at: null }];
}
export function makeCheckpoint(idea: Idea, label: string, summary = ""): IdeaCheckpoint {
  const snapshot: IdeaSnapshot = structuredClone({
    title: idea.title,
    content: idea.content,
    plain_text: idea.plain_text,
    tags: idea.tags,
    links: idea.links,
    images: idea.images,
    improvements: idea.improvements ?? [],
    is_completed: idea.is_completed,
    is_pinned: idea.is_pinned,
  });
  return { id: crypto.randomUUID(), label: label.trim(), summary: summary.trim(), created_at: new Date().toISOString(), snapshot };
}
export function saveCheckpoint(idea: Idea, label: string, summary = ""): Pick<Idea, "checkpoints" | "improvements"> {
  const checkpoint = makeCheckpoint(idea, label, summary);
  const improvements = (idea.improvements ?? []).map((note) =>
    note.is_done && !note.version_id ? { ...note, version_id: checkpoint.id } : note
  );
  checkpoint.snapshot.improvements = structuredClone(improvements);
  return { improvements, checkpoints: [...(idea.checkpoints ?? []), checkpoint] };
}
export function restoreCheckpoint(idea: Idea, checkpoint: IdeaCheckpoint): Partial<Idea> {
  const recovery = makeCheckpoint(idea, "복원 전 자동 보관", `${checkpoint.label} 복원 전 내용`);
  return { ...structuredClone(checkpoint.snapshot), checkpoints: [...(idea.checkpoints ?? []), recovery] };
}
