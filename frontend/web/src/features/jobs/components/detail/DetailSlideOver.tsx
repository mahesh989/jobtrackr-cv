"use client";

/**
 * Slide-over shell for the board's detail pane (handoff §2.1).
 *
 * The pane glides in on a long decel curve with a soft scrim behind it;
 * clicking the scrim dismisses. Content inside (BoardDetailPanel) staggers
 * up in waves. `body.pane-open` is set for the pane's lifetime — the hook
 * the real app can use for analytics and a11y (aria-hidden the board,
 * announcing the pane to screen readers).
 *
 * One instance serves every breakpoint, sized like the demo's pane:
 * `min(684px, 92vw)` — a 684px desktop side drawer that scales down on
 * narrow viewports (demo: `.detail-pane { width: min(684px, 92vw) }`).
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BoardDetailPanel } from "./BoardDetailPanel";
import type { BoardJob } from "../../lib/jobFilters";

export function DetailSlideOver({
  job, onClose, onPatchJob,
}: {
  job: BoardJob;
  onClose: () => void;
  /** Optimistically patch this job's row in the board list. */
  onPatchJob?: (id: string, patch: Partial<BoardJob>) => void;
}) {
  const [entered, setEntered] = useState(false);
  // Mount → next frame flips the transform/opacity classes: the pane starts
  // off-canvas (and the scrim transparent) so the browser paints once, then
  // the transition animates them in. The rAF guarantees the two frames.
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // `document.body` isn't available during SSR; the portal only ever
  // matters client-side (this pane opens from a click), so gate on mount —
  // same one-time hydration shape as ResizableSidebar's width read.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- gate the portal on client mount once; document.body doesn't exist during SSR
    setMounted(true);
  }, []);

  // Scroll-lock + a11y hook: `body.pane-open` lives exactly as long as a job
  // is being read. Overflow is locked so the board behind a full-screen
  // (mobile) pane can't scroll under the gesture.
  useEffect(() => {
    document.body.classList.add("pane-open");
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.classList.remove("pane-open");
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  if (!mounted) return null;

  // Portalled straight to document.body — NOT rendered in place in the
  // board's own tree. `fixed` only holds against the true viewport when
  // nothing between it and <body> has a transform/filter/perspective/
  // will-change (each of those opens a new containing block); the board
  // column this used to render inside has `.anim-in` entrance animations
  // (`#jobs-board`, `dashboard/page.tsx`) that this pane has no control
  // over and that could reappear anywhere else in the tree in the future.
  // A portal makes that whole class of bug structurally impossible instead
  // of relying on every ancestor staying transform-free forever — this was
  // exactly why the pane was clipping to the centred 922px column and
  // starting below the summary row instead of covering the full screen
  // from the true right edge, like the demo.
  return createPortal(
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-[rgba(13,17,23,0.14)] transition-opacity duration-[240ms] ${
          entered ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={job.title}
        // Demo `.detail-pane`: starts off-canvas past the right edge
        // (translateX(102%)) and glides to translateX(0) on a long decel
        // curve — 320ms cubic-bezier(0.22,1,0.36,1). The scrim fades in
        // lockstep and the content inside staggers up in waves separately
        // (BoardDetailPanel's own `entered` state).
        className={`fixed inset-y-0 right-0 z-40 w-[min(684px,92vw)] bg-surface border-l border-border shadow-[-16px_0_48px_rgba(0,0,0,0.12)] transition-transform duration-[320ms] [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] will-change-transform ${
          entered ? "translate-x-0" : "translate-x-[102%]"
        }`}
      >
        <BoardDetailPanel job={job} onClose={onClose} onPatchJob={onPatchJob} />
      </div>
    </>,
    document.body,
  );
}
