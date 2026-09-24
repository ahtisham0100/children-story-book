"use client";
import { useEffect, useId, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import { useDialog } from "./useDialog";

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Focus trap, focus return and scroll lock. Escape closes the zoomed page
  // first, then the modal. Decided from current state, not inside a setState
  // updater: updaters must be pure, and Strict Mode runs them twice, which
  // used to call onClose() twice.
  useDialog(dialogRef, true, () => {
    if (zoomedIndex !== null) setZoomedIndex(null);
    else onClose();
  });

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
  }, [data]);

  const zoomedPage = zoomedIndex !== null ? data?.pages[zoomedIndex] : undefined;

  return (
    <div className="preview-modal__backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="preview-modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preview-modal__header">
          <h2 id={titleId} className="eyebrow" style={{ margin: 0 }}>
            {data ? data.title : error ? "Couldn't load this book" : "Loading…"}
          </h2>
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
                aria-label={p.ready && p.url ? `Enlarge ${p.caption ?? `page ${i + 1}`}` : `Page ${i + 1} still rendering`}
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
    </div>
  );
}
