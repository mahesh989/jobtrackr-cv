"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { shallowSetParams } from "../jobs/shallowNav";

/**
 * Renders a donut filter target as an instant client-side filter (button +
 * History API) on the dashboard board, or a normal <Link> elsewhere / for
 * cross-route destinations.
 */
function FilterAnchor({
  href, shallow, apply, className, onClick, children,
}: {
  href: string;
  shallow: boolean;
  apply?: (href: string) => void;
  className: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const internal = href.startsWith("/dashboard?");
  if (shallow && internal && apply) {
    return (
      <button
        type="button"
        onClick={() => { onClick?.(); apply(href); }}
        className={className}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
          textAlign: "left",
          width: "100%",
          color: "inherit",
          cursor: "pointer",
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <Link
      href={href}
      scroll={!internal}
      onClick={onClick}
      className={className}
      style={{
        width: "100%",
        color: "inherit",
        textDecoration: "none",
      }}
    >
      {children}
    </Link>
  );
}

// View-filter params the donut can set; cleared before applying a new one so
// the chosen slice is shown cleanly (dataset filters like location are kept).
const DONUT_VIEW_KEYS = ["stage", "triage", "ats", "status", "chips"];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProfileCount {
  profileId: string;
  profileName: string;
  counts: [number, number, number];
}

export interface PipelineLensData {
  sourcing: {
    fetched: number;
    totals: [number, number, number]; // saved · dupes · filtered-out
    byProfile: Array<ProfileCount & { sourcesSaved: Record<string, number> }>;
  };
  jd: {
    totals: [number, number, number]; // full · thin · unknown
    byProfile: ProfileCount[];
  };
  analysis: {
    totals: [number, number, number]; // complete(CV+letter) · cvOnly · notTailored
    avgAtsLift: number | null;
    byProfile: ProfileCount[];
  };
  ats: {
    totals: [number, number, number]; // aboveFinal · belowFinal · belowInitial
    byProfile: ProfileCount[];
    thresholds: { initial: number; final: number }; // drive the gate labels
  };
  applied: {
    totals: [number, number, number]; // applied · readyToApply · notYet
    byProfile: ProfileCount[];
  };
  callouts: {
    thinJdCount: number;
    passedButNoLetter: number;
    readyToApply: number;
  };
}

type LensKey = "sourcing" | "jd" | "analysis" | "ats" | "applied";

/**
 * Resolve a lens's metadata, injecting the user's live ATS thresholds into the
 * gate labels (e.g. "Above final (≥ 70)", "Below final (50–69)", "< 50").
 */
function resolveLensMeta(lens: LensKey, t: { initial: number; final: number }): LensMeta {
  if (lens !== "ats") return LENS_META[lens];
  return {
    ...LENS_META.ats,
    slices: [
      { label: `Above final (≥ ${t.final})`, color: "#34d399" },
      { label: `Below final (${t.initial}–${t.final - 1})`, color: "#f59e0b", href: "/dashboard?triage=belowThreshold" },
      { label: `Below initial (< ${t.initial})`, color: "#ef4444", href: "/dashboard?triage=belowThreshold" },
    ],
  };
}

// ─── Lens config ──────────────────────────────────────────────────────────────

interface SliceMeta { label: string; color: string; href?: string }
interface LensMeta {
  label: string;
  centerLabel: string;
  slices: [SliceMeta, SliceMeta, SliceMeta];
  /** How many of the 3 slices to actually show (default 3). The Applied lens
      uses 2 — the third ("Not yet") is noise and dwarfs the rest. */
  visibleSlices?: number;
}

/** Visible slice count for a lens (defaults to all 3). */
function visN(meta: LensMeta): number {
  return meta.visibleSlices ?? 3;
}

const LENS_META: Record<LensKey, LensMeta> = {
  sourcing: {
    label: "Sourcing",
    centerLabel: "fetched",
    slices: [
      { label: "Saved",         color: "#34d399" },
      { label: "Duplicates",    color: "#94a3b8" },
      { label: "Filtered out",  color: "#fb923c" },
    ],
  },
  jd: {
    label: "JD readiness",
    centerLabel: "jobs",
    slices: [
      { label: "Full JD",      color: "#34d399", href: "/dashboard?triage=richJd" },
      { label: "Thin JD",      color: "#fb923c", href: "/dashboard?triage=thinJd" },
      { label: "Unclassified", color: "#94a3b8" },
    ],
  },
  analysis: {
    label: "Analysis",
    centerLabel: "saved",
    slices: [
      { label: "Complete",     color: "#34d399", href: "/dashboard?stage=letterReady" },
      { label: "CV only",      color: "#60a5fa", href: "/dashboard?stage=cvReady" },
      { label: "Not tailored", color: "#94a3b8" },
    ],
  },
  ats: {
    label: "ATS gates",
    centerLabel: "analysed",
    // Placeholder labels — resolveLensMeta() overrides these with the user's
    // actual thresholds at render time.
    slices: [
      { label: "Above final",  color: "#34d399" },
      { label: "Below final",  color: "#f59e0b", href: "/dashboard?triage=belowThreshold" },
      { label: "Below initial", color: "#ef4444", href: "/dashboard?triage=belowThreshold" },
    ],
  },
  applied: {
    label: "Applied",
    centerLabel: "applied",
    visibleSlices: 2,
    slices: [
      { label: "Applied",        color: "#ec4899", href: "/dashboard/applications?status=sent" },
      { label: "Ready to apply", color: "#60a5fa", href: "/dashboard/applications" },
      { label: "Not yet",        color: "#94a3b8" },
    ],
  },
};

const LENSES: LensKey[] = ["sourcing", "jd", "analysis", "ats", "applied"];

// ─── Canvas constants ─────────────────────────────────────────────────────────

const C  = 240;      // CSS size
const CX = 120;      // center x
const CY = 120;      // center y
const OR = 100;      // outer radius
const IR = 58;       // inner radius
const GAP = 0.04;    // gap between slices (radians)
const HOVER_LIFT = 7;
const ANIM_MS = 420;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function ease(t: number) { return 1 - Math.pow(1 - t, 3); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function toFracs(c: [number, number, number]): [number, number, number] {
  const s = c[0] + c[1] + c[2];
  return s === 0 ? [1 / 3, 1 / 3, 1 / 3] : [c[0] / s, c[1] / s, c[2] / s];
}

/**
 * Like toFracs but only counts the first `n` slices — the rest get frac 0 so
 * the donut ring and hit detection ignore them (used by lenses that hide a
 * slice, e.g. Applied hides "Not yet").
 */
function toFracsN(c: [number, number, number], n: number): [number, number, number] {
  if (n >= 3) return toFracs(c);
  const vis = c.slice(0, n);
  const s = vis.reduce((a, b) => a + b, 0);
  const out: [number, number, number] = [0, 0, 0];
  if (s === 0) { for (let i = 0; i < n; i++) out[i] = 1 / n; return out; }
  for (let i = 0; i < n; i++) out[i] = c[i] / s;
  return out;
}

function cssVar(name: string, fb: string) {
  if (typeof window === "undefined") return fb;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

function getTotals(data: PipelineLensData, lens: LensKey): [number, number, number] {
  return data[lens].totals;
}

function centerTarget(data: PipelineLensData, lens: LensKey): number {
  if (lens === "sourcing") return data.sourcing.fetched;
  if (lens === "applied")  return data.applied.totals[0];
  const t = data[lens].totals;
  return t[0] + t[1] + t[2];
}

function pillCount(data: PipelineLensData, lens: LensKey): number {
  if (lens === "sourcing") return data.sourcing.totals[0];
  if (lens === "applied")  return data.applied.totals[0];
  const t = data[lens].totals;
  return t[0] + t[1] + t[2];
}

// ─── Canvas draw ──────────────────────────────────────────────────────────────

function paint(
  canvas: HTMLCanvasElement,
  fracs: [number, number, number],
  colors: [string, string, string],
  hovered: number | null,
  centerVal: number,
  centerLabel: string,
  centerColor: string,
) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, C * dpr, C * dpr);
  ctx.save();
  ctx.scale(dpr, dpr);

  const hasData = fracs[0] + fracs[1] + fracs[2] > 0.01;

  if (!hasData) {
    ctx.beginPath();
    ctx.arc(CX, CY, OR, 0, Math.PI * 2);
    ctx.arc(CX, CY, IR, Math.PI * 2, 0, true);
    ctx.fillStyle = cssVar("--border", "#e2e8f0");
    ctx.fill();
  } else {
    let angle = -Math.PI / 2;
    fracs.forEach((frac, i) => {
      if (frac < 0.002) { angle += frac * Math.PI * 2; return; }
      const sweep   = Math.max(0, frac * Math.PI * 2 - GAP);
      const mid     = angle + GAP / 2 + sweep / 2;
      const isHov   = hovered === i;
      const ox = isHov ? HOVER_LIFT * Math.cos(mid) : 0;
      const oy = isHov ? HOVER_LIFT * Math.sin(mid) : 0;

      ctx.save();
      ctx.globalAlpha = hovered !== null && !isHov ? 0.45 : 1;
      ctx.beginPath();
      ctx.arc(CX + ox, CY + oy, OR, angle + GAP / 2, angle + GAP / 2 + sweep);
      ctx.arc(CX + ox, CY + oy, IR, angle + GAP / 2 + sweep, angle + GAP / 2, true);
      ctx.closePath();
      ctx.fillStyle = colors[i];
      ctx.fill();
      ctx.restore();
      angle += frac * Math.PI * 2;
    });
  }

  // Center text
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 30px system-ui,-apple-system,sans-serif`;
  ctx.fillStyle = centerColor;
  ctx.fillText(centerVal.toLocaleString(), CX, CY - 10);
  ctx.font = `400 11px system-ui,-apple-system,sans-serif`;
  ctx.fillStyle = cssVar("--text-2", "#64748b");
  ctx.fillText(centerLabel, CX, CY + 12);

  ctx.restore();
}

// ─── Hit detection ────────────────────────────────────────────────────────────

function hitSlice(mx: number, my: number, fracs: [number, number, number]): number | null {
  const dx = mx - CX, dy = my - CY;
  const r  = Math.hypot(dx, dy);
  if (r < IR - 6 || r > OR + 8) return null;
  let ang = Math.atan2(dy, dx) + Math.PI / 2;
  if (ang < 0) ang += Math.PI * 2;
  if (ang >= Math.PI * 2) ang -= Math.PI * 2;
  let cur = 0;
  for (let i = 0; i < 3; i++) {
    const sw = fracs[i] * Math.PI * 2;
    if (ang >= cur && ang < cur + sw) return i;
    cur += sw;
  }
  return null;
}

function hitCenter(mx: number, my: number) {
  return Math.hypot(mx - CX, my - CY) < IR;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PipelineDonut({ data, shallow = false }: { data: PipelineLensData; shallow?: boolean }) {
  const pathname = usePathname();
  const sp       = useSearchParams();

  // Dashboard board: apply a donut filter instantly client-side (History API)
  // + scroll to the results, instead of a full server navigation.
  function applyFilter(href: string) {
    try {
      const u = new URL(href, window.location.origin);
      const params = new URLSearchParams(sp.toString());
      DONUT_VIEW_KEYS.forEach((k) => params.delete(k));
      u.searchParams.forEach((val, key) => params.set(key, val));
      shallowSetParams(pathname, params);
      document.getElementById("jobs-board")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch { /* noop */ }
  }

  const [activeLens, setActiveLens] = useState<LensKey>("sourcing");
  const [hovered,    setHovered]    = useState<number | null>(null);
  const [popup,      setPopup]      = useState<"center" | number | null>(null);

  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const dFracs       = useRef<[number, number, number]>([1 / 3, 1 / 3, 1 / 3]);
  const tFracs       = useRef<[number, number, number]>([1 / 3, 1 / 3, 1 / 3]);
  const dCenter      = useRef(0);
  const tCenter      = useRef(0);
  const fromFracs    = useRef<[number, number, number]>([1 / 3, 1 / 3, 1 / 3]);
  const fromCenter   = useRef(0);
  const animStart    = useRef(0);
  const raf          = useRef(0);
  const hovRef       = useRef<number | null>(null);
  const lensRef      = useRef<LensKey>("sourcing");

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const meta = resolveLensMeta(lensRef.current, data.ats.thresholds);
    const hi   = hovRef.current;
    const val  = hi !== null
      ? getTotals(data, lensRef.current)[hi]
      : Math.round(dCenter.current);
    const lbl  = hi !== null ? meta.slices[hi].label : meta.centerLabel;
    const col  = hi !== null ? meta.slices[hi].color : cssVar("--text", "#1e293b");
    paint(canvas, dFracs.current, meta.slices.map(s => s.color) as [string, string, string], hi, val, lbl, col);
  }

  // Mount — init canvas DPR + draw initial state
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width        = C * dpr;
    canvas.height       = C * dpr;
    canvas.style.width  = `${C}px`;
    canvas.style.height = `${C}px`;
    const f = toFracs(data.sourcing.totals);
    const c = data.sourcing.fetched;
    dFracs.current = tFracs.current = f;
    dCenter.current = tCenter.current = c;
    draw();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function runAnim() {
    fromFracs.current  = [...dFracs.current] as [number, number, number];
    fromCenter.current = dCenter.current;
    animStart.current  = performance.now();
    cancelAnimationFrame(raf.current);
    function frame(now: number) {
      const t = Math.min(ease((now - animStart.current) / ANIM_MS), 1);
      dFracs.current  = lerp3(fromFracs.current, tFracs.current, t);
      dCenter.current = lerp(fromCenter.current, tCenter.current, t);
      draw();
      if (t < 1) raf.current = requestAnimationFrame(frame);
    }
    raf.current = requestAnimationFrame(frame);
  }

  function switchLens(lens: LensKey) {
    if (lens === activeLens) return;
    lensRef.current = lens;
    setActiveLens(lens);
    hovRef.current = null;
    setHovered(null);
    tFracs.current  = toFracsN(getTotals(data, lens), visN(LENS_META[lens]));
    tCenter.current = centerTarget(data, lens);
    runAnim();
  }

  function xy(e: React.MouseEvent<HTMLCanvasElement>): [number, number] {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const [mx, my] = xy(e);
    const hit = hitSlice(mx, my, dFracs.current);
    if (hit !== hovRef.current) { hovRef.current = hit; setHovered(hit); draw(); }
  }

  function onMouseLeave() {
    if (hovRef.current !== null) { hovRef.current = null; setHovered(null); draw(); }
  }

  function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const [mx, my] = xy(e);
    const hit = hitSlice(mx, my, dFracs.current);
    if (hit !== null) { setPopup(hit); return; }
    if (hitCenter(mx, my)) setPopup("center");
  }

  const meta   = resolveLensMeta(activeLens, data.ats.thresholds);
  const counts = getTotals(data, activeLens);
  const vis    = visN(meta);
  const total  = counts.slice(0, vis).reduce((a, b) => a + b, 0);

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">

      {/* Lens pills */}
      <div className="flex gap-1.5 px-5 pt-4 pb-3 border-b border-border overflow-x-auto">
        {LENSES.map((lens) => {
          const lm  = LENS_META[lens];
          const cnt = pillCount(data, lens);
          const on  = activeLens === lens;
          return (
            <button
              key={lens}
              onClick={() => switchLens(lens)}
              className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium transition-all ${
                on
                  ? "bg-[var(--brand)] text-[var(--brand-fg)]"
                  : "bg-[var(--surface-2)] border border-[var(--border)] text-text-2 hover:text-text"
              }`}
            >
              {lm.label}
              <span className={`text-[10px] min-w-[16px] h-4 px-1 rounded-full inline-flex items-center justify-center font-bold ${
                on ? "bg-white/20 text-[var(--brand-fg)]" : "bg-[var(--border)] text-text-3"
              }`}>{cnt}</span>
            </button>
          );
        })}
      </div>

      {/* Donut + legend */}
      <div className="flex gap-6 px-5 py-5 items-center">
        <div className="shrink-0">
          <canvas
            ref={canvasRef}
            className="block cursor-pointer"
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
            onClick={onClick}
          />
          <p className="text-[10px] text-text-3 text-center mt-1">click to explore</p>
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          <p className="text-[10px] font-semibold text-text-3 uppercase tracking-wider mb-3">Breakdown</p>
          {meta.slices.slice(0, vis).map((s, i) => {
            const n   = counts[i];
            const pct = total > 0 ? Math.round((n / total) * 100) : 0;
            const cls = "flex items-center gap-2 cursor-pointer group rounded px-1 py-0.5 hover:bg-[var(--surface-2)] transition-colors";
            const inner = (
              <>
                <span className="w-2.5 h-2.5 rounded-full shrink-0 transition-transform group-hover:scale-125" style={{ background: s.color }} />
                <span className="text-[12px] text-text truncate flex-1">{s.label}</span>
                <span className="text-[13px] font-semibold text-text w-12 text-right shrink-0 tabular-nums">{n.toLocaleString()}</span>
                <span className="text-[10px] text-text-3 w-9 text-right shrink-0 tabular-nums">{pct}%</span>
                {/* Trailing spacer pulls the number + % column ~40% in from the
                    right edge so it reads closer to the labels. Fixed-width
                    right-aligned number/pct keep every row in a clean column —
                    same treatment across all lens tabs. */}
                <span aria-hidden className="shrink-0 w-[40%]" />
              </>
            );
            return s.href ? (
              <FilterAnchor key={i} href={s.href} shallow={shallow} apply={applyFilter} className={cls}>{inner}</FilterAnchor>
            ) : (
              <div
                key={i}
                role="button"
                tabIndex={0}
                onClick={() => setPopup(i)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setPopup(i)}
                className={cls}
              >{inner}</div>
            );
          })}

          {/* ATS lift — Analysis lens */}
          {activeLens === "analysis" && (data.analysis.avgAtsLift ?? 0) > 0 && (
            <div className="mt-3 px-3 py-2 rounded-md bg-[var(--surface-2)] border border-[var(--border)]">
              <p className="text-[10px] text-text-3 uppercase tracking-wide mb-0.5">Avg ATS lift from tailoring</p>
              <p className="text-[22px] font-bold leading-none" style={{ color: "#34d399" }}>
                +{data.analysis.avgAtsLift}
                <span className="text-[12px] font-normal text-text-2 ml-1">pts</span>
              </p>
            </div>
          )}

          {/* Thin JD nudge — JD lens */}
          {activeLens === "jd" && counts[1] > 0 && (
            <FilterAnchor
              href="/dashboard?triage=thinJd"
              shallow={shallow}
              apply={applyFilter}
              className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-amber-600 hover:text-amber-700 transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
              {counts[1]} thin JD{counts[1] > 1 ? "s" : ""} — paste full text to unlock analysis
            </FilterAnchor>
          )}
        </div>
      </div>

      {/* Callout strip — single horizontal line, scrolls on narrow screens
          rather than wrapping (keeps the three counters visually grouped). */}
      {(data.callouts.thinJdCount > 0 || data.callouts.passedButNoLetter > 0 || data.callouts.readyToApply > 0) && (
        <div className="flex flex-nowrap items-center gap-2 px-5 pb-4 pt-1 border-t border-border overflow-x-auto whitespace-nowrap">
          {data.callouts.thinJdCount > 0 && (
            <FilterAnchor href="/dashboard?triage=thinJd" shallow={shallow} apply={applyFilter} className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 transition-colors">
              ⚠ {data.callouts.thinJdCount} thin JD{data.callouts.thinJdCount > 1 ? "s" : ""} need attention
            </FilterAnchor>
          )}
          {data.callouts.passedButNoLetter > 0 && (
            // Routes to the dedicated triage filter that mirrors the count
            // exactly (atsBand=above_final AND no cover letter AND not
            // applied). Previously linked to stage=cvReady, which also
            // surfaced 60–69 ATS jobs and jobs that already had a letter,
            // so the count and the destination disagreed.
            <FilterAnchor href="/dashboard?triage=passedNoLetter" shallow={shallow} apply={applyFilter} className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors">
              → {data.callouts.passedButNoLetter} passed ATS, no letter yet
            </FilterAnchor>
          )}
          {data.callouts.readyToApply > 0 && (
            <Link href="/dashboard/applications" className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-pink-50 border border-pink-200 text-pink-700 hover:bg-pink-100 transition-colors">
              ✓ {data.callouts.readyToApply} ready to apply
            </Link>
          )}
        </div>
      )}

      {popup !== null && (
        <DonutPopup mode={popup} lens={activeLens} data={data} shallow={shallow} apply={applyFilter} onClose={() => setPopup(null)} />
      )}
    </div>
  );
}

// ─── Popup ────────────────────────────────────────────────────────────────────

function DonutPopup({
  mode, lens, data, onClose, shallow = false, apply,
}: {
  mode: "center" | number;
  lens: LensKey;
  data: PipelineLensData;
  onClose: () => void;
  shallow?: boolean;
  apply?: (href: string) => void;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  const meta     = resolveLensMeta(lens, data.ats.thresholds);
  const vis      = visN(meta);
  const allProfs = data[lens].byProfile as ProfileCount[];
  const profs    = filter ? allProfs.filter((p) => p.profileId === filter) : allProfs;
  const title    = mode === "center"
    ? `${meta.label} — all profiles`
    : `${meta.slices[mode as number].label} — by profile`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <p className="text-[10px] text-text-3 uppercase tracking-wide">{meta.label}</p>
            <h3 className="text-[15px] font-semibold text-text">{title}</h3>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-full flex items-center justify-center text-text-2 hover:text-text hover:bg-[var(--surface-2)] transition-colors text-[18px] leading-none"
          >×</button>
        </div>

        {/* Profile filter — only on Sourcing. Other lenses show the All view
            (every profile listed) without the per-profile narrowing chips. */}
        {lens === "sourcing" && allProfs.length > 1 && (
          <div className="flex gap-1.5 px-5 py-2.5 border-b border-border overflow-x-auto shrink-0">
            {([{ profileId: null, profileName: "All" }, ...allProfs] as Array<{ profileId: string | null; profileName: string }>).map((p) => (
              <button
                key={p.profileId ?? "_all"}
                onClick={() => setFilter(p.profileId)}
                className={`shrink-0 px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
                  filter === p.profileId
                    ? "bg-[var(--brand)] text-[var(--brand-fg)]"
                    : "bg-[var(--surface-2)] border border-[var(--border)] text-text-2 hover:text-text"
                }`}
              >
                {p.profileName}
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
          {profs.length === 0 && (
            <p className="text-[13px] text-text-2 text-center py-8">No data yet</p>
          )}
          {mode === "center"
            ? profs.map((p) => <StackedBar key={p.profileId} profile={p} meta={meta} vis={vis} />)
            : (() => {
                const idx      = mode as number;
                const maxCount = Math.max(...profs.map((p) => p.counts[idx]), 1);
                return [...profs]
                  .sort((a, b) => b.counts[idx] - a.counts[idx])
                  .map((p) => <SingleBar key={p.profileId} profile={p} sliceIdx={idx} meta={meta} maxCount={maxCount} />);
              })()
          }

          {/* Sourcing: per-source detail in the Saved slice */}
          {lens === "sourcing" && mode === 0 && (
            <SourceBreakdown data={data} filter={filter} />
          )}
        </div>

        {/* CTAs — one per lens/slice combo that has a natural destination */}
        {(() => {
          let href = "";
          let label = "";
          if (lens === "jd" && mode === 0 && data.jd.totals[0] > 0)
            { href = "/dashboard?triage=richJd"; label = "View full-JD jobs →"; }
          else if (lens === "jd" && mode === 1 && data.jd.totals[1] > 0)
            { href = "/dashboard?triage=thinJd"; label = `View ${data.jd.totals[1]} thin JD job${data.jd.totals[1] > 1 ? "s" : ""} →`; }
          else if (lens === "analysis" && mode === 0)
            { href = "/dashboard?stage=letterReady"; label = "View letter-ready jobs →"; }
          else if (lens === "analysis" && mode === 1)
            { href = "/dashboard?stage=cvReady"; label = "View CV-ready jobs →"; }
          else if (lens === "analysis" && mode === 2 && data.analysis.totals[2] > 0)
            { href = "/dashboard?triage=notTailored"; label = "View not-tailored jobs →"; }
          else if (lens === "ats" && mode === 0 && data.ats.totals[0] > 0)
            { href = "/dashboard?ats=above_final"; label = "View above-threshold jobs →"; }
          else if (lens === "ats" && (mode === 1 || mode === 2))
            { href = "/dashboard?triage=belowThreshold"; label = "View below-threshold jobs →"; }
          else if (lens === "applied" && (mode === 0 || mode === "center"))
            { href = "/dashboard/applications?status=sent"; label = "View applied jobs →"; }
          else if (lens === "applied" && mode === 1)
            { href = "/dashboard/applications"; label = "View ready to apply →"; }
          if (!href) return null;
          return (
            <div className="px-5 py-3 border-t border-border shrink-0">
              <FilterAnchor href={href} shallow={shallow} apply={apply} onClick={onClose} className="gh-btn gh-btn-blue text-[12px] w-full justify-center">
                {label}
              </FilterAnchor>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function StackedBar({ profile, meta, vis = 3 }: { profile: ProfileCount; meta: LensMeta; vis?: number }) {
  const total = profile.counts.slice(0, vis).reduce((a, b) => a + b, 0);
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1.5">
        <span className="text-[13px] font-medium text-text truncate pr-2">{profile.profileName}</span>
        <span className="text-[12px] text-text-2 shrink-0">{total}</span>
      </div>
      <div className="h-5 w-full rounded-md overflow-hidden flex bg-[var(--surface-2)]">
        {meta.slices.slice(0, vis).map((s, i) => {
          const pct = total > 0 ? (profile.counts[i] / total) * 100 : 33;
          return (
            <div key={i} style={{ width: `${pct}%`, background: s.color }} title={`${s.label}: ${profile.counts[i]}`} />
          );
        })}
      </div>
      <div className="flex gap-3 mt-1.5">
        {meta.slices.slice(0, vis).map((s, i) => (
          <span key={i} className="text-[10px] text-text-3 flex items-center gap-0.5">
            <span className="w-1.5 h-1.5 rounded-full shrink-0 inline-block" style={{ background: s.color }} />
            {s.label}: {profile.counts[i]}
          </span>
        ))}
      </div>
    </div>
  );
}

function SingleBar({
  profile, sliceIdx, meta, maxCount,
}: { profile: ProfileCount; sliceIdx: number; meta: LensMeta; maxCount: number }) {
  const count = profile.counts[sliceIdx];
  const color = meta.slices[sliceIdx].color;
  const pct   = maxCount > 0 ? (count / maxCount) * 100 : 0;
  const [w, setW] = useState(0);
  useEffect(() => { const t = window.setTimeout(() => setW(pct), 60); return () => window.clearTimeout(t); }, [pct]);
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-[13px] font-medium text-text truncate pr-2">{profile.profileName}</span>
        <span className="text-[13px] font-semibold shrink-0" style={{ color }}>{count}</span>
      </div>
      <div className="h-2.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500 ease-out" style={{ width: `${w}%`, background: color }} />
      </div>
    </div>
  );
}

function SourceBar({ src, n, max }: { src: string; n: number; max: number }) {
  const pct = (n / max) * 100;
  const [w, setW] = useState(0);
  useEffect(() => { const t = window.setTimeout(() => setW(pct), 80); return () => window.clearTimeout(t); }, [pct]);
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-[12px] font-medium text-text capitalize">{src}</span>
        <span className="text-[12px] font-semibold text-text">{n}</span>
      </div>
      <div className="h-2 bg-[var(--surface-2)] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500 ease-out bg-[#34d399]" style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

function SourceBreakdown({ data, filter }: { data: PipelineLensData; filter: string | null }) {
  const profs = filter
    ? data.sourcing.byProfile.filter((p) => p.profileId === filter)
    : data.sourcing.byProfile;

  const agg: Record<string, number> = {};
  for (const p of profs) {
    if (!p.sourcesSaved) continue;
    for (const [src, n] of Object.entries(p.sourcesSaved)) {
      agg[src] = (agg[src] ?? 0) + n;
    }
  }
  const entries = Object.entries(agg).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const max = entries[0][1];

  return (
    <div className="border-t border-border pt-4">
      <p className="text-[11px] font-semibold text-text-3 uppercase tracking-wide mb-3">Saved by source</p>
      <div className="space-y-2.5">
        {entries.map(([src, n]) => (
          <SourceBar key={src} src={src} n={n} max={max} />
        ))}
      </div>
    </div>
  );
}
