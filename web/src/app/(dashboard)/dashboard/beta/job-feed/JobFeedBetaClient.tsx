"use client";

/**
 * Smart-feed beta v2.
 *
 * Layout: always-on distance ribbon at the top (interactive — drag the range
 * handles to bracket by km, click legend dots to filter by visa). Below it a
 * filter+sort toolbar. Below that, two modes:
 *
 *   Default (no filters active): opinionated smart sections —
 *     Today's picks / Closest / Fresh today / Needs attention / Everything else.
 *
 *   Any filter active: single flat list, sorted by the user's pick.
 *     Switch back with the "Reset to smart view" link.
 *
 * Every card now carries a match-score bar (0–100) so you can see *why*
 * a job ranks where it does.
 *
 * Keyboard: j/k navigate · a analyze · ? show help.
 *
 * Pure UI, mock data, no backend.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3, FileText, Mail, CheckCircle2, MapPin, Sparkles, Clock,
  AlertTriangle, Inbox, ChevronDown, Search, RotateCcw, Keyboard, X,
} from "lucide-react";

// ── types & mock data ───────────────────────────────────────────────────

type VisaStatus = "yes" | "no" | "pr_only" | "unknown";
type JdQuality  = "rich" | "thin" | "unknown";

interface MockJob {
  id: string;
  title: string;
  company: string;
  location: string;
  distance_km: number;
  source: "adzuna" | "seek" | "careerjet" | "greenhouse" | "lever";
  posted_label: string;
  posted_days_ago: number;
  added_iso: string;
  visa: VisaStatus;
  jd_quality: JdQuality;
  is_new?: boolean;
  possible_duplicate?: boolean;
  ats_score: number | null;       // null = not yet analysed
  analysed_at: string | null;
  progress: { analysed: boolean; tailored: boolean; cover: boolean; applied: boolean };
}

const HOME_ADDRESS = "40-42 Empress Street, Hurstville NSW";

const JOBS: MockJob[] = [
  { id: "1",  title: "Enrolled Nurse — Killara Glades Care Community",                  company: "Opal HealthCare",               location: "Killara",       distance_km: 30,   source: "adzuna",    posted_label: "6d ago",  posted_days_ago: 6,  added_iso: "2026-05-21T20:38", visa: "unknown", jd_quality: "thin", is_new: true,  possible_duplicate: true,  ats_score: null, analysed_at: null,                progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "2",  title: "Enrolled Nurse (EN) — LGBTQIA Community Supports — Sydney CBD",   company: "Chosen Family",                 location: "The Rocks",     distance_km: 22,   source: "adzuna",    posted_label: "1w ago",  posted_days_ago: 7,  added_iso: "2026-05-20T20:38", visa: "unknown", jd_quality: "thin", ats_score: null, analysed_at: null,                progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "3",  title: "Enrolled Nurse | Myhealth Northmead",                              company: "Myhealth Medical Centres",      location: "Northmead",     distance_km: 28,   source: "adzuna",    posted_label: "1w ago",  posted_days_ago: 7,  added_iso: "2026-05-20T20:38", visa: "unknown", jd_quality: "thin", ats_score: null, analysed_at: null,                progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "4",  title: "Endorsed Enrolled Nurse — Mental Health",                          company: "Healthscope",                   location: "Bronte",        distance_km: 22,   source: "adzuna",    posted_label: "1w ago",  posted_days_ago: 7,  added_iso: "2026-05-20T20:38", visa: "unknown", jd_quality: "thin", ats_score: null, analysed_at: null,                progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "5",  title: "Enrolled Nurse — Anaesthetics and PACU",                           company: "Nexus",                         location: "Kogarah",       distance_km: 3.3,  source: "adzuna",    posted_label: "2w ago",  posted_days_ago: 14, added_iso: "2026-05-13T20:38", visa: "unknown", jd_quality: "thin", ats_score: null, analysed_at: null,                progress: { analysed: false, tailored: false, cover: false, applied: false } },
  { id: "6",  title: "Enrolled Endorsed Nurse",                                          company: "St Vincent's Health Australia", location: "North Sydney",  distance_km: 24,   source: "careerjet", posted_label: "Today",   posted_days_ago: 0,  added_iso: "2026-05-27T20:38", visa: "no",      jd_quality: "rich", is_new: true,  ats_score: 62, analysed_at: "2026-05-27T21:10", progress: { analysed: true,  tailored: false, cover: false, applied: false } },
  { id: "7",  title: "Enrolled Nurse — Permanent Full-time position — Forbes",           company: "Catholic Healthcare",           location: "Sydney",        distance_km: 21,   source: "careerjet", posted_label: "Today",   posted_days_ago: 0,  added_iso: "2026-05-27T20:38", visa: "yes",     jd_quality: "rich", is_new: true,  ats_score: 78, analysed_at: "2026-05-27T21:12", progress: { analysed: true,  tailored: true,  cover: false, applied: false } },
  { id: "8",  title: "Enrolled Nurse, Community Health",                                 company: "NSW Health",                    location: "Randwick",      distance_km: 19,   source: "careerjet", posted_label: "Today",   posted_days_ago: 0,  added_iso: "2026-05-27T20:38", visa: "pr_only", jd_quality: "rich", is_new: true,  ats_score: 71, analysed_at: "2026-05-27T21:15", progress: { analysed: true,  tailored: false, cover: false, applied: false } },
  { id: "9",  title: "Enrolled Nurse — Orthopaedics & ENT — Perm/Temp F/PT",             company: "NSW Health",                    location: "Caringbah",     distance_km: 9.6,  source: "careerjet", posted_label: "Today",   posted_days_ago: 0,  added_iso: "2026-05-27T20:38", visa: "pr_only", jd_quality: "rich", ats_score: 84, analysed_at: "2026-05-27T21:18", progress: { analysed: true,  tailored: true,  cover: true,  applied: false } },
  { id: "10", title: "Enrolled Nurse Transition Program — St Vincent's Public Hospital", company: "NSW Health",                    location: "Sydney",        distance_km: 21,   source: "careerjet", posted_label: "Today",   posted_days_ago: 0,  added_iso: "2026-05-27T20:38", visa: "no",      jd_quality: "rich", ats_score: 88, analysed_at: "2026-05-26T19:00", progress: { analysed: true,  tailored: true,  cover: true,  applied: true } },
  { id: "11", title: "Enrolled Nurse — Gastroenterology — The Sutherland Hospital",      company: "NSW Health",                    location: "Caringbah",     distance_km: 9.6,  source: "careerjet", posted_label: "Today",   posted_days_ago: 0,  added_iso: "2026-05-27T20:38", visa: "pr_only", jd_quality: "rich", ats_score: 66, analysed_at: "2026-05-27T22:00", progress: { analysed: true,  tailored: false, cover: false, applied: false } },
  { id: "12", title: "Enrolled Nurse — Aged Care",                                       company: "Medacs Healthcare",             location: "Sydney",        distance_km: 42,   source: "adzuna",    posted_label: "2w ago",  posted_days_ago: 14, added_iso: "2026-05-13T20:38", visa: "unknown", jd_quality: "thin", ats_score: null, analysed_at: null,                progress: { analysed: false, tailored: false, cover: false, applied: false } },
];

// ── scoring ─────────────────────────────────────────────────────────────

/** Single explainable 0–100 score combining the things a user actually cares
 *  about. Used both for the "Today's picks" pick and for the bar on every
 *  card so the user can see *why* something ranks high. */
function matchScore(j: MockJob): number {
  let s = 50;
  // Distance — closer is much better
  s += Math.max(0, 30 - j.distance_km * 0.7);
  // Visa
  if (j.visa === "yes")     s += 18;
  if (j.visa === "no")      s -= 25;
  if (j.visa === "pr_only") s -= 12;
  // JD quality — thin descriptions hurt
  if (j.jd_quality === "thin") s -= 8;
  // Freshness
  if (j.posted_days_ago === 0) s += 8;
  else if (j.posted_days_ago > 14) s -= 5;
  // ATS score, when known, dominates
  if (j.ats_score !== null) s = Math.round(s * 0.3 + j.ats_score * 0.7);
  if (j.progress.applied) s = Math.min(s, 5); // hide already-done
  return Math.max(0, Math.min(100, Math.round(s)));
}

// ── pipeline-stage helpers ──────────────────────────────────────────────

type StageId = "thin_jd" | "full_jd" | "analysed" | "cv_ready" | "letter_ready" | "applied";

const STAGE_META: { id: StageId; label: string; predicate: (j: MockJob) => boolean }[] = [
  { id: "thin_jd",      label: "Thin JD",        predicate: (j) => j.jd_quality === "thin" },
  { id: "full_jd",      label: "Full JD",        predicate: (j) => j.jd_quality === "rich" },
  { id: "analysed",     label: "Analysed",       predicate: (j) => j.progress.analysed },
  { id: "cv_ready",     label: "CV ready",       predicate: (j) => j.progress.tailored },
  { id: "letter_ready", label: "Letter ready",   predicate: (j) => j.progress.cover },
  { id: "applied",      label: "Applied",        predicate: (j) => j.progress.applied },
];

const VISA_LABEL: Record<VisaStatus, string> = {
  yes: "Sponsored", no: "No sponsor", pr_only: "PR only", unknown: "Unknown",
};

const VISA_COLOR: Record<VisaStatus, string> = {
  yes: "#22c55e", no: "#ef4444", pr_only: "#f59e0b", unknown: "#94a3b8",
};

// ── sort options ────────────────────────────────────────────────────────

type SortId = "match" | "distance" | "posted" | "added" | "recently_analysed" | "progress" | "ats";

// ── ATS bands ───────────────────────────────────────────────────────────
// Mirrors web/src/lib/atsThresholds.ts in production (60 / 70).
const ATS_INITIAL = 60;
const ATS_FINAL   = 70;

type AtsBand = "above_final" | "below_final" | "below_initial" | "not_analysed";

function atsBand(score: number | null): AtsBand {
  if (score === null) return "not_analysed";
  if (score >= ATS_FINAL)   return "above_final";
  if (score >= ATS_INITIAL) return "below_final";
  return "below_initial";
}

const ATS_BAND_META: { id: AtsBand; label: string; tip: string; dot: string; chipBg: string; chipText: string }[] = [
  { id: "above_final",   label: `ATS ≥ ${ATS_FINAL}`,                  tip: `Above the final gate (${ATS_FINAL}) — auto cover letter`,        dot: "bg-green-500", chipBg: "bg-green-100", chipText: "text-green-800" },
  { id: "below_final",   label: `ATS ${ATS_INITIAL}–${ATS_FINAL - 1}`, tip: `Between gates — tailored CV, no auto cover letter`,             dot: "bg-amber-500", chipBg: "bg-amber-100", chipText: "text-amber-800" },
  { id: "below_initial", label: `ATS < ${ATS_INITIAL}`,                tip: `Below the initial gate (${ATS_INITIAL}) — pipeline stops here`, dot: "bg-red-500",   chipBg: "bg-red-100",   chipText: "text-red-800"   },
  { id: "not_analysed",  label: "Not analysed",                        tip: "No ATS score yet — click Analyze on the card",                  dot: "bg-gray-300",  chipBg: "bg-[var(--surface-2)]", chipText: "text-text-2" },
];

const SORT_LABEL: Record<SortId, string> = {
  match:             "Match score",
  distance:          "Distance",
  posted:            "Date posted",
  added:             "Date added",
  recently_analysed: "Recently analysed",
  progress:          "Most progressed",
  ats:               "ATS score",
};

function atsBandCounts(jobs: MockJob[]): Record<AtsBand, number> {
  const out: Record<AtsBand, number> = { above_final: 0, below_final: 0, below_initial: 0, not_analysed: 0 };
  for (const j of jobs) out[atsBand(j.ats_score)]++;
  return out;
}

function progressLevel(j: MockJob): number {
  return (j.progress.analysed ? 1 : 0) + (j.progress.tailored ? 1 : 0) +
         (j.progress.cover    ? 1 : 0) + (j.progress.applied  ? 1 : 0);
}

function sortJobs(jobs: MockJob[], sort: SortId): MockJob[] {
  const sorted = [...jobs];
  switch (sort) {
    case "match":             return sorted.sort((a, b) => matchScore(b) - matchScore(a));
    case "distance":          return sorted.sort((a, b) => a.distance_km - b.distance_km);
    case "posted":            return sorted.sort((a, b) => a.posted_days_ago - b.posted_days_ago);
    case "added":             return sorted.sort((a, b) => +new Date(b.added_iso) - +new Date(a.added_iso));
    case "recently_analysed": return sorted.sort((a, b) => {
      const at = a.analysed_at ? +new Date(a.analysed_at) : 0;
      const bt = b.analysed_at ? +new Date(b.analysed_at) : 0;
      return bt - at;
    });
    case "progress":          return sorted.sort((a, b) => progressLevel(b) - progressLevel(a));
    case "ats":               return sorted.sort((a, b) => (b.ats_score ?? -1) - (a.ats_score ?? -1));
  }
}

// ── component ───────────────────────────────────────────────────────────

export function JobFeedBetaClient() {
  const [sort,           setSort]          = useState<SortId>("match");
  const [stageFilters,   setStageFilters]  = useState<Set<StageId>>(new Set());
  const [atsBandFilters, setAtsBandFilters] = useState<Set<AtsBand>>(new Set());
  const [visaFilters,    setVisaFilters]   = useState<Set<VisaStatus>>(new Set());
  const [locationQuery,  setLocationQuery] = useState("");
  const [distRange,      setDistRange]     = useState<[number, number]>([0, 50]);
  const [expandRest,     setExpandRest]    = useState(false);
  const [showHelp,       setShowHelp]      = useState(false);

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const orderedRef = useRef<string[]>([]); // ids in display order for j/k nav
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const filteredJobs = useMemo(() => {
    let xs = JOBS;
    if (stageFilters.size > 0) {
      xs = xs.filter((j) => {
        for (const s of stageFilters) {
          const meta = STAGE_META.find((m) => m.id === s);
          if (meta && meta.predicate(j)) return true;
        }
        return false;
      });
    }
    if (visaFilters.size > 0) {
      xs = xs.filter((j) => visaFilters.has(j.visa));
    }
    if (atsBandFilters.size > 0) {
      xs = xs.filter((j) => atsBandFilters.has(atsBand(j.ats_score)));
    }
    if (locationQuery.trim()) {
      const q = locationQuery.trim().toLowerCase();
      xs = xs.filter((j) => j.location.toLowerCase().includes(q) || j.company.toLowerCase().includes(q));
    }
    if (distRange[0] > 0 || distRange[1] < 50) {
      xs = xs.filter((j) => j.distance_km >= distRange[0] && j.distance_km <= distRange[1]);
    }
    return xs;
  }, [stageFilters, visaFilters, atsBandFilters, locationQuery, distRange]);

  const anyFilterActive =
    stageFilters.size > 0 || visaFilters.size > 0 || atsBandFilters.size > 0 ||
    locationQuery.trim().length > 0 || distRange[0] > 0 || distRange[1] < 50;

  // Buckets for the smart view (only computed when no filter is active)
  const buckets = useMemo(() => {
    if (anyFilterActive) return null;
    const undecided = JOBS.filter((j) => !j.progress.applied);
    const picks   = sortJobs(undecided, "match").slice(0, 3);
    const pickIds = new Set(picks.map((j) => j.id));
    const closest = undecided.filter((j) => !pickIds.has(j.id) && j.distance_km <= 15).sort((a, b) => a.distance_km - b.distance_km);
    const closeIds = new Set(closest.map((j) => j.id));
    const fresh = undecided.filter((j) => !pickIds.has(j.id) && !closeIds.has(j.id) && j.posted_days_ago === 0);
    const freshIds = new Set(fresh.map((j) => j.id));
    const attention = undecided.filter((j) => !pickIds.has(j.id) && !closeIds.has(j.id) && !freshIds.has(j.id) && j.jd_quality === "thin");
    const attentionIds = new Set(attention.map((j) => j.id));
    const rest = undecided.filter((j) => !pickIds.has(j.id) && !closeIds.has(j.id) && !freshIds.has(j.id) && !attentionIds.has(j.id));
    return { picks, closest, fresh, attention, rest };
  }, [anyFilterActive]);

  // Track display order so j/k can navigate
  if (anyFilterActive) {
    orderedRef.current = sortJobs(filteredJobs, sort).map((j) => j.id);
  } else if (buckets) {
    orderedRef.current = [
      ...buckets.picks.map((j) => j.id),
      ...buckets.closest.map((j) => j.id),
      ...buckets.fresh.map((j) => j.id),
      ...buckets.attention.map((j) => j.id),
      ...buckets.rest.map((j) => j.id),
    ];
  }

  function scrollToJob(id: string) {
    const el = cardRefs.current[id];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-[var(--brand)]");
    setTimeout(() => el.classList.remove("ring-2", "ring-[var(--brand)]"), 1500);
    setFocusedId(id);
  }

  // ── keyboard shortcuts ──
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // skip if typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        setShowHelp(false);
        return;
      }
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const order = orderedRef.current;
        if (order.length === 0) return;
        const idx = focusedId ? order.indexOf(focusedId) : -1;
        const nextIdx = e.key === "j"
          ? Math.min(idx + 1, order.length - 1)
          : Math.max(idx - 1, 0);
        scrollToJob(order[nextIdx === -1 ? 0 : nextIdx]);
      }
      if (e.key === "a" && focusedId) {
        e.preventDefault();
        alert(`(mock) Analyze job ${focusedId}`);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedId]);

  function toggleStage(s: StageId) {
    setStageFilters((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }
  function toggleAtsBand(b: AtsBand) {
    setAtsBandFilters((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  }
  function toggleVisa(v: VisaStatus) {
    setVisaFilters((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }
  function resetAll() {
    setStageFilters(new Set());
    setAtsBandFilters(new Set());
    setVisaFilters(new Set());
    setLocationQuery("");
    setDistRange([0, 50]);
    setSort("match");
  }

  const maxAxisKm = 50;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">

      {/* Beta banner */}
      <div className="mb-5 flex items-start gap-3 p-3 rounded-md border border-[var(--brand)]/30 bg-[#DDF4FF] text-[12px] text-text">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-[var(--brand)] text-white text-[10px] font-bold shrink-0">β</span>
        <div className="min-w-0">
          <p className="font-semibold">Smart feed v2 — preview only</p>
          <p className="text-text-2 mt-0.5 leading-relaxed">
            Distance ribbon stays pinned at the top — drag its handles to bracket km, click a legend dot to filter by visa.
            Add stage filters or change sort below; smart sections fold into a flat list. Each card now shows a <strong>match score</strong> so you can see why it ranks high.
            <button onClick={() => setShowHelp(true)} className="ml-1 underline text-[var(--brand)]">Keyboard shortcuts →</button>
          </p>
        </div>
      </div>

      {/* Header */}
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-text">Rashmu — Enrolled Nurse</h1>
          <p className="text-[12px] text-text-2 flex items-center gap-1.5 mt-1">
            <MapPin className="w-3 h-3" />
            {HOME_ADDRESS}
          </p>
        </div>
        <div className="text-[12px] text-text-2">
          <strong className="text-text">{filteredJobs.length}</strong> of {JOBS.length} jobs
        </div>
      </div>

      {/* Always-on distance ribbon (with range slider + clickable legend) */}
      <DistanceRibbon
        jobs={JOBS}
        maxKm={maxAxisKm}
        range={distRange}
        onRangeChange={setDistRange}
        visaFilters={visaFilters}
        onVisaToggle={toggleVisa}
        onJobClick={scrollToJob}
      />

      {/* Toolbar */}
      <Toolbar
        sort={sort} setSort={setSort}
        stageFilters={stageFilters} toggleStage={toggleStage}
        atsBandFilters={atsBandFilters} toggleAtsBand={toggleAtsBand}
        atsCounts={atsBandCounts(JOBS)}
        locationQuery={locationQuery} setLocationQuery={setLocationQuery}
      />

      {/* Active-filter summary */}
      {anyFilterActive && (
        <div className="mt-3 flex items-center gap-2 text-[11px] text-text-2">
          <span>Showing <strong className="text-text">{filteredJobs.length}</strong> of {JOBS.length} · sorted by {SORT_LABEL[sort]}</span>
          <button onClick={resetAll} className="inline-flex items-center gap-1 text-[var(--brand)] hover:underline">
            <RotateCcw className="w-3 h-3" /> Reset to smart view
          </button>
        </div>
      )}

      {/* Content area */}
      <div className="mt-5">
        {anyFilterActive ? (
          <FlatList
            jobs={sortJobs(filteredJobs, sort)}
            sort={sort}
            cardRefs={cardRefs}
            focusedId={focusedId}
          />
        ) : buckets ? (
          <SmartSections
            buckets={buckets}
            cardRefs={cardRefs}
            focusedId={focusedId}
            expandRest={expandRest}
            setExpandRest={setExpandRest}
          />
        ) : null}
      </div>

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}

// ── distance ribbon ─────────────────────────────────────────────────────

function DistanceRibbon({
  jobs, maxKm, range, onRangeChange, visaFilters, onVisaToggle, onJobClick,
}: {
  jobs: MockJob[];
  maxKm: number;
  range: [number, number];
  onRangeChange: (r: [number, number]) => void;
  visaFilters: Set<VisaStatus>;
  onVisaToggle: (v: VisaStatus) => void;
  onJobClick: (id: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<"min" | "max" | null>(null);
  const axisMax = Math.ceil(maxKm / 10) * 10;
  const ticks = Array.from({ length: axisMax / 10 + 1 }, (_, i) => i * 10);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent | TouchEvent) {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const km = Math.round(pct * axisMax);
      if (dragging === "min") {
        onRangeChange([Math.min(km, range[1] - 1), range[1]]);
      } else {
        onRangeChange([range[0], Math.max(km, range[0] + 1)]);
      }
    }
    function onUp() { setDragging(null); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove);
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [dragging, range, axisMax, onRangeChange]);

  const rangeActive = range[0] > 0 || range[1] < axisMax;

  return (
    <div className="rounded-md border border-border bg-[var(--surface-2)] p-4">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-[11px] font-semibold text-text-2 uppercase tracking-wider">
          Distance from home {rangeActive && (
            <span className="text-text font-normal normal-case ml-1">
              · {range[0]}–{range[1]} km
              <button
                onClick={() => onRangeChange([0, axisMax])}
                className="ml-1 text-[var(--brand)] hover:underline"
              >clear</button>
            </span>
          )}
        </p>
        <div className="flex items-center gap-2 text-[10px] text-text-2">
          {(["yes","unknown","pr_only","no"] as VisaStatus[]).map((v) => (
            <button
              key={v}
              onClick={() => onVisaToggle(v)}
              title={`Toggle filter: ${VISA_LABEL[v]}`}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
                visaFilters.has(v)
                  ? "bg-[var(--brand)]/15 text-text font-medium"
                  : "hover:bg-[var(--surface-2)]"
              }`}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: VISA_COLOR[v] }} />
              {VISA_LABEL[v]}
            </button>
          ))}
        </div>
      </div>

      <div ref={trackRef} className="relative h-14 select-none">
        {/* Axis */}
        <div className="absolute left-0 right-0 top-7 h-px bg-border" />
        {/* Highlighted range */}
        <div
          className="absolute top-[26px] h-[3px] bg-[var(--brand)]/40 rounded"
          style={{
            left: `${(range[0] / axisMax) * 100}%`,
            width: `${((range[1] - range[0]) / axisMax) * 100}%`,
          }}
        />
        {/* Ticks */}
        {ticks.map((t) => (
          <div key={t} className="absolute top-7" style={{ left: `${(t / axisMax) * 100}%` }}>
            <div className="w-px h-1.5 bg-border" />
            <div className="text-[9px] text-text-3 mt-1 -translate-x-1/2 whitespace-nowrap">{t} km</div>
          </div>
        ))}
        {/* Job dots */}
        {jobs.map((j, i) => {
          const x = (Math.min(j.distance_km, axisMax) / axisMax) * 100;
          const y = 28 + ((i % 3) - 1) * 3;
          const muted = j.distance_km < range[0] || j.distance_km > range[1] ||
            (visaFilters.size > 0 && !visaFilters.has(j.visa));
          return (
            <button
              key={j.id}
              type="button"
              onClick={() => onJobClick(j.id)}
              title={`${j.title}\n${j.company} · ${j.location} · ${j.distance_km < 10 ? j.distance_km.toFixed(1) : Math.round(j.distance_km)} km`}
              className="absolute w-2.5 h-2.5 rounded-full hover:scale-150 transition-all shadow-sm"
              style={{
                left: `calc(${x}% - 5px)`,
                top: `${y - 5}px`,
                background: VISA_COLOR[j.visa],
                borderColor: "white",
                borderWidth: 1,
                borderStyle: "solid",
                opacity: muted ? 0.25 : 1,
              }}
            />
          );
        })}
        {/* Range handles */}
        <RangeHandle pos={(range[0] / axisMax) * 100} onMouseDown={() => setDragging("min")} label={`${range[0]} km`} />
        <RangeHandle pos={(range[1] / axisMax) * 100} onMouseDown={() => setDragging("max")} label={`${range[1]} km`} />
      </div>
    </div>
  );
}

function RangeHandle({ pos, onMouseDown, label }: { pos: number; onMouseDown: () => void; label: string }) {
  return (
    <button
      type="button"
      title={`Drag — ${label}`}
      onMouseDown={onMouseDown}
      onTouchStart={onMouseDown}
      className="absolute top-[20px] w-3 h-3 rounded-sm bg-white border-2 border-[var(--brand)] cursor-ew-resize hover:scale-125 transition-transform shadow"
      style={{ left: `calc(${pos}% - 6px)` }}
    />
  );
}

// ── toolbar ─────────────────────────────────────────────────────────────

function Toolbar({
  sort, setSort,
  stageFilters, toggleStage,
  atsBandFilters, toggleAtsBand, atsCounts,
  locationQuery, setLocationQuery,
}: {
  sort: SortId;
  setSort: (s: SortId) => void;
  stageFilters: Set<StageId>;
  toggleStage: (s: StageId) => void;
  atsBandFilters: Set<AtsBand>;
  toggleAtsBand: (b: AtsBand) => void;
  atsCounts: Record<AtsBand, number>;
  locationQuery: string;
  setLocationQuery: (q: string) => void;
}) {
  return (
    <div className="mt-3 rounded-md border border-border bg-surface p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Location search — pl-9 leaves clean space for the lens; pointer-events-none
            on the icon means it never blocks clicks/typing in the input */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-3 pointer-events-none" />
          <input
            value={locationQuery}
            onChange={(e) => setLocationQuery(e.target.value)}
            placeholder="Filter by location or company…"
            className="field pl-9 pr-8 text-[12px]"
          />
          {locationQuery && (
            <button
              onClick={() => setLocationQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-3 hover:text-text"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {/* Sort */}
        <label className="flex items-center gap-1.5 text-[11px] text-text-2 shrink-0">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortId)}
            className="field text-[12px] py-1 pr-7"
          >
            {(Object.keys(SORT_LABEL) as SortId[]).map((s) => (
              <option key={s} value={s}>{SORT_LABEL[s]}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Stage filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase font-semibold text-text-3 tracking-wider mr-1 w-12 shrink-0">Stage</span>
        {STAGE_META.map((s) => {
          const active = stageFilters.has(s.id);
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => toggleStage(s.id)}
              className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                active
                  ? "bg-[var(--brand)] text-white border-[var(--brand)]"
                  : "bg-surface text-text-2 border-border hover:bg-[var(--surface-2)]"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {/* ATS band filter chips — colour-coded per band so the gates are
          legible at a glance. Counts shown so you don't tap an empty band. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="text-[10px] uppercase font-semibold text-text-3 tracking-wider mr-1 w-12 shrink-0"
          title={`Global ATS gates: initial ${ATS_INITIAL} (must pass to tailor), final ${ATS_FINAL} (auto cover letter)`}
        >
          ATS
        </span>
        {ATS_BAND_META.map((b) => {
          const active = atsBandFilters.has(b.id);
          const count  = atsCounts[b.id];
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => toggleAtsBand(b.id)}
              title={b.tip}
              disabled={count === 0}
              className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                active
                  ? `${b.chipBg} ${b.chipText} border-current font-medium`
                  : count === 0
                    ? "bg-surface text-text-3 border-border opacity-50 cursor-not-allowed"
                    : "bg-surface text-text-2 border-border hover:bg-[var(--surface-2)]"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${b.dot}`} />
              {b.label}
              <span className="text-text-3 tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── smart sections (default view) ───────────────────────────────────────

function SmartSections({
  buckets, cardRefs, focusedId, expandRest, setExpandRest,
}: {
  buckets: { picks: MockJob[]; closest: MockJob[]; fresh: MockJob[]; attention: MockJob[]; rest: MockJob[] };
  cardRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
  focusedId: string | null;
  expandRest: boolean;
  setExpandRest: (v: boolean) => void;
}) {
  const set = (id: string) => (el: HTMLDivElement | null) => { if (cardRefs.current) cardRefs.current[id] = el; };

  return (
    <div className="space-y-7">
      <Section
        icon={<Sparkles className="w-3.5 h-3.5" />}
        title="Today's picks"
        subtitle="Best matches across distance, visa fit, and JD quality"
        count={buckets.picks.length}
        tone="brand"
      >
        <div className="grid gap-2.5 sm:grid-cols-1 lg:grid-cols-3">
          {buckets.picks.map((job) => (
            <HeroCard key={job.id} job={job} refSetter={set(job.id)} focused={focusedId === job.id} />
          ))}
        </div>
      </Section>

      {buckets.closest.length > 0 && (
        <Section icon={<MapPin className="w-3.5 h-3.5" />} title="Closest to you" subtitle="Within 15 km of your home" count={buckets.closest.length} tone="green">
          <div className="grid gap-2">
            {buckets.closest.map((job) => <Card key={job.id} job={job} refSetter={set(job.id)} focused={focusedId === job.id} />)}
          </div>
        </Section>
      )}

      {buckets.fresh.length > 0 && (
        <Section icon={<Clock className="w-3.5 h-3.5" />} title="Fresh today" subtitle="Posted in the last 24 hours" count={buckets.fresh.length} tone="brand">
          <div className="grid gap-2">
            {buckets.fresh.map((job) => <Card key={job.id} job={job} refSetter={set(job.id)} focused={focusedId === job.id} />)}
          </div>
        </Section>
      )}

      {buckets.attention.length > 0 && (
        <Section icon={<AlertTriangle className="w-3.5 h-3.5" />} title="Needs attention" subtitle="Thin JDs — paste the full description before analysing" count={buckets.attention.length} tone="amber">
          <div className="grid gap-2">
            {buckets.attention.map((job) => <Card key={job.id} job={job} refSetter={set(job.id)} focused={focusedId === job.id} />)}
          </div>
        </Section>
      )}

      {buckets.rest.length > 0 && (
        <Section icon={<Inbox className="w-3.5 h-3.5" />} title="Everything else" subtitle="Older or further away — review when you've got time" count={buckets.rest.length} tone="muted" collapsible expanded={expandRest} onToggle={() => setExpandRest(!expandRest)}>
          <div className="grid gap-2">
            {buckets.rest.map((job) => <Card key={job.id} job={job} refSetter={set(job.id)} focused={focusedId === job.id} compact />)}
          </div>
        </Section>
      )}
    </div>
  );
}

// ── flat list (when filtered) ───────────────────────────────────────────

function FlatList({
  jobs, sort, cardRefs, focusedId,
}: {
  jobs: MockJob[];
  sort: SortId;
  cardRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
  focusedId: string | null;
}) {
  if (jobs.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface py-14 text-center">
        <p className="text-[13px] font-semibold text-text">No jobs match your filters</p>
        <p className="text-[11px] text-text-2 mt-1">Try removing a stage chip or widening the distance range.</p>
      </div>
    );
  }
  const set = (id: string) => (el: HTMLDivElement | null) => { if (cardRefs.current) cardRefs.current[id] = el; };
  return (
    <div className="grid gap-2">
      {jobs.map((job) => (
        <Card key={job.id} job={job} refSetter={set(job.id)} focused={focusedId === job.id} showSort={sort} />
      ))}
    </div>
  );
}

// ── section header ──────────────────────────────────────────────────────

function Section({
  icon, title, subtitle, count, children, tone, collapsible, expanded, onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  count: number;
  children: React.ReactNode;
  tone: "brand" | "green" | "amber" | "muted";
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const toneCls = { brand: "text-[var(--brand)]", green: "text-green-600", amber: "text-amber-600", muted: "text-text-2" }[tone];
  const isOpen = collapsible ? !!expanded : true;
  return (
    <section>
      <button
        type="button"
        onClick={collapsible ? onToggle : undefined}
        className={`w-full flex items-baseline justify-between gap-2 mb-2 ${collapsible ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
      >
        <div className="flex items-baseline gap-2">
          <span className={`shrink-0 self-center ${toneCls}`}>{icon}</span>
          <h2 className="text-[13px] font-semibold text-text">{title}</h2>
          <span className="text-[11px] text-text-3 font-medium">{count}</span>
          {subtitle && !collapsible && <span className="text-[11px] text-text-3">— {subtitle}</span>}
        </div>
        {collapsible && <ChevronDown className={`w-4 h-4 text-text-3 transition-transform ${isOpen ? "rotate-180" : ""}`} />}
      </button>
      {isOpen && children}
    </section>
  );
}

// ── hero card (today's picks) ───────────────────────────────────────────

function HeroCard({ job, refSetter, focused }: { job: MockJob; refSetter: (el: HTMLDivElement | null) => void; focused: boolean }) {
  const score = matchScore(job);
  return (
    <div
      ref={refSetter}
      className={`rounded-lg border-2 ${focused ? "border-[var(--brand)]" : "border-[var(--brand)]/30"} bg-surface p-3.5 hover:shadow-md transition-all`}
    >
      <div className="flex items-center gap-2 mb-2">
        <VisaDot visa={job.visa} />
        <SourcePill source={job.source} />
        {job.ats_score !== null && <AtsChip score={job.ats_score} />}
        <span className="text-[10px] text-text-3 ml-auto">{job.posted_label}</span>
      </div>
      <a href="#" onClick={(e) => e.preventDefault()} className="block text-[13px] font-semibold text-text hover:text-[var(--brand)] leading-snug mb-1.5">
        {job.title}
      </a>
      <p className="text-[11px] text-text-2 mb-2">{job.company} · {job.location} · <Distance km={job.distance_km} /></p>
      <ScoreBar score={score} ats={job.ats_score} />
      <div className="flex items-center justify-between gap-2 mt-2.5">
        <ProgressDots p={job.progress} />
        <button type="button" className="gh-btn gh-btn-blue text-[11px] py-1 px-2.5" onClick={(e) => e.preventDefault()}>Analyze</button>
      </div>
    </div>
  );
}

// ── compact card ────────────────────────────────────────────────────────

function Card({
  job, refSetter, focused, compact, showSort,
}: {
  job: MockJob;
  refSetter: (el: HTMLDivElement | null) => void;
  focused: boolean;
  compact?: boolean;
  showSort?: SortId;
}) {
  const score = matchScore(job);
  return (
    <div
      ref={refSetter}
      className={`rounded-md border bg-surface transition-colors ${focused ? "border-[var(--brand)] ring-1 ring-[var(--brand)]" : "border-border"} hover:bg-[var(--surface-2)]/60 ${compact ? "px-3 py-2" : "px-3.5 py-2.5"}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <VisaDot visa={job.visa} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <a href="#" onClick={(e) => e.preventDefault()} className="text-[13px] font-semibold text-text hover:text-[var(--brand)] truncate">{job.title}</a>
            <SourcePill source={job.source} />
            {job.jd_quality === "thin" && <ChipWarn label="thin JD" tooltip="JD too short to analyse" />}
            {job.possible_duplicate && <ChipWarn label="dup?" tooltip="Possible duplicate" />}
            {job.ats_score !== null && <AtsChip score={job.ats_score} />}
            {showSort === "progress" && (
              <ChipInfo label={`Progress ${(job.progress.analysed ? 1 : 0) + (job.progress.tailored ? 1 : 0) + (job.progress.cover ? 1 : 0) + (job.progress.applied ? 1 : 0)}/4`} tooltip="Pipeline progress" />
            )}
            {showSort === "recently_analysed" && job.analysed_at && (
              <ChipInfo label={`Analysed ${new Date(job.analysed_at).toLocaleString("en-AU", { day: "numeric", month: "short" })}`} tooltip="Recently analysed" />
            )}
          </div>
          <p className="text-[11px] text-text-2 truncate mt-0.5">
            {job.company} · {job.location} · <Distance km={job.distance_km} /> · {job.posted_label}
          </p>
          {!compact && <div className="mt-1.5"><ScoreBar score={score} ats={job.ats_score} compact /></div>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ProgressDots p={job.progress} />
          <button type="button" className="gh-btn gh-btn-blue text-[11px] py-1 px-2.5" onClick={(e) => e.preventDefault()}>Analyze</button>
        </div>
      </div>
    </div>
  );
}

// ── presentation primitives ─────────────────────────────────────────────

function ScoreBar({ score, ats, compact }: { score: number; ats: number | null; compact?: boolean }) {
  const color = score >= 70 ? "bg-green-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2" title={`Match score ${score}/100 — combines distance, visa fit, JD quality, freshness${ats !== null ? `, ATS ${ats}` : ""}`}>
      <div className={`relative bg-[var(--surface-2)] rounded-full overflow-hidden ${compact ? "h-1" : "h-1.5"} flex-1`}>
        <div className={`h-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className={`tabular-nums font-semibold text-text-2 shrink-0 ${compact ? "text-[10px]" : "text-[11px]"}`}>
        {score}
        {ats !== null && <span className="text-text-3 font-normal"> · ATS {ats}</span>}
      </span>
    </div>
  );
}

function VisaDot({ visa }: { visa: VisaStatus }) {
  return <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: VISA_COLOR[visa] }} title={VISA_LABEL[visa]} />;
}

function SourcePill({ source }: { source: MockJob["source"] }) {
  const tone = { adzuna: "bg-blue-100 text-blue-700", seek: "bg-blue-100 text-blue-700", careerjet: "bg-teal-100 text-teal-700", greenhouse: "bg-purple-100 text-purple-700", lever: "bg-purple-100 text-purple-700" }[source];
  return <span className={`text-[9px] uppercase font-semibold tracking-wide px-1.5 py-px rounded shrink-0 ${tone}`}>{source}</span>;
}

function ChipWarn({ label, tooltip }: { label: string; tooltip: string }) {
  return <span title={tooltip} className="text-[10px] font-medium px-1.5 py-px rounded shrink-0 bg-amber-100 text-amber-800">{label}</span>;
}

function ChipInfo({ label, tooltip }: { label: string; tooltip: string }) {
  return <span title={tooltip} className="text-[10px] font-medium px-1.5 py-px rounded shrink-0 bg-[var(--surface-2)] text-text-2 border border-border">{label}</span>;
}

/** Coloured by ATS band so the user can see at a glance whether a job
 *  cleared the initial / final gate. Same colours as the toolbar chips. */
function AtsChip({ score }: { score: number }) {
  const band = ATS_BAND_META.find((b) => b.id === atsBand(score))!;
  return (
    <span
      title={`ATS ${score} — ${band.tip}`}
      className={`text-[10px] font-semibold px-1.5 py-px rounded shrink-0 tabular-nums ${band.chipBg} ${band.chipText}`}
    >
      ATS {score}
    </span>
  );
}

function Distance({ km }: { km: number }) {
  const tone = km <= 10 ? "text-green-600" : km <= 25 ? "text-text-2" : km <= 50 ? "text-amber-600" : "text-red-600";
  const display = km < 10 ? km.toFixed(1) : Math.round(km);
  return <span className={`tabular-nums font-medium ${tone}`}>{display} km</span>;
}

function ProgressDots({ p }: { p: MockJob["progress"] }) {
  const items = [
    { on: p.analysed, Icon: BarChart3,    cls: "text-blue-600",   label: "Analysed" },
    { on: p.tailored, Icon: FileText,     cls: "text-purple-600", label: "Tailored CV" },
    { on: p.cover,    Icon: Mail,         cls: "text-amber-600",  label: "Cover letter" },
    { on: p.applied,  Icon: CheckCircle2, cls: "text-green-600",  label: "Applied" },
  ];
  return (
    <div className="flex items-center gap-1">
      {items.map(({ on, Icon, cls, label }, i) => (
        <Icon key={i} className={`w-3.5 h-3.5 ${on ? cls : "text-text-3 opacity-30"}`} strokeWidth={on ? 2.5 : 1.5} aria-label={label} />
      ))}
    </div>
  );
}

// ── help modal ──────────────────────────────────────────────────────────

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface rounded-lg border border-border max-w-md w-full p-5 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[14px] font-semibold text-text inline-flex items-center gap-2">
            <Keyboard className="w-4 h-4" /> Keyboard shortcuts
          </h3>
          <button onClick={onClose} className="text-text-3 hover:text-text">
            <X className="w-4 h-4" />
          </button>
        </div>
        <dl className="space-y-2 text-[12px]">
          <Kbd k="j / k" desc="Navigate to next / previous job card" />
          <Kbd k="a"     desc="Analyze the focused job" />
          <Kbd k="?"     desc="Show this help (Esc to close)" />
        </dl>
        <p className="mt-4 text-[11px] text-text-3">
          Beta-only — these shortcuts aren&apos;t wired in the production board yet.
        </p>
      </div>
    </div>
  );
}

function Kbd({ k, desc }: { k: string; desc: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <kbd className="text-[11px] font-mono px-1.5 py-0.5 bg-[var(--surface-2)] border border-border rounded shrink-0">{k}</kbd>
      <span className="text-text-2">{desc}</span>
    </div>
  );
}
