"use client";

/**
 * Score gauge — the card's ONLY score display (handoff §2.4).
 *
 * SVG ring built from three concentric strokes on one circle:
 *   · track        — `--border-muted`
 *   · initial arc  — the run's initial-ATS score, `--text-3` at 40% opacity
 *   · score arc    — the current score (tailored ?? initial), coloured by
 *                    threshold: ≥70 success (chart-pos), ≥50 warning
 *                    (chart-amber), else danger (chart-danger); applied jobs
 *                    always read success
 *
 * Centre shows the score with a `from {initial}` label beneath (or a "—"
 * dash when there is no score at all — a fresh listing has nothing to gauge).
 *
 * `compact` is the small variant for the flat Applied/Favourite rows.
 */

import { BoardJob } from "../../lib/jobFilters";

const SIZE = { card: 74, compact: 48 } as const;
const RADIUS = { card: 30, compact: 19 } as const;
const STROKE = { card: 5, compact: 4 } as const;

function arcColor(job: BoardJob, score: number): string {
  if (job.applied_at) return "var(--chart-pos)";
  if (score >= 70) return "var(--chart-pos)";
  if (score >= 50) return "var(--chart-amber)";
  return "var(--chart-danger)";
}

function arcLen(r: number, pct: number): string {
  const c = 2 * Math.PI * r;
  const len = (Math.min(100, Math.max(0, pct)) / 100) * c;
  return `${len} ${c}`;
}

export function Gauge({ job, compact = false }: { job: BoardJob; compact?: boolean }) {
  const size   = compact ? SIZE.compact : SIZE.card;
  const r      = compact ? RADIUS.compact : RADIUS.card;
  const stroke = compact ? STROKE.compact : STROKE.card;
  const cx     = size / 2;

  const score   = job.tailored_match_score ?? job.initial_ats_score ?? null;
  const initial = job.initial_ats_score ?? null;

  const label  = initial != null ? `from ${initial}` : "no score";
  const scoreY = compact ? cx + 1 : cx + 5;
  const labelY = compact ? cx + 11 : cx + 18;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
      role="img"
      aria-label={score != null ? `ATS score ${score}${initial != null ? `, from ${initial}` : ""}` : "No ATS score yet"}
    >
      <circle
        cx={cx} cy={cx} r={r}
        fill="none"
        stroke="var(--border-muted)"
        strokeWidth={stroke}
      />
      {initial != null && (
        <circle
          cx={cx} cy={cx} r={r}
          fill="none"
          stroke="var(--text-3)"
          strokeOpacity={0.4}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={arcLen(r, initial)}
          transform={`rotate(-90 ${cx} ${cx})`}
        />
      )}
      {score != null && (
        <circle
          cx={cx} cy={cx} r={r}
          fill="none"
          stroke={arcColor(job, score)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={arcLen(r, score)}
          transform={`rotate(-90 ${cx} ${cx})`}
        />
      )}
      <text
        x={cx} y={scoreY}
        textAnchor="middle"
        fontSize={compact ? 15 : 18}
        fontWeight={700}
        fill={score != null ? "var(--text)" : "var(--text-3)"}
      >
        {score ?? "—"}
      </text>
      <text
        x={cx} y={labelY}
        textAnchor="middle"
        fontSize={compact ? 9 : 11}
        fill="var(--text-3)"
      >
        {label}
      </text>
    </svg>
  );
}
