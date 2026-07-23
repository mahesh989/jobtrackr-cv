"use client";

/**
 * CV-library card sub-components (split out of LibraryClient.tsx — audit
 * batch 5.2): the expandable CvRowCard, inline actions, the inline review
 * pane, and the AI-skills block.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, Trash2, ChevronRight, ChevronDown, Loader2, Pencil } from "lucide-react";
import { ReviewClient } from "@/features/cv/library/ReviewClient";
import type { StructuredCv } from "@/lib/cv/backend";
import type { CategorisedSkills } from "@/lib/types";
import { type SkillLabels } from "@/lib/cv/skillLabels";
import type { CvRow } from "./LibraryClient";

// ── CV row card — cv-magic style ──────────────────────────────────────────

export function CvRowCard({
  cv,
  ext,
  isBuilt,
  isDraft,
  created,
  skillLabels,
  pending,
  expanded,
  onToggleExpand,
  onEdit,
  onActivate,
  onDelete,
  onStatusChange,
  onStructuredUpdated,
  onSkillsUpdated }: {
  cv:                  CvRow;
  ext:                 string;
  isBuilt:             boolean;
  isDraft:             boolean;
  created:             string;
  skillLabels:         SkillLabels;
  pending:             boolean;
  expanded:            boolean;
  onToggleExpand:      () => void;
  onEdit:              () => void;
  onActivate:          () => void;
  onDelete:            () => void;
  onStatusChange:      (status: string) => void;
  onStructuredUpdated: (structured: StructuredCv) => void;
  onSkillsUpdated:     (skills: CategorisedSkills) => void;
}) {
  // A still-unfinished built CV opens the full-page builder rather than the
  // inline review (create mode lives on the review route).
  const primaryAction = isDraft ? onEdit : onToggleExpand;

  // When collapsed, the WHOLE card is the click target — header, meta, and
  // skills block trigger the primary action. Once expanded, the click is removed
  // so nested form interactions don't accidentally collapse the card.
  const collapsedProps = expanded ? {} : {
    role:      "button" as const,
    tabIndex:  0,
    "aria-expanded": false,
    onClick:   primaryAction,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        primaryAction();
      }
    } };

  return (
    <div
      {...collapsedProps}
      className={
        "group rounded-xl bg-[var(--surface)] transition-all overflow-hidden " +
        (expanded ? "" : "cursor-pointer hover:bg-[var(--surface-2)]/30 hover:shadow-md ") +
        (cv.is_active
          ? "border-2 border-[var(--brand)]/50 shadow-sm"
          : "border border-[var(--border)] hover:border-[var(--brand)]/40")
      }
    >
      {/* HEADER — non-interactive; the wrapper handles click when collapsed,
          and the Collapse button handles it when expanded. Action buttons
          (InlineAction) stopPropagation in either state. */}
      <div
        className="flex w-full items-start justify-between gap-3 p-4 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-text truncate">{cv.label}</span>
            <span className="text-caption text-text-3 px-1.5 py-0.5 rounded-full bg-[var(--surface-2)]/60">{ext}</span>
            {cv.is_active && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--brand)]/30 bg-[var(--brand)]/10 px-2 py-0.5 text-caption font-semibold text-[var(--brand)]">
                <CheckCircle2 className="h-3 w-3" />
                Active
              </span>
            )}
            {cv.structured_cv_status === "verified" && (
              <span className="rounded-full border border-green-700/40 bg-green-700/10 px-2 py-0.5 text-caption font-semibold text-green-800 dark:text-green-300">
                Reviewed
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3 text-label text-text-3" suppressHydrationWarning>
            <span>{isBuilt ? "Created" : "Uploaded"} {created}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Inline actions — span-as-button so the outer button doesn't nest;
              roles + onKeyDown give native click semantics. */}
          {!cv.is_active && (
            <InlineAction
              label="Set active"
              disabled={pending}
              onClick={onActivate}
            />
          )}
          {isDraft ? (
            <InlineAction
              label="Continue editing"
              icon={<Pencil className="h-3.5 w-3.5" />}
              primary
              disabled={pending}
              onClick={onEdit}
            />
          ) : (
            <InlineAction
              label={expanded ? "Collapse" : "Expand"}
              icon={expanded
                ? <ChevronDown className="h-3.5 w-3.5" />
                : <ChevronRight className="h-3.5 w-3.5" />}
              primary
              disabled={pending}
              onClick={onToggleExpand}
            />
          )}
          <InlineAction
            label="Delete CV"
            iconOnly
            icon={<Trash2 className="h-4 w-4" />}
            danger
            disabled={pending}
            onClick={onDelete}
          />
        </div>
      </div>

      {/* COLLAPSED BODY — skills block (kept lightweight) */}
      {!expanded && (
        <div className="px-4 pb-4">
          <CvSkillsBlock skills={cv.categorised_skills} cvId={cv.id} onSkillsUpdated={onSkillsUpdated} />
        </div>
      )}

      {/* EXPANDED BODY — review form. Uses eager-loaded structured_cv for
          instant open; falls back to a lazy fetch when missing (only happens
          for CVs uploaded before the structurize column existed). */}
      {expanded && (
        <div className="border-t border-[var(--border)] bg-[var(--surface-2)]/20 px-4 py-5 sm:px-6">
          <InlineCvReview
            cvId={cv.id}
            initialLabel={cv.label}
            initialStatus={cv.structured_cv_status}
            initialStructuredCv={cv.structured_cv ?? null}
            skillLabels={skillLabels}
            onStatusChange={onStatusChange}
            onStructuredLoaded={onStructuredUpdated}
          />
        </div>
      )}
    </div>
  );
}

/**
 * InlineAction — span styled as a button, stops propagation so it doesn't
 * trigger the row's expand toggle. Tab/Enter/Space activate it.
 */
export function InlineAction({
  label, icon, primary, danger, iconOnly, disabled, onClick }: {
  label: string;
  icon?: React.ReactNode;
  primary?: boolean;
  danger?: boolean;
  iconOnly?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const base = "inline-flex items-center gap-1.5 text-label font-medium rounded-md transition-colors select-none cursor-pointer";
  const tone = danger
    ? "p-1.5 text-text-3 hover:bg-red-light hover:text-red"
    : primary
    ? "px-3 py-1.5 border border-[var(--brand)]/40 bg-[var(--brand)]/10 text-[var(--brand)] hover:bg-[var(--brand)]/15"
    : "px-3 py-1.5 border border-[var(--border)] bg-[var(--surface-2)]/40 text-text hover:bg-[var(--brand)]/5 hover:text-[var(--brand)] hover:border-[var(--brand)]/40";
  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={iconOnly ? label : undefined}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }
      }}
      className={`${base} ${tone} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      {icon}
      {!iconOnly && label}
    </span>
  );
}

/**
 * InlineCvReview — renders the review form using the eager-loaded
 * structured_cv when available (instant open). When the CV hasn't been
 * structurized yet, runs POST /structurize + GET /structured first.
 */
export function InlineCvReview({
  cvId, initialLabel, initialStatus, initialStructuredCv, skillLabels,
  onStatusChange, onStructuredLoaded }: {
  cvId:                 string;
  initialLabel:         string;
  initialStatus:        string | null | undefined;
  initialStructuredCv:  StructuredCv | null;
  skillLabels:          SkillLabels;
  onStatusChange:       (status: string) => void;
  onStructuredLoaded:   (structured: StructuredCv) => void;
}) {
  // Fast path: structured_cv is already on the page — render immediately.
  const hasEager = !!initialStructuredCv;
  const [loading, setLoading] = useState(!hasEager);
  const [error, setError]     = useState<string | null>(null);
  const [data, setData]       = useState<{ structured_cv: StructuredCv; status: string } | null>(
    hasEager ? { structured_cv: initialStructuredCv!, status: initialStatus ?? "parsed" } : null,
  );

  // Only run on mount when there's no eager data. Once fetched, the parent
  // memoises it so re-expanding the same row stays instant.
  useEffect(() => {
    if (hasEager) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        if (!initialStatus) {
          const r = await fetch(`/api/cv/${cvId}/structurize`, { method: "POST" });
          if (!r.ok) {
            const j = await r.json().catch(() => ({})) as { error?: string };
            if (!cancelled) setError(j.error ?? `Could not prepare review (${r.status})`);
            return;
          }
        }
        const r = await fetch(`/api/cv/${cvId}/structured`);
        if (!r.ok) {
          if (!cancelled) setError(`Could not load review (${r.status})`);
          return;
        }
        const j = await r.json() as {
          label: string;
          structured_cv: StructuredCv;
          structured_cv_status: string;
        };
        if (!cancelled) {
          setData({ structured_cv: j.structured_cv, status: j.structured_cv_status });
          onStatusChange(j.structured_cv_status);
          onStructuredLoaded(j.structured_cv);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cvId, hasEager]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-text-3 text-sm">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Preparing review…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="rounded-md border border-red/20 bg-red-light/40 px-3 py-2 text-sm text-red">
        {error ?? "Could not load review."}
      </div>
    );
  }
  return (
    <ReviewClient
      cvId={cvId}
      label={initialLabel}
      initialStructuredCv={data.structured_cv}
      initialStatus={data.status}
      skillLabels={skillLabels}
    />
  );
}

// ── Categorised CV skills — collapsed by default ───────────────────────────

export function CvSkillsBlock({ skills, cvId, onSkillsUpdated }: {
  skills?: CategorisedSkills | null;
  cvId: string;
  onSkillsUpdated: (skills: CategorisedSkills) => void;
}) {
  const [open, setOpen]           = useState(false);
  const [reCatLoading, setReCatLoading] = useState(false);
  const [reCatError, setReCatError]     = useState<string | null>(null);

  async function handleRecategorise() {
    setReCatLoading(true);
    setReCatError(null);
    try {
      const res = await fetch(`/api/cv/${cvId}/recategorise`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setReCatError(j.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      const { categorised_skills } = await res.json() as { categorised_skills: CategorisedSkills };
      onSkillsUpdated(categorised_skills);
    } catch (err) {
      setReCatError(err instanceof Error ? err.message : "Network error");
    } finally {
      setReCatLoading(false);
    }
  }

  if (!skills) {
    return (
      <div className="mt-2" onClick={e => e.stopPropagation()}>
        <p className="text-caption text-text-3 italic mb-1.5">
          Skills not yet categorised. Make sure an AI key is connected, then click below.
        </p>
        {reCatError && <p className="text-caption text-red mb-1">{reCatError}</p>}
        <button
          onClick={(e) => { e.stopPropagation(); handleRecategorise(); }}
          disabled={reCatLoading}
          className="text-caption font-medium text-[var(--brand)] hover:underline disabled:opacity-50"
        >
          {reCatLoading ? "Categorising…" : "↺ Categorise skills now"}
        </button>
      </div>
    );
  }

  const tech   = skills.technical ?? [];
  const soft   = skills.soft_skills ?? [];
  const domain = skills.domain_knowledge ?? [];
  const total  = tech.length + soft.length + domain.length;
  if (total === 0) return null;

  return (
    <div className="mt-2" onClick={e => e.stopPropagation()}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="text-xs text-text-2 hover:text-[var(--brand)] inline-flex items-center gap-1 transition-colors"
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} />
        Show AI-extracted skills ({total})
      </button>

      {open && (
        <div className="mt-2 space-y-2 bg-surface-2/40 border border-border rounded p-3">
          <SkillRow label="Technical"       items={tech}   variant="primary" />
          <SkillRow label="Soft skills"     items={soft}   variant="muted" />
          <SkillRow label="Domain knowledge" items={domain} variant="muted" />
        </div>
      )}
    </div>
  );
}

export function SkillRow({
  label, items, variant }: {
  label: string;
  items: string[];
  variant: "primary" | "muted";
}) {
  if (items.length === 0) return null;
  const chipCls = variant === "primary"
    ? "bg-[var(--blue-light)] text-[var(--brand)] border-[var(--brand)]/20"
    : "bg-surface text-text-2 border-border";
  return (
    <div className="flex flex-col gap-1.5">
      <span className="w-fit text-micro font-semibold uppercase tracking-widest text-text-3 bg-surface border border-border rounded px-1.5 py-0.5">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {items.map((s) => (
          <span key={s} className={`text-caption px-1.5 py-0.5 rounded border ${chipCls}`}>{s}</span>
        ))}
      </div>
    </div>
  );
}
