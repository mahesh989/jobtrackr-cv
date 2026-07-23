/**
 * Pure helpers for the CV review form (split out of ReviewClient.tsx):
 * date labels, gap detection, create-mode validation, empty-row factories.
 */
import type {
  StructuredCv,
  StructuredCvExperience,
  StructuredCvEducation,
} from "@/lib/types";

export function joinDatesLabel(start: string, end: string, isCurrent: boolean): string {
  const s = (start || "").trim();
  const e = (end || "").trim();
  if (isCurrent && s) return `${s} – Present`;
  if (s && e) return `${s} – ${e}`;
  return s || e;
}

export function clientGaps(d: StructuredCv): string[] {
  const g: string[] = [];
  if (!d.summary) g.push("no profile summary");
  (d.experience || []).forEach((e, i) => {
    if (!e.start_date && !e.end_date) g.push(`role ${i + 1} dates missing`);
    if (!e.bullets || e.bullets.length === 0) g.push(`role ${i + 1} bullets missing`);
  });
  (d.education || []).forEach((e, i) => {
    if (!e.start_date && !e.end_date) g.push(`education ${i + 1} year missing`);
  });
  return g;
}

export function createGaps(d: StructuredCv): string[] {
  const g: string[] = [];
  (d.experience || []).forEach((e, i) => {
    const empty = !e.employer && !e.role && !e.start_date && !e.end_date
      && (e.bullets ?? []).every(b => !b.trim());
    if (empty) return;
    if (!e.start_date && !e.end_date) g.push(`role ${i + 1} dates missing`);
    if ((e.bullets ?? []).filter(b => b.trim()).length === 0) g.push(`role ${i + 1} bullets missing`);
  });
  (d.education || []).forEach((e, i) => {
    const empty = !e.institution && !e.qualification && !e.start_date && !e.end_date;
    if (empty) return;
    if (!e.start_date && !e.end_date) g.push(`education ${i + 1} year missing`);
  });
  return g;
}

// ── Create-mode required-field helpers ───────────────────────────────────────
export function expHasContent(e: StructuredCvExperience): boolean {
  return !!(e.employer.trim() || e.role.trim() || e.location.trim()
    || e.start_date.trim() || e.end_date.trim() || (e.bullets ?? []).some(b => b.trim()));
}
export function expComplete(e: StructuredCvExperience): boolean {
  return !!(e.employer.trim() && e.role.trim() && (e.start_date.trim() || e.end_date.trim())
    && (e.bullets ?? []).some(b => b.trim()));
}
export function eduHasContent(e: StructuredCvEducation): boolean {
  return !!(e.institution.trim() || e.qualification.trim() || e.location.trim()
    || e.start_date.trim() || e.end_date.trim());
}
export function eduComplete(e: StructuredCvEducation): boolean {
  return !!(e.institution.trim() && e.qualification.trim());
}

/** Mandatory-section validation for marking a built CV "Reviewed". Returns a
 *  list of human-readable problems (empty = valid). */
export function validateCreate(d: StructuredCv): string[] {
  const errs: string[] = [];
  const exps = d.experience ?? [];
  if (!exps.some(expComplete)) {
    errs.push("Add at least one role with an employer, dates and a bullet point.");
  }
  if (exps.some(e => expHasContent(e) && !expComplete(e))) {
    errs.push("Complete every role you've started (employer, role, dates and a bullet).");
  }
  const edus = d.education ?? [];
  if (!edus.some(eduComplete)) {
    errs.push("Add at least one education entry with an institution and qualification.");
  }
  if (edus.some(e => eduHasContent(e) && !eduComplete(e))) {
    errs.push("Complete every education entry you've started (institution and qualification).");
  }
  return errs;
}

export function emptyExperience(): StructuredCvExperience {
  return { employer: "", role: "", location: "", start_date: "", end_date: "", is_current: false, bullets: [""] };
}

export function emptyEducation(): StructuredCvEducation {
  return { institution: "", qualification: "", location: "", start_date: "", end_date: "", completed: false };
}
