"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { Idea, makeIdea } from "./model";

type Pending = { idea: Idea; seq: number };
type Cache = { ideas: Idea[]; pending: Record<string, Pending> };
export function useIdeas() {
  const [user, setUser] = useState<User | null>(null),
    [demo, setDemo] = useState(false),
    [ready, setReady] = useState(false);
  const [ideas, setIdeas] = useState<Idea[]>([]),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [conflicts, setConflicts] = useState<string[]>([]);
  const data = useRef<Idea[]>([]),
    pending = useRef<Record<string, Pending>>({}),
    identity = useRef<string | null>(null),
    busy = useRef(false),
    generation = useRef(0),
    sequence = useRef(0),
    revision = useRef(0),
    blocked = useRef(new Set<string>()),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publish = useCallback((next: Idea[]) => {
    revision.current++;
    data.current = next;
    setIdeas(next);
  }, []);
  const persist = useCallback(() => {
    if (!identity.current) return;
    try {
      localStorage.setItem(
        `ideadock:data:${identity.current}`,
        JSON.stringify({ ideas: data.current, pending: pending.current }),
      );
      return true;
    } catch {
      setError(
        "이 기기에 임시 저장하지 못했습니다. 저장 공간을 확인하고 탭을 닫기 전에 백업을 내려받으세요.",
      );
      return false;
    }
  }, []);
  const refresh = useCallback(async () => {
    if (
      !supabase ||
      !identity.current ||
      identity.current === "demo" ||
      busy.current
    )
      return;
    const owner = identity.current,
      epoch = generation.current,
      started = revision.current;
    const { data: rows, error: failure } = await supabase.rpc("list_ideas");
    if (
      epoch !== generation.current ||
      owner !== identity.current ||
      started !== revision.current
    )
      return;
    if (failure) {
      setError(`불러오기 실패: ${failure.message}`);
      return;
    }
    const remote = (rows || []) as Idea[];
    for (const item of Object.values(pending.current)) {
      const index = remote.findIndex((i) => i.id === item.idea.id);
      if (index < 0) remote.push(item.idea);
      else remote[index] = item.idea;
    }
    publish(remote);
    persist();
  }, [persist, publish]);
  const flush = useCallback(async () => {
    if (busy.current || !identity.current) return;
    if (identity.current === "demo") {
      if (persist()) setStatus("이 브라우저에 저장됨");
      return;
    }
    if (!supabase) return;
    busy.current = true;
    const epoch = generation.current;
    try {
      for (const [id, item] of Object.entries(pending.current)) {
        if (epoch !== generation.current) break;
        if (blocked.current.has(id)) continue;
        setStatus("저장 중…");
        const { data: result, error: failure } = await supabase.rpc(
          "save_idea",
          { document: item.idea, expected_version: item.idea.version },
        );
        if (epoch !== generation.current) break;
        if (failure) {
          if (failure.message.includes("VERSION_CONFLICT")) {
            blocked.current.add(id);
            setConflicts((prev) => Array.from(new Set([...prev, id])));
            setError(
              "다른 기기에서 변경된 아이디어가 있습니다. 두 버전을 확인해 주세요.",
            );
          } else
            setError(
              `저장 실패 · 초안은 이 기기에 보관됩니다: ${failure.message}`,
            );
          setStatus("저장 확인 필요");
          break;
        }
        const saved = result as Idea;
        const current = pending.current[id];
        if (current?.seq === item.seq) {
          delete pending.current[id];
          publish(data.current.map((i) => (i.id === id ? saved : i)));
        } else if (current) {
          current.idea = { ...current.idea, version: saved.version };
          publish(
            data.current.map((i) =>
              i.id === id ? { ...i, version: saved.version } : i,
            ),
          );
        }
        persist();
        setStatus(
          Object.keys(pending.current).length
            ? "변경 내용 대기 중"
            : "모든 변경사항 저장됨",
        );
        if (!Object.keys(pending.current).length && !blocked.current.size)
          setError("");
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "연결을 확인해 주세요.",
      );
      setStatus("저장 확인 필요");
    } finally {
      busy.current = false;
    }
  }, [persist, publish]);
  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }
    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
        if (session?.user) setDemo(false);
        setReady(true);
      },
    );
    return () => subscription.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    const owner = demo ? "demo" : (user?.id ?? null);
    generation.current++;
    identity.current = owner;
    pending.current = {};
    blocked.current.clear();
    publish([]);
    setConflicts([]);
    setError("");
    setStatus("");
    if (!owner) return;
    try {
      const cached = JSON.parse(
        localStorage.getItem(`ideadock:data:${owner}`) || "null",
      ) as Cache | null;
      if (cached) {
        pending.current = cached.pending || {};
        sequence.current = Math.max(
          0,
          ...Object.values(pending.current).map((p) => p.seq),
        );
        publish(cached.ideas || []);
      }
    } catch {
      setError(
        "임시 저장 파일을 읽지 못했습니다. 브라우저 저장 공간을 확인해 주세요.",
      );
    }
    if (owner !== "demo") {
      void refresh();
      void flush();
    } else setStatus("체험 모드 · 이 브라우저에만 저장");
  }, [user?.id, demo, flush, publish, refresh]);
  useEffect(() => {
    const interval = setInterval(() => {
      void flush();
      void refresh();
    }, 15000);
    const online = () => {
      void flush();
      void refresh();
    };
    const leave = (e: BeforeUnloadEvent) => {
      persist();
      if (identity.current !== "demo" && Object.keys(pending.current).length) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("online", online);
    window.addEventListener("beforeunload", leave);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", online);
      window.removeEventListener("beforeunload", leave);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flush, refresh, persist]);
  const update = useCallback(
    (idea: Idea) => {
      if (!identity.current || idea.user_id !== identity.current) return;
      const next = { ...idea, updated_at: new Date().toISOString() };
      publish(
        data.current.some((i) => i.id === next.id)
          ? data.current.map((i) => (i.id === next.id ? next : i))
          : [next, ...data.current],
      );
      pending.current[next.id] = { idea: next, seq: ++sequence.current };
      if (persist())
        setStatus(
          identity.current === "demo"
            ? "이 브라우저에 저장됨"
            : "변경 내용 임시 보관됨",
        );
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 700);
    },
    [flush, persist, publish],
  );
  const create = useCallback(
    (title: string) => {
      if (!identity.current || !title.trim()) return;
      const idea = makeIdea(title, identity.current);
      update(idea);
      return idea;
    },
    [update],
  );
  async function resolve(id: string, keepLocal: boolean) {
    if (!supabase) return;
    const epoch = generation.current;
    const { data: rows, error: failure } = await supabase.rpc("list_ideas");
    if (epoch !== generation.current) return;
    if (failure) {
      setError(failure.message);
      return;
    }
    const remote = (rows as Idea[]).find((i) => i.id === id),
      local = data.current.find((i) => i.id === id);
    if (keepLocal && local) {
      const copyId = crypto.randomUUID();
      const imageMap = new Map<string, Idea["images"][number]>();
      try {
        for (const image of local.images) {
          const id = crypto.randomUUID();
          const storage_path = `${local.user_id}/${copyId}/${id}`;
          const result = await supabase.storage
            .from("idea-images")
            .copy(image.storage_path, storage_path);
          if (epoch !== generation.current) return;
          if (result.error) throw result.error;
          imageMap.set(image.id, { ...image, id, storage_path });
        }
      } catch {
        setError(
          "이미지를 복사하지 못했습니다. 원래 초안은 보존되어 있습니다. 연결을 확인하고 다시 시도해 주세요.",
        );
        return;
      }
      if (data.current.find((i) => i.id === id) !== local) {
        setError(
          "복사하는 동안 초안이 변경되었습니다. 최신 내용을 보존했으니 다시 시도해 주세요.",
        );
        return;
      }
      const remapImages = (
        node: Record<string, unknown>,
      ): Record<string, unknown> => {
        const attrs = node.attrs as { id?: string } | undefined;
        const image = attrs?.id ? imageMap.get(attrs.id) : undefined;
        return {
          ...node,
          ...(node.type === "ideaImage" && image
            ? { attrs: { ...attrs, ...image } }
            : {}),
          ...(Array.isArray(node.content)
            ? {
                content: node.content.map((child) =>
                  remapImages(child as Record<string, unknown>),
                ),
              }
            : {}),
        };
      };
      const copy = {
        ...local,
        id: copyId,
        links: local.links.map((link) => ({
          ...link,
          id: crypto.randomUUID(),
        })),
        images: Array.from(imageMap.values()),
        content: remapImages(local.content),
        title: `${local.title} (내 초안)`,
        version: 0,
        created_at: new Date().toISOString(),
      };
      update(copy);
    }
    delete pending.current[id];
    blocked.current.delete(id);
    publish(
      data.current.filter((i) => i.id !== id).concat(remote ? [remote] : []),
    );
    persist();
    setConflicts((prev) => prev.filter((x) => x !== id));
    setError("");
    void flush();
  }
  async function signOut() {
    if (Object.keys(pending.current).length && identity.current !== "demo") {
      setError(
        "아직 서버에 저장되지 않은 내용이 있습니다. 재시도하거나 백업한 후 로그아웃해 주세요.",
      );
      return;
    }
    if (demo) {
      setDemo(false);
      return;
    }
    const result = await supabase?.auth.signOut();
    if (result?.error) setError(result.error.message);
  }
  return {
    user,
    demo,
    ready,
    ideas,
    status,
    error,
    setError,
    conflicts,
    resolve,
    update,
    create,
    flush,
    signOut,
    startDemo: () => setDemo(true),
    pendingCount: Object.keys(pending.current).length,
  };
}
