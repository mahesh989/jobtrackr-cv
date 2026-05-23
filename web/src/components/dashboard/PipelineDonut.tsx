"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

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

// ─── Lens config ──────────────────────────────────────────────────────────────

interface SliceMeta { label: string; color: string }
interface LensMeta {
  label: string;
  centerLabel: string;
  slices: [SliceMeta, SliceMeta, SliceMeta];
}

const LENS_META: Record<LensKey, LensMeta> = {
  sourcing: {
    label: "Sourcing",
    centerLabel: "fetched",
    slices: [
      { label: "Saved",        color: "#34d399" },
      { label: "Duplicates",   color: "#94a3b8" },
      { label: "Filtered out", color: "#fb923c" },
    ],
  },
  jd: {
    label: "JD readiness",
    centerLabel: "jobs",
    slices: [
      { label: "Full JD",      color: "#34d399" },
      { label: "Thin JD",      color: "#fb923c" },
      { label: "Unclassified", color: "#94a3b8" },
    ],
  },
  analysis: {
    label: "Analysis",
    centerLabel: "saved",
    slices: [
      { label: "Complete",     color: "#34d399" },
      { label: "CV only",      color: "#60a5fa" },
      { label: "Not tailored", color: "#94a3b8" },
    ],
  },
  ats: {
    label: "ATS gates",
    centerLabel: "analysed",
    slices: [
      { label: "Above final",   color: "#34d399" },
      { label: "Below final",   color: "#f59e0b" },
      { label: "Below initial", color: "#ef4444" },
    ],
  },
  applied: {
    label: "Applied",
    centerLabel: "applied",
    slices: [
      { label: "Applied",        color: "#ec4899" },
      { label: "Ready to apply", color: "#60a5fa" },
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

export function PipelineDonut({ data }: { data: PipelineLensData }) {
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
    const meta = LENS_META[lensRef.current];
    const hi   = hovRef.current;
    const val  = Math.round(dCenter.current);
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
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.scale(dpr, dpr);

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
    tFracs.current  = toFracs(getTotals(data, lens));
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

  const meta   = LENS_META[activeLens];
  const counts = getTotals(data, activeLens);
  const total  = counts[0] + counts[1] + counts[2];

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
          {meta.slices.map((s, i) => {
            const n   = counts[i];
            const pct = total > 0 ? Math.round((n / total) * 100) : 0;
            return (
              <div
                key={i}
                role="button"
                tabIndex={0}
                onClick={() => setPopup(i)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setPopup(i)}
                className="flex items-center gap-2 cursor-pointer group rounded px-1 py-0.5 hover:bg-[var(--surface-2)] transition-colors"
              >
                <span className="w-2.5 h-2.5 rounded-full shrink-0 transition-transform group-hover:scale-125" style={{ background: s.color }} />
                <span className="text-[12px] text-text truncate flex-1">{s.label}</span>
                <span className="text-[13px] font-semibold text-text shrink-0">{n.toLocaleString()}</span>
                <span className="text-[10px] text-text-3 w-7 text-right shrink-0">{pct}%</span>
              </div>
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
            <Link
              href="/dashboard?triage=thinJd"
              className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-amber-600 hover:text-amber-700 transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
              {counts[1]} thin JD{counts[1] > 1 ? "s" : ""} — paste full text to unlock analysis
            </Link>
          )}
        </div>
      </div>

      {/* Callout strip */}
      {(data.callouts.thinJdCount > 0 || data.callouts.passedButNoLetter > 0 || data.callouts.readyToApply > 0) && (
        <div className="flex flex-wrap gap-2 px-5 pb-4 pt-1 border-t border-border">
          {data.callouts.thinJdCount > 0 && (
            <Link href="/dashboard?triage=thinJd" className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 transition-colors">
              ⚠ {data.callouts.thinJdCount} thin JD{data.callouts.thinJdCount > 1 ? "s" : ""} need attention
            </Link>
          )}
          {data.callouts.passedButNoLetter > 0 && (
            <Link href="/dashboard?stage=cvReady" className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors">
              → {data.callouts.passedButNoLetter} passed ATS, no letter yet
            </Link>
          )}
          {data.callouts.readyToApply > 0 && (
            <Link href="/dashboard/applications" className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-pink-50 border border-pink-200 text-pink-700 hover:bg-pink-100 transition-colors">
              ✓ {data.callouts.readyToApply} ready to apply
            </Link>
          )}
        </div>
      )}

      {popup !== null && (
        <DonutPopup mode={popup} lens={activeLens} data={data} onClose={() => setPopup(null)} />
      )}
    </div>
  );
}

// ─── Popup ────────────────────────────────────────────────────────────────────

function DonutPopup({
  mode, lens, data, onClose,
}: {
  mode: "center" | number;
  lens: LensKey;
  data: PipelineLensData;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  const meta     = LENS_META[lens];
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

        {/* Profile filter */}
        {allProfs.length > 1 && (
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
            ? profs.map((p) => <StackedBar key={p.profileId} profile={p} meta={meta} />)
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

        {/* CTAs */}
        {lens === "jd" && mode === 1 && data.jd.totals[1] > 0 && (
          <div className="px-5 py-3 border-t border-border shrink-0">
            <Link href="/dashboard?triage=thinJd" onClick={onClose} className="gh-btn gh-btn-blue text-[12px] w-full justify-center">
              View {data.jd.totals[1]} thin JD job{data.jd.totals[1] > 1 ? "s" : ""} →
            </Link>
          </div>
        )}
        {lens === "applied" && (mode === 0 || mode === "center") && (
          <div className="px-5 py-3 border-t border-border shrink-0">
            <Link href="/dashboard/applications?status=sent" onClick={onClose} className="gh-btn gh-btn-blue text-[12px] w-full justify-center">
              View applied jobs →
            </Link>
          </div>
        )}
        {lens === "applied" && mode === 1 && (
          <div className="px-5 py-3 border-t border-border shrink-0">
            <Link href="/dashboard/applications" onClick={onClose} className="gh-btn gh-btn-blue text-[12px] w-full justify-center">
              View ready to apply →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function StackedBar({ profile, meta }: { profile: ProfileCount; meta: LensMeta }) {
  const total = profile.counts[0] + profile.counts[1] + profile.counts[2];
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1.5">
        <span className="text-[13px] font-medium text-text truncate pr-2">{profile.profileName}</span>
        <span className="text-[12px] text-text-2 shrink-0">{total}</span>
      </div>
      <div className="h-5 w-full rounded-md overflow-hidden flex bg-[var(--surface-2)]">
        {meta.slices.map((s, i) => {
          const pct = total > 0 ? (profile.counts[i] / total) * 100 : 33;
          return (
            <div key={i} style={{ width: `${pct}%`, background: s.color }} title={`${s.label}: ${profile.counts[i]}`} />
          );
        })}
      </div>
      <div className="flex gap-3 mt-1.5">
        {meta.slices.map((s, i) => (
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
