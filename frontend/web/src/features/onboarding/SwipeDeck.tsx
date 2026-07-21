"use client";

/**
 * SwipeDeck — a one-card-at-a-time deck for reference content.
 *
 * Navigate by touch swipe, the side arrows, the dot row, or the ← → keys.
 * Each card renders only when active (so its height adapts to its content) and
 * scrolls internally if it's taller than the viewport cap. Card bodies are
 * server-rendered nodes handed in via props.
 */

import { useRef, useState, type ReactNode, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "@/components/ui";

export interface DeckCard {
  id: string;
  title: string;
  body: ReactNode;
}

export function SwipeDeck({ cards }: { cards: DeckCard[] }) {
  const [i, setI] = useState(0);
  const n = cards.length;
  const startX = useRef<number | null>(null);

  const go = (next: number) => setI(Math.min(Math.max(next, 0), n - 1));

  const onPointerDown = (e: PointerEvent) => { startX.current = e.clientX; };
  const onPointerEnd = (e: PointerEvent) => {
    if (startX.current === null) return;
    const dx = e.clientX - startX.current;
    startX.current = null;
    if (dx > 50) go(i - 1);
    else if (dx < -50) go(i + 1);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft")  { e.preventDefault(); go(i - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); go(i + 1); }
  };

  const card = cards[i];

  return (
    <div className="w-full max-w-2xl mx-auto" role="group" aria-roledescription="carousel" aria-label="How it works">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-title font-semibold text-text">{card.title}</h2>
        <span className="text-label text-text-3 tabular-nums">{i + 1} / {n}</span>
      </div>

      {/* Card with flanking arrows */}
      <div className="flex items-stretch gap-2 sm:gap-3 outline-none" tabIndex={0} onKeyDown={onKeyDown}>
        <IconButton
          onClick={() => go(i - 1)}
          disabled={i === 0}
          aria-label="Previous card"
          variant="outline"
          size="lg"
          shape="circle"
          className="self-center"
          icon={<ChevronLeft className="w-5 h-5" />}
        />

        <div
          className="flex-1 min-w-0 overflow-hidden"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerEnd}
          onPointerCancel={() => { startX.current = null; }}
          style={{ touchAction: "pan-y" }}
        >
          <div
            key={card.id}
            className="anim-in bg-surface border border-border rounded-lg p-5 min-h-[300px] max-h-[68vh] overflow-y-auto"
          >
            {card.body}
          </div>
        </div>

        <IconButton
          onClick={() => go(i + 1)}
          disabled={i === n - 1}
          aria-label="Next card"
          variant="outline"
          size="lg"
          shape="circle"
          className="self-center"
          icon={<ChevronRight className="w-5 h-5" />}
        />
      </div>

      {/* Dots */}
      <div className="flex items-center justify-center gap-1.5 mt-4">
        {cards.map((c, idx) => (
          <button key={c.id} onClick={() => go(idx)} aria-label={`Go to: ${c.title}`} aria-current={idx === i} className={ "h-2 rounded-full transition-all " + (idx === i ? "w-5 bg-[var(--brand)]" : "w-2 bg-border hover:bg-text-3") } />
        ))}
      </div>

      <p className="text-center text-caption text-text-3 mt-2">Swipe, use the arrows, or press ← →</p>
    </div>
  );
}
