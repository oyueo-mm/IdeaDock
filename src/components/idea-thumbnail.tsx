"use client";
import { useEffect, useRef, useState } from "react";
import type { IdeaImage } from "@/lib/model";
import { imageUrl } from "@/lib/images";

export default function IdeaThumbnail({
  image,
  title,
  onOpen,
}: {
  image: IdeaImage;
  title: string;
  onOpen: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!button.current || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(button.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    let allocated: string | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void imageUrl(image.storage_path)
      .then((url) => {
        if (!live) {
          URL.revokeObjectURL(url);
          return;
        }
        allocated = url;
        setLoaded({ path: image.storage_path, url });
      })
      .catch(() => {
        if (!live) return;
        setLoaded(null);
        // A dropped connection or a rate limit is usually brief: try again.
        if (attempt < 3)
          retry = setTimeout(
            () => setAttempt(attempt + 1),
            1500 * 2 ** attempt,
          );
      });
    return () => {
      live = false;
      clearTimeout(retry);
      if (allocated) URL.revokeObjectURL(allocated);
    };
  }, [image.storage_path, visible, attempt]);
  const url = loaded?.path === image.storage_path ? loaded.url : undefined;
  return (
    <button
      ref={button}
      className="idea-thumbnail"
      onClick={onOpen}
      aria-label={`${title} 열기`}
    >
      {url ? (
        <img
          src={url}
          alt={`${title} 대표 이미지: ${image.original_filename}`}
          loading="lazy"
          decoding="async"
          onError={() => setLoaded(null)}
        />
      ) : (
        <span aria-hidden="true">이미지</span>
      )}
    </button>
  );
}
