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
        if (live) setLoaded(null);
      });
    return () => {
      live = false;
      if (allocated) URL.revokeObjectURL(allocated);
    };
  }, [image.storage_path, visible]);
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
