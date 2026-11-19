"use client";
import { useState } from "react";
import { Check, History, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { Idea, IdeaCheckpoint } from "@/lib/model";
import { addImprovement, restoreCheckpoint, saveCheckpoint } from "@/lib/workflow";

type WorkflowMode = "improvements" | "versions";
export default function IdeaWorkflow({ idea, mode, onChange }: {
  idea: Idea;
  mode: WorkflowMode;
  onChange: (changes: Partial<Idea>) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [label, setLabel] = useState("");
  const [summary, setSummary] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  const notes = idea.improvements ?? [];
  const checkpoints = idea.checkpoints ?? [];
  function editNote(id: string, text: string) {
    const next = text.trim();
    if (!next) return;
    onChange({ improvements: notes.map((note) => note.id === id
      ? { ...note, text: next, updated_at: new Date().toISOString() } : note) });
    setEditing(null);
  }
  if (mode === "improvements") {
    return (
      <section className="workflow-section" aria-label="개선 사항">
        <div className="workflow-heading"><h2>개선 사항</h2><span>{notes.filter((n) => !n.is_done).length}개 남음</span></div>
        <form className="workflow-input" onSubmit={(e) => { e.preventDefault(); if (!draft.trim()) return; onChange({ improvements: addImprovement(idea, draft) }); setDraft(""); }}>
          <input autoFocus aria-label="개선 사항 빠른 입력" placeholder="떠오른 개선 사항을 적어보세요…" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={500} />
          <button className="primary" type="submit" disabled={!draft.trim()} aria-label="개선 사항 추가"><Plus size={16} /></button>
        </form>
        <div className="workflow-notes">
          {notes.length === 0 && <p className="workflow-muted">개선 사항이 없습니다.</p>}
          {[...notes].reverse().map((note) => (
            <div className="workflow-note" key={note.id}>
              <input type="checkbox" aria-label={`${note.text} 완료`} checked={note.is_done} onChange={(e) => {
                const done = e.target.checked;
                onChange({ improvements: notes.map((n) => n.id === note.id
                  ? { ...n, is_done: done, completed_at: done ? new Date().toISOString() : null,
                      version_id: done ? n.version_id : undefined, updated_at: new Date().toISOString() } : n) });
              }} />
              <div className="workflow-note-content">
                {editing === note.id ? (
                  <form className="workflow-edit" onSubmit={(e) => { e.preventDefault(); editNote(note.id, editingText); }}>
                    <input autoFocus aria-label="개선 사항 수정" value={editingText} maxLength={500} onChange={(e) => setEditingText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }} />
                    <button aria-label="수정 저장" type="submit"><Check size={15}/></button>
                    <button aria-label="수정 취소" type="button" onClick={() => setEditing(null)}><X size={15}/></button>
                  </form>
                ) : <span className={note.is_done ? "workflow-done" : ""}>{note.text}</span>}
                <small>{new Date(note.created_at).toLocaleDateString("ko-KR")}{note.version_id && checkpoints.find((c) => c.id === note.version_id) ? ` · ${checkpoints.find((c) => c.id === note.version_id)?.label}` : ""}</small>
              </div>
              {editing !== note.id && <div className="workflow-note-actions">
                <button aria-label={`${note.text} 수정`} onClick={() => { setEditing(note.id); setEditingText(note.text); }}><Pencil size={14}/></button>
                <button aria-label={`${note.text} 삭제`} onClick={() => { if (window.confirm("이 개선 사항을 삭제할까요?")) onChange({ improvements: notes.filter((n) => n.id !== note.id) }); }}><Trash2 size={14}/></button>
              </div>}
            </div>
          ))}
        </div>
      </section>
    );
  }
  const selected: IdeaCheckpoint | undefined = checkpoints.find((c) => c.id === viewing);
  const changes = selected ? [
    selected.snapshot.title !== idea.title ? "제목" : "",
    selected.snapshot.plain_text !== idea.plain_text ? "본문" : "",
    JSON.stringify(selected.snapshot.tags) !== JSON.stringify(idea.tags) ? "태그" : "",
    JSON.stringify(selected.snapshot.links) !== JSON.stringify(idea.links) ? "링크" : "",
    JSON.stringify(selected.snapshot.images) !== JSON.stringify(idea.images) ? "이미지" : "",
    JSON.stringify(selected.snapshot.improvements) !== JSON.stringify(idea.improvements ?? []) ? "개선 사항" : "",
    selected.snapshot.is_completed !== idea.is_completed ? "완료 여부" : "",
  ].filter(Boolean) : [];
  return (
    <section className="workflow-section" aria-label="버전 관리">
      <div className="workflow-heading"><h2>버전 관리</h2><span>{checkpoints.length}개 기록</span></div>
      <form className="workflow-version-form" onSubmit={(e) => {
        e.preventDefault();
        const name = label.trim() || `v1.${checkpoints.length}`;
        if (checkpoints.some((c) => c.label === name)) return;
        onChange(saveCheckpoint(idea, name, summary));
        setLabel(""); setSummary("");
      }}>
        <input autoFocus aria-label="새 버전 이름" placeholder={`버전 이름 · 예: v1.${checkpoints.length}`} maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
        <input aria-label="버전 변경 내용" placeholder="무엇이 달라졌나요? (선택)" maxLength={240} value={summary} onChange={(e) => setSummary(e.target.value)} />
        <button className="primary" type="submit"><Plus size={15}/> 현재 상태를 버전으로 저장</button>
      </form>
      <div className="workflow-history">
        {checkpoints.length === 0 && <p className="workflow-muted">아직 저장한 버전이 없습니다.</p>}
        {[...checkpoints].reverse().map((item) => (
          <div key={item.id} className="workflow-checkpoint">
            <div className="workflow-checkpoint-title">
              <strong>{item.label}</strong>
              <small>{new Date(item.created_at).toLocaleString("ko-KR")}</small>
            </div>
            {item.summary && <p>{item.summary}</p>}
            <button onClick={() => setViewing(viewing === item.id ? null : item.id)}>{viewing === item.id ? "접기" : "보기·비교"}</button>
          </div>
        ))}
      </div>
      {selected && <div className="workflow-comparison">
        <div className="workflow-heading"><h3><History size={14}/> {selected.label} 비교</h3></div>
        <p className="workflow-muted">{changes.length ? `변경: ${changes.join(", ")}` : "현재 내용과 차이가 없습니다."}</p>
        <div className="workflow-compare-columns">
          <div><strong>저장된 버전</strong><p>{selected.snapshot.title}</p><pre>{selected.snapshot.plain_text || "(본문 없음)"}</pre></div>
          <div><strong>현재</strong><p>{idea.title}</p><pre>{idea.plain_text || "(본문 없음)"}</pre></div>
        </div>
        <button className="workflow-restore" onClick={() => {
          if (window.confirm("이 버전으로 복원할까요? 현재 상태는 복원 전 버전으로 자동 보관됩니다.")) {
            onChange(restoreCheckpoint(idea, selected));
            setViewing(null);
          }
        }}><RotateCcw size={14}/> 이 버전 복원</button>
      </div>}
    </section>
  );
}
