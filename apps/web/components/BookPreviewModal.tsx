"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

interface PreviewPage {
  id: string;
  caption: string | null;
  ready: boolean;
  url: string | null;
}
interface PagesResponse {
  sessionId: string;
  storyId: string;
  title: string;
  pages: PreviewPage[];
}

export function BookPreviewModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [data, setData] = useState<PagesResponse | null>(null);
  const [error, setError] = useState(false);
  const [zoomedIndex, setZoomedIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<PagesResponse>(`/api/sessions/${sessionId}/pages`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setZoomedIndex((current) => {
          if (current !== null) return null;
          onClose();
          return current;
        });
      }
      if (e.key === "ArrowRight") {
        setZoomedIndex((current) =>
          current !== null && data ? Math.min(current + 1, data.pages.length - 1) : current,
        );
      }
      if (e.key === "ArrowLeft") {
        setZoomedIndex((current) => (current !== null ? Math.max(current - 1, 0) : current));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, onClose]);

  const zoomedPage = zoomedIndex !== null ? data?.pages[zoomedIndex] : undefined;

  return (
    <div className="preview-modal__backdrop" onClick={onClose}>
      <div className="preview-modal card" onClick={(e) => e.stopPropagation()}>
        <div className="preview-modal__header">
          <p className="eyebrow" style={{ margin: 0 }}>
            {data ? data.title : error ? "Couldn't load this book" : "Loading…"}
          </p>
          <button className="preview-modal__close" onClick={onClose} aria-label="Close preview">
            ×
          </button>
        </div>

        {error && <p className="page-lede" style={{ margin: "12px 0 0" }}>Try again in a moment.</p>}

        {data && (
          <div className="preview-grid">
            {data.pages.map((p, i) => (
              <button
                key={p.id}
                type="button"
                className="preview-grid__page"
                disabled={!p.ready || !p.url}
                onClick={() => setZoomedIndex(i)}
              >
                {p.ready && p.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.url} alt={p.caption ?? `Page ${i + 1}`} />
                ) : (
                  <span className="preview-grid__pending">Rendering…</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {zoomedPage?.url && (
        <div
          className="preview-lightbox"
          onClick={(e) => {
            e.stopPropagation();
            setZoomedIndex(null);
          }}
        >
          {zoomedIndex! > 0 && (
            <button
              type="button"
              className="preview-lightbox__nav preview-lightbox__nav--prev"
              onClick={(e) => {
                e.stopPropagation();
                setZoomedIndex((i) => (i !== null ? i - 1 : i));
              }}
              aria-label="Previous page"
            >
              ‹
            </button>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomedPage.url} alt={zoomedPage.caption ?? ""} onClick={(e) => e.stopPropagation()} />
          {data && zoomedIndex! < data.pages.length - 1 && (
            <button
              type="button"
              className="preview-lightbox__nav preview-lightbox__nav--next"
              onClick={(e) => {
                e.stopPropagation();
                setZoomedIndex((i) => (i !== null ? i + 1 : i));
              }}
              aria-label="Next page"
            >
              ›
            </button>
          )}
        </div>
      )}
    </div>
  );
}
