import {
  AlertTriangle, CheckCircle2, Plus, X,
  Sparkles, Languages as LanguagesIcon,
  Trophy, BadgeCheck, FolderGit2,
  type LucideIcon,
} from "lucide-react";
import { Button, Input } from "@/components/ui";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

/** Sections that are opt-in when building from scratch. References excluded —
 *  they live at profile level (My CV → References). */
export type OptionalKey = "skills" | "projects" | "certifications" | "awards" | "languages";
export const OPTIONAL_SECTIONS: { key: OptionalKey; label: string; icon: LucideIcon }[] = [
  { key: "skills",         label: "Skills",         icon: Sparkles },
  { key: "projects",       label: "Projects",       icon: FolderGit2 },
  { key: "certifications", label: "Certifications", icon: BadgeCheck },
  { key: "awards",         label: "Awards",         icon: Trophy },
  { key: "languages",      label: "Languages",      icon: LanguagesIcon },
];

/* ── ReviewStatusBanner ──────────────────────────────────────────────────── */

interface ReviewStatusBannerProps {
  isCreate: boolean;
  showErrors: boolean;
  validationErrors: string[];
  liveGaps: string[];
}

export function ReviewStatusBanner({ isCreate, showErrors, validationErrors, liveGaps }: ReviewStatusBannerProps) {
  return (
    <div className="mb-6">
      {isCreate && showErrors && validationErrors.length > 0 ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3.5 py-2.5 text-body text-red-700 dark:text-red-300 space-y-1">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-3.5 w-3.5 text-red-600" aria-hidden="true" />
            Before you can finish, please fix:
          </div>
          <ul className="list-disc pl-7 space-y-0.5">
            {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      ) : liveGaps.length > 0 && !isCreate ? (
        <div className="inline-flex items-center gap-2 rounded-full border border-red-500/40 bg-red-500/5 pl-2 pr-3.5 py-1 text-body text-red-700 dark:text-red-300">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500/15">
            <AlertTriangle className="h-3 w-3 text-red-600" aria-hidden="true" />
          </span>
          <span><strong className="font-semibold">{liveGaps.length} item{liveGaps.length === 1 ? "" : "s"} need attention</strong> — review highlighted fields below</span>
        </div>
      ) : isCreate ? (
        <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-2)]/40 pl-2 pr-3.5 py-1 text-body text-text-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--brand)]/10">
            <Sparkles className="h-3 w-3 text-[var(--brand)]" aria-hidden="true" />
          </span>
          <span><strong className="font-semibold text-text">Experience</strong> and <strong className="font-semibold text-text">Education</strong> are required to finish. Not done yet? <strong className="font-semibold text-text">Save as draft</strong> and come back later.</span>
        </div>
      ) : (
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/5 pl-2 pr-3.5 py-1 text-body text-text">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15">
            <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-hidden="true" />
          </span>
          <span>All looks good</span>
        </div>
      )}
    </div>
  );
}

/* ── SaveToast ───────────────────────────────────────────────────────────── */

interface SaveToastProps {
  save: SaveStatus;
  status: string;
  err: string | null;
  isCreate: boolean;
  cancelling: boolean;
  cancelCreate: () => void;
  saveDraft: () => void;
  saveFinish: () => void;
  /** Review mode only — navigate back to /cv. The unmount flush in
   *  ReviewClient saves any pending edits on the way out. */
  backToProfile?: () => void;
}

export function SaveToast({ save, status, err, isCreate, cancelling, cancelCreate, saveDraft, saveFinish, backToProfile }: SaveToastProps) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur-md shadow-lg pl-4 pr-1 py-1">
        <SaveBadge status={save} verified={status === "verified"} err={err} compact />
        {isCreate ? (
          <>
            <Button
              variant="default"
              size="sm"
              type="button"
              onClick={cancelCreate}
              disabled={save === "saving" || cancelling}
              className="rounded-full px-3.5 py-1.5 text-body font-medium"
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
            <Button
              variant="default"
              size="sm"
              type="button"
              onClick={saveDraft}
              disabled={save === "saving" || cancelling}
              className="rounded-full border px-3.5 py-1.5 text-body font-medium"
            >
              Save as draft
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={saveFinish}
              disabled={save === "saving" || cancelling}
              className="rounded-full px-4 py-1.5 text-body font-medium"
            >
              Save
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="blue"
              size="sm"
              type="button"
              onClick={saveDraft}
              disabled={save === "saving" || cancelling}
              className="rounded-full shrink-0"
            >
              Save as draft
            </Button>
            {backToProfile && (
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={backToProfile}
                disabled={save === "saving"}
                className="rounded-full px-4 py-1.5 text-body font-medium shrink-0"
              >
                Back to Profile
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── AddSectionPanel ─────────────────────────────────────────────────────── */

interface AddSectionPanelProps {
  isCreate: boolean;
  hasMoreOptional: boolean;
  addingCustom: boolean;
  optionalShown: (key: OptionalKey) => boolean;
  enableSection: (key: OptionalKey) => void;
  setAddingCustom: (v: boolean) => void;
  newSectName: string;
  setNewSectName: (v: string) => void;
  addCustomSection: () => void;
}

export function AddSectionPanel({
  isCreate, hasMoreOptional, addingCustom, optionalShown, enableSection,
  setAddingCustom, newSectName, setNewSectName, addCustomSection,
}: AddSectionPanelProps) {
  if (!isCreate || (!hasMoreOptional && addingCustom)) return null;
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)]/20 px-4 py-3">
      <div className="text-caption uppercase tracking-wider text-text-3 font-medium mb-2">Add a section</div>
      <div className="flex flex-wrap gap-2 items-center">
        {OPTIONAL_SECTIONS.filter(s => !optionalShown(s.key)).map(s => (
          <Button
            variant="default"
            size="sm"
            key={s.key}
            onClick={() => enableSection(s.key)}
            className="inline-flex items-center gap-1.5 text-body rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-text hover:border-[var(--brand)]/50 hover:text-[var(--brand)] hover:bg-[var(--brand)]/5 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            <s.icon className="h-3.5 w-3.5" aria-hidden="true" />
            {s.label}
          </Button>
        ))}

        {/* Custom section — inline name input */}
        {addingCustom ? (
          <div className="flex items-center gap-2">
            <Input
              type="text"
              autoFocus
              placeholder="Section name…"
              value={newSectName}
              onChange={e => setNewSectName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter")  { e.preventDefault(); addCustomSection(); }
                if (e.key === "Escape") { setAddingCustom(false); setNewSectName(""); }
              }}
              className="text-body h-7 rounded-full border border-[var(--brand)]/60 bg-[var(--surface)] px-3 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/15 w-44 transition-colors"
              aria-label="Section name"
            />
            <Button
              variant="default"
              size="sm"
              onClick={addCustomSection}
              className="inline-flex items-center gap-1 text-label rounded-full border border-[var(--brand)]/40 bg-[var(--brand)]/5 text-[var(--brand)] px-3 py-1 hover:bg-[var(--brand)]/10 transition-colors"
            >
              Add
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => { setAddingCustom(false); setNewSectName(""); }}
              className="text-text-3 hover:text-text p-1 rounded-full transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            variant="default"
            size="sm"
            type="button"
            onClick={() => setAddingCustom(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed"
          >
            <Plus className="h-3.5 w-3.5" /> Custom section
          </Button>
        )}
      </div>
    </div>
  );
}

/* ── SaveBadge ───────────────────────────────────────────────────────────── */

export function SaveBadge({ status, verified, err, compact }: {
  status: SaveStatus; verified: boolean; err: string | null; compact?: boolean;
}) {
  const map: Record<SaveStatus, { text: string; tone: string; dot: string }> = {
    idle:   { text: verified ? "Verified" : "Saved",        tone: "text-text-2", dot: "bg-emerald-500" },
    dirty:  { text: "Unsaved — autosaves in 10s",           tone: "text-text-2", dot: "bg-text-3" },
    saving: { text: "Saving…",                              tone: "text-text-2", dot: "bg-[var(--brand)] animate-pulse" },
    saved:  { text: verified ? "Verified" : "Saved",        tone: "text-text",   dot: "bg-emerald-500" },
    error:  { text: err ?? "Save failed",                   tone: "text-red-500",dot: "bg-red-500" },
  };
  const m = map[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-label ${m.tone} ${compact ? "" : ""}`}>
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.text}
    </span>
  );
}
