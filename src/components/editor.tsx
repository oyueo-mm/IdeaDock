"use client";
import { useEffect } from "react";
import {
  useEditor,
  EditorContent,
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  Bold,
  Italic,
  Heading2,
  List,
  ListOrdered,
  ListTodo,
  Undo2,
  Redo2,
  Link2,
} from "lucide-react";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import type { IdeaImage } from "@/lib/model";
function InlineImage({ node, extension, deleteNode }: NodeViewProps) {
  const [url, setUrl] = useState("");
  const path = String(node.attrs.storage_path || "");
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(path)) {
        setUrl(path);
        return;
      }
      const result = await supabase?.storage
        .from("idea-images")
        .createSignedUrl(path, 3600);
      if (live && result?.data) setUrl(result.data.signedUrl);
    };
    void load();
    const timer = setInterval(() => void load(), 3000000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [path]);
  return (
    <NodeViewWrapper className="inline-image" contentEditable={false}>
      {url ? (
        <button type="button" onClick={() => extension.options.onZoom(url)}>
          <img
            src={url}
            alt={String(node.attrs.original_filename || "본문 이미지")}
          />
        </button>
      ) : (
        <span>이미지 불러오는 중…</span>
      )}
      <button
        type="button"
        className="inline-image-remove"
        aria-label="본문 이미지 제거"
        onClick={deleteNode}
      >
        ×
      </button>
    </NodeViewWrapper>
  );
}
const ImageNode = Node.create<{ onZoom: (url: string) => void }>({
  name: "ideaImage",
  group: "block",
  atom: true,
  draggable: true,
  addOptions() {
    return { onZoom: () => {} };
  },
  addAttributes() {
    return {
      id: { default: "" },
      storage_path: { default: "" },
      original_filename: { default: "" },
    };
  },
  parseHTML() {
    return [];
  },
  renderHTML() {
    return ["figure", { "data-idea-image": "true" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(InlineImage);
  },
});
export default function Editor({
  content,
  onChange,
  onFiles,
  onZoom,
}: {
  content: Record<string, unknown>;
  onChange: (json: Record<string, unknown>, text: string) => void;
  onFiles: (files: File[]) => Promise<IdeaImage[]>;
  onZoom: (url: string) => void;
}) {
  async function insertFiles(files: File[]) {
    const images = await onFiles(files);
    if (!editor || editor.isDestroyed) return;
    for (const image of images)
      editor
        .chain()
        .focus()
        .insertContent({ type: "ideaImage", attrs: image })
        .run();
  }
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          protocols: ["http", "https"],
          isAllowedUri: (url) => /^https?:\/\//i.test(url),
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      ImageNode.configure({ onZoom }),
    ],
    content,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": "아이디어 본문",
        role: "textbox",
        "aria-multiline": "true",
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files || []);
        if (files.length) {
          event.preventDefault();
          void insertFiles(files);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length) {
          event.preventDefault();
          void insertFiles(files);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getJSON(), editor.getText()),
  });
  useEffect(() => {
    if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(content))
      editor.commands.setContent(content, { emitUpdate: false });
  }, [content, editor]);
  if (!editor) return <div className="editor-loading">편집기 준비 중…</div>;
  const tools = [
    {
      label: "굵게",
      icon: Bold,
      active: editor.isActive("bold"),
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      label: "기울임",
      icon: Italic,
      active: editor.isActive("italic"),
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      label: "소제목",
      icon: Heading2,
      active: editor.isActive("heading"),
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: "글머리 목록",
      icon: List,
      active: editor.isActive("bulletList"),
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      label: "번호 목록",
      icon: ListOrdered,
      active: editor.isActive("orderedList"),
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      label: "체크리스트",
      icon: ListTodo,
      active: editor.isActive("taskList"),
      run: () => editor.chain().focus().toggleTaskList().run(),
    },
    {
      label: "실행 취소",
      icon: Undo2,
      run: () => editor.chain().focus().undo().run(),
    },
    {
      label: "다시 실행",
      icon: Redo2,
      run: () => editor.chain().focus().redo().run(),
    },
  ];
  return (
    <div className="editor">
      <div className="editor-toolbar" role="toolbar" aria-label="본문 서식">
        {tools.map((t) => (
          <button
            type="button"
            key={t.label}
            title={t.label}
            aria-label={t.label}
            aria-pressed={t.active || false}
            onClick={t.run}
          >
            <t.icon size={16} />
          </button>
        ))}
        <button
          type="button"
          aria-label="본문 링크 삽입"
          title="선택한 글에 링크"
          onClick={() => {
            const url = window.prompt("HTTP 또는 HTTPS 주소");
            if (url && /^https?:\/\//i.test(url)) {
              editor.chain().focus().setLink({ href: url }).run();
            }
          }}
        >
          <Link2 size={16} />
        </button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
