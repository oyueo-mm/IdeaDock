import { unzipSync, strFromU8 } from "fflate";
import { digest } from "./integrity";
import { type Idea, makeIdea, validUrl, validateImage } from "./model";

type Node = Record<string, unknown>;
export type WordCandidate = {
  sourceKeys?: string[];
  key: string;
  idea: Idea;
  selected: boolean;
  warnings: string[];
  action: "skip" | "add" | "merge";
  mergeId: string;
  folder: string | null;
};
export type WordPreview = {
  fileHash: string;
  fileName: string;
  original: string;
  candidates: WordCandidate[];
  warnings: string[];
};
const relNS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function xml(text: string) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror"))
    throw new Error("Word XML을 읽을 수 없습니다.");
  return doc;
}
function descendants(el: Element | Document, name: string) {
  return Array.from(el.getElementsByTagNameNS("*", name));
}
const textOf = (el: Element) =>
  descendants(el, "t")
    .map((n) => n.textContent ?? "")
    .join("");
export function bytesUrl(bytes: Uint8Array, type: string) {
  let text = "";
  for (let n = 0; n < bytes.length; n += 8192)
    text += String.fromCharCode(...bytes.subarray(n, n + 8192));
  return `data:${type};base64,${btoa(text)}`;
}
export function duplicateCandidates(idea: Idea, existing: Idea[]) {
  const title = (s: string) =>
    s
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\s\p{P}]/gu, "");
  const grams = (s: string) => {
    s = s.replace(/\s/g, "");
    return new Set(
      Array.from({ length: Math.max(0, s.length - 2) }, (_, i) =>
        s.slice(i, i + 3),
      ),
    );
  };
  const a = grams(idea.plain_text);
  return existing.filter((i) => {
    if (
      idea.provenance &&
      i.imports?.some(
        (r) =>
          `docx:${r.file_hash}` === idea.provenance!.source &&
          r.item_id === idea.provenance!.source_id,
      )
    )
      return true;
    if (
      i.provenance?.source === idea.provenance?.source &&
      i.provenance?.source_id === idea.provenance?.source_id &&
      idea.provenance
    )
      return true;
    if (title(i.title) === title(idea.title)) return true;
    const b = grams(i.plain_text),
      intersection = [...a].filter((g) => b.has(g)).length;
    return a.size > 10 && intersection / Math.max(a.size, b.size) > 0.65;
  });
}
export async function parseDocx(
  file: File,
  owner: string,
  existing: Idea[] = [],
): Promise<WordPreview> {
  if (!/\.docx$/i.test(file.name) || file.size > 25 * 1024 * 1024)
    throw new Error("25MB 이하의 .docx 파일을 선택하세요.");
  const bytes = new Uint8Array(await file.arrayBuffer()),
    fileHash = await digest(new Blob([bytes]));
  let total = 0;
  const files = unzipSync(bytes, {
    filter(entry) {
      total += entry.originalSize;
      if (entry.originalSize > 20 * 1024 * 1024 || total > 100 * 1024 * 1024)
        throw new Error("압축 해제 크기가 너무 큽니다.");
      return true;
    },
  });
  if (!files["word/document.xml"])
    throw new Error("Word 본문이 없는 파일입니다.");
  const doc = xml(strFromU8(files["word/document.xml"]));
  const relations = new Map<string, { target: string; external: boolean }>();
  if (files["word/_rels/document.xml.rels"])
    for (const r of descendants(
      xml(strFromU8(files["word/_rels/document.xml.rels"])),
      "Relationship",
    ))
      relations.set(r.getAttribute("Id")!, {
        target: r.getAttribute("Target") ?? "",
        external: r.getAttribute("TargetMode") === "External",
      });
  const contentTypes = new Map<string, string>();
  if (files["[Content_Types].xml"])
    for (const e of descendants(
      xml(strFromU8(files["[Content_Types].xml"])),
      "Default",
    ))
      contentTypes.set(
        e.getAttribute("Extension")!.toLowerCase(),
        e.getAttribute("ContentType")!,
      );
  const headingStyles = new Set<string>();
  if (files["word/styles.xml"]) {
    const styles = descendants(
      xml(strFromU8(files["word/styles.xml"])),
      "style",
    );
    for (let pass = 0; pass < styles.length; pass++) {
      let changed = false;
      for (const style of styles) {
        const id = style.getAttribute("w:styleId") ?? "",
          name = descendants(style, "name")[0]?.getAttribute("w:val") ?? "",
          base = descendants(style, "basedOn")[0]?.getAttribute("w:val") ?? "";
        if (
          !headingStyles.has(id) &&
          (/^(heading|title|제목)/i.test(name) || headingStyles.has(base))
        ) {
          headingStyles.add(id);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }
  let imageNumber = 0;
  const warnings: string[] = [];
  const candidates: WordCandidate[] = [];
  let current: WordCandidate | undefined,
    nextTitle = true;
  const finish = () => {
    if (current) {
      const nodes = current.idea.content.content as Node[];
      if (!nodes.length) nodes.push({ type: "paragraph" });
      candidates.push(current);
      current = undefined;
    }
  };
  const begin = (title: string) => {
    finish();
    const idea = makeIdea(title || "제목 확인 필요", owner);
    current = {
      key: String(candidates.length),
      sourceKeys: [String(candidates.length)],
      idea,
      selected: true,
      warnings: [],
      action: "add",
      mergeId: "",
      folder: null,
    };
  };
  const body = descendants(doc, "body")[0];
  if (!body) throw new Error("Word 본문이 없습니다.");
  const paragraphs = descendants(body, "p").filter((p) => {
    let parent = p.parentElement;
    while (parent && parent !== body) {
      if (parent.localName === "p") return false;
      parent = parent.parentElement;
    }
    return true;
  });
  for (const p of paragraphs) {
    const text = textOf(p),
      trimmed = text.trim();
    if (/^[\s=＿_\-─━]{3,}$/.test(text) && trimmed) {
      finish();
      nextTitle = true;
      continue;
    }
    const hasImage =
      descendants(p, "blip").length + descendants(p, "imagedata").length > 0;
    if (!trimmed && !hasImage) {
      if (current)
        (current.idea.content.content as Node[]).push({ type: "paragraph" });
      continue;
    }
    const style = descendants(p, "pStyle")[0]?.getAttribute("w:val") ?? "";
    const runs = descendants(p, "r").filter((r) => textOf(r).trim());
    const boldTitle =
      runs.length > 0 &&
      runs.every((r) =>
        descendants(r, "b").some((b) => b.getAttribute("w:val") !== "0"),
      );
    const heading =
      /^(Heading|Title|제목)/i.test(style) ||
      headingStyles.has(style) ||
      (/^\s*\d+[.)]\s+\S/.test(text) && text.length < 100) ||
      (boldTitle && text.length < 100);
    if (!current || nextTitle || heading) {
      begin(trimmed.slice(0, 200) || "이미지 아이디어");
      nextTitle = false;
      if (trimmed.length > 200)
        current!.warnings.push(
          "긴 첫 문단으로 임시 제목을 제안했습니다. 원문은 본문에 보존했습니다.",
        );
      for (const link of descendants(p, "hyperlink")) {
        const rel = relations.get(
          link.getAttributeNS(relNS, "id") ?? link.getAttribute("r:id") ?? "",
        );
        if (rel && validUrl(rel.target))
          current!.idea.links.push({
            id: crypto.randomUUID(),
            url: rel.target,
            label: textOf(link) || rel.target,
            type: rel.target.includes("github.com/") ? "github" : "website",
          });
      }
      if (trimmed.length <= 200 && !hasImage) {
        continue;
      }
    }
    const idea = current!.idea,
      nodes = idea.content.content as Node[];
    let inline: Node[] = [];
    const flush = () => {
      if (inline.length) {
        nodes.push({ type: "paragraph", content: inline });
        inline = [];
      }
    };
    const visit = (el: Element, href?: string) => {
      if (el.localName === "hyperlink") {
        const relation = relations.get(
          el.getAttributeNS(relNS, "id") ?? el.getAttribute("r:id") ?? "",
        );
        if (relation && validUrl(relation.target)) {
          href = relation.target;
          if (!idea.links.some((l) => l.url === href))
            idea.links.push({
              id: crypto.randomUUID(),
              url: href,
              label: textOf(el) || href,
              type: href.includes("github.com/") ? "github" : "website",
            });
        }
      }
      if (el.localName === "t") {
        const marks: Node[] = [];
        const run = el.parentElement;
        if (
          run &&
          descendants(run, "b").some((b) => b.getAttribute("w:val") !== "0")
        )
          marks.push({ type: "bold" });
        if (
          run &&
          descendants(run, "i").some((b) => b.getAttribute("w:val") !== "0")
        )
          marks.push({ type: "italic" });
        if (href)
          marks.push({
            type: "link",
            attrs: { href, target: "_blank", rel: "noopener noreferrer" },
          });
        if (el.textContent)
          inline.push({
            type: "text",
            text: el.textContent,
            ...(marks.length ? { marks } : {}),
          });
        return;
      }
      if (el.localName === "tab") {
        inline.push({ type: "text", text: "\t" });
        return;
      }
      if (el.localName === "br") {
        inline.push({ type: "hardBreak" });
        return;
      }
      if (el.localName === "blip" || el.localName === "imagedata") {
        flush();
        const id =
          el.getAttributeNS(relNS, "embed") ||
          el.getAttributeNS(relNS, "id") ||
          el.getAttribute("r:embed") ||
          el.getAttribute("r:id");
        const rel = relations.get(id ?? "");
        if (!rel || rel.external) {
          current!.warnings.push(
            "외부 링크 또는 알 수 없는 이미지 참조: 파일 원본을 확인하세요.",
          );
          return;
        }
        const path = rel.target.startsWith("/")
          ? rel.target.slice(1)
          : "word/" + rel.target;
        if (path.split("/").includes("..")) {
          current!.warnings.push("지원하지 않는 이미지 경로입니다.");
          return;
        }
        const image = files[path],
          ext = path.split(".").pop()!.toLowerCase(),
          type =
            contentTypes.get(ext) ||
            (
              {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                gif: "image/gif",
                webp: "image/webp",
              } as Record<string, string>
            )[ext] ||
            "application/octet-stream";
        try {
          if (!image) throw new Error("원본 이미지가 없습니다.");
          validateImage({ type, size: image.length });
          if (idea.images.length >= 12)
            throw new Error("아이디어당 12장을 초과합니다.");
          const metadata = {
            id: `word-image-${fileHash.slice(0, 24)}-${imageNumber++}`,
            storage_path: bytesUrl(image, type),
            original_filename: path.split("/").pop()!,
          };
          idea.images.push(metadata);
          nodes.push({ type: "ideaImage", attrs: { ...metadata } });
        } catch (e) {
          current!.warnings.push(
            `${path}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return;
      }
      for (const child of Array.from(el.children)) visit(child, href);
    };
    visit(p);
    flush();
    idea.plain_text += (idea.plain_text ? "\n" : "") + text;
  }
  finish();
  if (!candidates.length) throw new Error("가져올 문단이 없습니다.");
  for (const [index, c] of candidates.entries()) {
    const fingerprint = await digest(
      JSON.stringify({
        content: c.idea.content,
        title: c.idea.title,
        order: index,
      }),
    );
    c.idea.id = `word-${fileHash.slice(0, 24)}-${index}`;
    c.idea.provenance = {
      source: `docx:${fileHash}`,
      source_id: String(index),
      original_owner: owner,
      fingerprint,
    };
    if (duplicateCandidates(c.idea, existing).length) c.action = "skip";
    if (
      duplicateCandidates(
        c.idea,
        candidates.slice(0, index).map((v) => v.idea),
      ).length
    ) {
      c.action = "skip";
      c.warnings.push(
        "문서 안의 앞선 항목과 중복 후보입니다. 별도 추가 여부를 확인하세요.",
      );
    }
  }
  if (candidates.length === 1 && paragraphs.length > 3)
    warnings.push(
      "제목/구분선이 명확하지 않아 문서를 합쳐 보존했습니다. 미리보기의 분리 기능으로 항목을 나누세요.",
    );
  if (descendants(doc, "altChunk").length)
    warnings.push(
      "외부 포함 문서는 지원하지 않습니다. 원본 파일을 확인하세요.",
    );
  return {
    fileHash,
    fileName: file.name,
    original: bytesUrl(
      bytes,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    candidates,
    warnings,
  };
}
