"use client";

import { useEffect, useRef, useState } from "react";
import { visaKey, VISA_COLOR, VISA_LABEL } from "@/lib/smartFeedUtils";
import type { BoardJob } from "../lib/jobFilters";

export function DistanceRibbon({ jobs, maxKm, range, onRangeChange, onJobClick }: {
  jobs: BoardJob[];
  maxKm: number;
  range: [number, number];
  onRangeChange: (r: [number, number]) => void;
  onJobClick: (id: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<"min" | "max" | null>(null);

  const [localRange, setLocalRange] = useState<[number, number]>(range);
  const localRangeRef = useRef(localRange);
  useEffect(() => { localRangeRef.current = localRange; }, [localRange]);

  const [prevRange, setPrevRange]       = useState(range);
  const [prevDragging, setPrevDragging] = useState(dragging);
  if (prevRange !== range || prevDragging !== dragging) {
    setPrevRange(range);
    setPrevDragging(dragging);
    if (!dragging) setLocalRange(range);
  }

  const tickStep = maxKm <= 60 ? 10 : maxKm <= 200 ? 25 : 50;
  const ticks = Array.from(
    { length: Math.floor(maxKm / tickStep) + 1 },
    (_, i) => i * tickStep,
  );

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent | TouchEvent) {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const km = Math.round(pct * maxKm);
      const [lo, hi] = localRangeRef.current;
      if (dragging === "min") setLocalRange([Math.min(km, hi - 1), hi]);
      else                    setLocalRange([lo, Math.max(km, lo + 1)]);
    }
    function onUp() {
      setDragging(null);
      onRangeChange(localRangeRef.current);
    }
    window.addEventListener("mousemove",  onMove);
    window.addEventListener("mouseup",    onUp);
    window.addEventListener("touchmove",  onMove);
    window.addEventListener("touchend",   onUp);
    return () => {
      window.removeEventListener("mousemove",  onMove);
      window.removeEventListener("mouseup",    onUp);
      window.removeEventListener("touchmove",  onMove);
      window.removeEventListener("touchend",   onUp);
    };
  }, [dragging, maxKm, onRangeChange]);

  const displayRange = dragging ? localRange : range;
  const rangeActive  = displayRange[0] > 0 || displayRange[1] < maxKm;

  return (
    <div className="rounded-md border border-border bg-[var(--surface-2)] p-4">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-[11px] font-semibold text-text-2 uppercase tracking-wider">
          Distance from home
          {rangeActive && (
            <span className="text-text font-normal normal-case ml-1">
              · {displayRange[0]}–{displayRange[1]} km
              <button
                onClick={() => onRangeChange([0, maxKm])}
                className="ml-1 text-[var(--brand)] hover:underline"
              >clear</button>
            </span>
          )}
        </p>
        <div className="flex items-center gap-3 text-[10px] text-text-2">
          <Legend color={VISA_COLOR.yes}     label="Sponsored" />
          <Legend color={VISA_COLOR.unknown} label="Unknown" />
          <Legend color={VISA_COLOR.pr_only} label="PR only" />
          <Legend color={VISA_COLOR.no}      label="No sponsor" />
        </div>
      </div>

      <div ref={trackRef} className="relative h-14 select-none">
        <div className="absolute left-0 right-0 top-7 h-px bg-border" />
        <div
          className="absolute top-[26px] h-[3px] bg-[var(--brand)]/40 rounded"
          style={{
            left:  `${(displayRange[0] / maxKm) * 100}%`,
            width: `${((displayRange[1] - displayRange[0]) / maxKm) * 100}%`,
          }}
        />
        {ticks.map((t) => (
          <div key={t} className="absolute top-7" style={{ left: `${(t / maxKm) * 100}%` }}>
            <div className="w-px h-1.5 bg-border" />
            <div className="text-[9px] text-text-3 mt-1 -translate-x-1/2 whitespace-nowrap">{t} km</div>
          </div>
        ))}
        {jobs.filter((j) => j.distance_km != null).map((j, i) => {
          const km = j.distance_km as number;
          const x = (Math.min(km, maxKm) / maxKm) * 100;
          const y = 28 + ((i % 3) - 1) * 3;
          const muted = km < displayRange[0] || km > displayRange[1];
          const vk = visaKey(j);
          return (
            <button
              key={j.id}
              type="button"
              onClick={() => onJobClick(j.id)}
              title={`${j.title}\n${j.company ?? "—"} · ${j.location} · ${km.toFixed(1)} km · ${VISA_LABEL[vk]}`}
              className="absolute w-2.5 h-2.5 rounded-full hover:scale-150 transition-all shadow-sm"
              style={{
                left: `calc(${x}% - 5px)`,
                top:  `${y - 5}px`,
                background: VISA_COLOR[vk],
                borderColor: "white",
                borderWidth: 1,
                borderStyle: "solid",
                opacity: muted ? 0.25 : 1,
              }}
            />
          );
        })}
        <RangeHandle pos={(displayRange[0] / maxKm) * 100} onStart={() => setDragging("min")} label={`${displayRange[0]} km`} />
        <RangeHandle pos={(displayRange[1] / maxKm) * 100} onStart={() => setDragging("max")} label={`${displayRange[1]} km`} />
      </div>
    </div>
  );
}

function RangeHandle({ pos, onStart, label }: { pos: number; onStart: () => void; label: string }) {
  return (
    <button
      type="button"
      title={`Drag — ${label}`}
      onMouseDown={onStart}
      onTouchStart={onStart}
      className="absolute top-[20px] w-3 h-3 rounded-sm bg-white border-2 border-[var(--brand)] cursor-ew-resize hover:scale-125 transition-transform shadow"
      style={{ left: `calc(${pos}% - 6px)` }}
    />
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
