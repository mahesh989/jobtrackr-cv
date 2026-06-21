"use client";

/**
 * CvReviewClient — post-upload review form.
 *
 * Forced step: every freshly-structurized CV is sent through here. Each
 * section is a collapsible card with an accent stripe + icon, themed to
 * the rest of the dashboard. Sections start expanded EXCEPT References,
 * which starts collapsed.
 *
 * On any edit, a 10-second debounced autosave PATCHes the structured CV
 * back to /api/cv/:id/structured. That endpoint re-renders the canonical
 * markdown via cv-backend and persists both `structured_cv` and
 * `normalized_cv_text` — the latter is what the analysis pipeline reads
 * next time the user runs an analysis (see /api/jobs/[id]/analyze).
 *
 * "Save & use this CV" forces an immediate save with verified=true and
 * collapses every section to a summary header. Smooth-scrolls to the
 * page top so the user lands on the header instead of stranded at the
 * (now near-empty) save bar.
 *
 * NOT an analysis step. The form purely rearranges the candidate's own
 * words into a consistent skeleton — no paraphrasing, no relevance
 * filtering. (The prompt enforces verbatim content; bullets and summary
 * sentences are copied character-for-character from the source CV.)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Plus, X,
  Sparkles, Briefcase, GraduationCap, Languages as LanguagesIcon,
  Trophy, BadgeCheck, Users, AlignLeft, FileText,
  type LucideIcon,
} from "lucide-react";
import type {
  StructuredCv,
  StructuredCvAward,
  StructuredCvLanguage,
  StructuredCvExperience,
  StructuredCvEducation,
  StructuredCvCertification,
  StructuredCvReferee,
} from "@/lib/cvBackend";
import { type SkillLabels, DEFAULT_SKILL_LABELS } from "@/lib/cv/skillLabels";

const AUTOSAVE_MS = 10_000;

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
type SectionKey =
  | "skills" | "summary" | "experience" | "education"
  | "languages" | "awards" | "certifications" | "references";

/** Sections that are opt-in when building a CV from scratch. References are
 *  intentionally excluded — referees live in My Details (profile-level
 *  ReferencesSection), the single source of truth, so the builder never adds a
 *  second referee editor. */
type OptionalKey = "skills" | "certifications" | "awards" | "languages";
const OPTIONAL_SECTIONS: { key: OptionalKey; label: string; icon: LucideIcon }[] = [
  { key: "skills",         label: "Skills",         icon: Sparkles },
  { key: "certifications", label: "Certifications", icon: BadgeCheck },
  { key: "awards",         label: "Awards",         icon: Trophy },
  { key: "languages",      label: "Languages",      icon: LanguagesIcon },
];

interface Props {
  cvId:                 string;
  label:                string;
  initialStructuredCv:  StructuredCv;
  initialStatus:        string;
  /** "create" = building from scratch (no summary, opt-in sections, activates
   *  the CV on save). Defaults to "review" — the post-upload tidy form. */
  mode?:                "review" | "create";
  /** Vertical-aware labels for the three skill buckets (from the user's
   *  role_families). Defaults to generic labels. */
  skillLabels?:         SkillLabels;
}

export function CvReviewClient({ cvId, label, initialStructuredCv, initialStatus, mode = "review", skillLabels = DEFAULT_SKILL_LABELS }: Props) {
  const router = useRouter();
  const isCreate = mode === "create";

  // In create mode the row arrives with empty arrays — seed one Experience and
  // one Education entry so the user lands on fields to fill, not empty states.
  const [doc, setDoc] = useState<StructuredCv>(() => {
    if (!isCreate) return initialStructuredCv;
    return {
      ...initialStructuredCv,
      experience: initialStructuredCv.experience.length > 0 ? initialStructuredCv.experience : [emptyExperience()],
      education:  initialStructuredCv.education.length  > 0 ? initialStructuredCv.education  : [emptyEducation()],
    };
  });
  const [status, setStatus] = useState<string>(initialStatus);
  const [save, setSave]     = useState<SaveStatus>("idle");
  const [err, setErr]       = useState<string | null>(null);

  // Create mode only: which opt-in sections the user has surfaced. Seed from
  // any that already carry content (re-opening a partially-built CV).
  const [enabledOptional, setEnabledOptional] = useState<Set<OptionalKey>>(() => {
    const s = new Set<OptionalKey>();
    const d = initialStructuredCv;
    if (d.skills.technical.length + d.skills.soft_skills.length + d.skills.domain_knowledge.length > 0) s.add("skills");
    if ((d.certifications ?? []).length > 0) s.add("certifications");
    if ((d.awards ?? []).length > 0) s.add("awards");
    if ((d.languages ?? []).length > 0) s.add("languages");
    return s;
  });
  const optionalShown = (k: OptionalKey) => enabledOptional.has(k);

  // Section open/closed state. Save & continue collapses everything; the
  // user can re-expand by clicking any header. References starts collapsed
  // by default (it's a secondary signal); everything else expanded.
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    skills:         true,
    summary:        true,
    experience:     true,
    education:      true,
    languages:      true,
    awards:         true,
    certifications: true,
    references:     false,
  });

  const toggle = (k: SectionKey) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const collapseAll = () =>
    setOpen({
      skills: false, summary: false, experience: false,
      education: false, languages: false, awards: false,
      certifications: false, references: false,
    });

  // Debounced autosave — pauses-then-saves so we don't spam the backend.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(async (next: StructuredCv, verified: boolean) => {
    setSave("saving");
    setErr(null);
    try {
      const res = await fetch(`/api/cv/${cvId}/structured`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ structured_cv: next, verified }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setSave("error");
        setErr(j.error ?? `Save failed (${res.status})`);
        return false;
      }
      const j = await res.json() as { structured_cv_status: string };
      setStatus(j.structured_cv_status);
      setSave("saved");
      return true;
    } catch (e) {
      setSave("error");
      setErr(e instanceof Error ? e.message : "Save failed");
      return false;
    }
  }, [cvId]);

  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    setSave("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { persist(doc, false); }, AUTOSAVE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [doc, persist]);

  async function saveAndCollapse() {
    if (timer.current) clearTimeout(timer.current);
    const ok = await persist(doc, true);
    if (ok) {
      collapseAll();
      // After collapsing, the page is much shorter — scroll to the top so
      // the user lands on the header instead of being stuck looking at the
      // (now near-empty) save bar.
      if (typeof window !== "undefined") {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }
  }

  // Create mode: verified-save, then make this the active CV and return to the
  // library so the user sees it ready to use. Activation failure is non-fatal —
  // the CV is saved and they can "Set active" from the library.
  async function saveAndUse() {
    if (timer.current) clearTimeout(timer.current);
    const ok = await persist(doc, true);
    if (!ok) return;
    try {
      await fetch(`/api/cv/${cvId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ is_active: true }),
      });
    } catch { /* non-fatal */ }
    router.push("/dashboard/cv");
  }

  const liveGaps = useMemo(() => isCreate ? createGaps(doc) : clientGaps(doc), [doc, isCreate]);

  // — patching helpers (immutable) —
  const patchExperience = (i: number, next: Partial<StructuredCvExperience>) =>
    setDoc(d => ({ ...d, experience: d.experience.map((e, idx) => idx === i ? { ...e, ...next } : e) }));
  const patchEducation = (i: number, next: Partial<StructuredCvEducation>) =>
    setDoc(d => ({ ...d, education: d.education.map((e, idx) => idx === i ? { ...e, ...next } : e) }));
  const patchAward = (i: number, next: Partial<StructuredCvAward>) =>
    setDoc(d => ({ ...d, awards: (d.awards ?? []).map((a, idx) => idx === i ? { ...a, ...next } : a) }));
  const addAward = () =>
    setDoc(d => ({ ...d, awards: [...(d.awards ?? []), { name: "", issuer: "", location: "", date: "", description: "" }] }));
  const removeAward = (i: number) =>
    setDoc(d => ({ ...d, awards: (d.awards ?? []).filter((_, idx) => idx !== i) }));
  const patchLanguage = (i: number, next: Partial<StructuredCvLanguage>) =>
    setDoc(d => ({ ...d, languages: (d.languages ?? []).map((l, idx) => idx === i ? { ...l, ...next } : l) }));
  const addLanguage = () =>
    setDoc(d => ({ ...d, languages: [...(d.languages ?? []), { language: "", proficiency: "" }] }));
  const removeLanguage = (i: number) =>
    setDoc(d => ({ ...d, languages: (d.languages ?? []).filter((_, idx) => idx !== i) }));
  const patchCert = (i: number, next: Partial<StructuredCvCertification>) =>
    setDoc(d => ({ ...d, certifications: d.certifications.map((c, idx) => idx === i ? { ...c, ...next } : c) }));
  const patchReferee = (i: number, next: Partial<StructuredCvReferee>) =>
    setDoc(d => ({ ...d, references: d.references.map((r, idx) => idx === i ? { ...r, ...next } : r) }));

  const setBullet = (roleIdx: number, bulletIdx: number, value: string) =>
    setDoc(d => ({
      ...d,
      experience: d.experience.map((e, i) =>
        i !== roleIdx ? e : { ...e, bullets: e.bullets.map((b, bi) => bi === bulletIdx ? value : b) },
      ),
    }));
  const addBullet = (roleIdx: number) =>
    setDoc(d => ({
      ...d,
      experience: d.experience.map((e, i) =>
        i !== roleIdx ? e : { ...e, bullets: [...e.bullets, ""] }),
    }));
  const removeBullet = (roleIdx: number, bulletIdx: number) =>
    setDoc(d => ({
      ...d,
      experience: d.experience.map((e, i) =>
        i !== roleIdx ? e : { ...e, bullets: e.bullets.filter((_, bi) => bi !== bulletIdx) }),
    }));

  const addSkill = (bucket: "domain_knowledge" | "soft_skills" | "technical", value: string) => {
    const v = value.trim().toLowerCase();
    if (!v) return;
    setDoc(d => ({
      ...d,
      skills: { ...d.skills, [bucket]: Array.from(new Set([...d.skills[bucket], v])) },
    }));
  };
  const removeSkill = (bucket: "domain_knowledge" | "soft_skills" | "technical", value: string) =>
    setDoc(d => ({
      ...d,
      skills: { ...d.skills, [bucket]: d.skills[bucket].filter(s => s !== value) },
    }));

  // — add/remove whole entries (used by create mode) —
  const addExperience = () =>
    setDoc(d => ({ ...d, experience: [...d.experience, emptyExperience()] }));
  const removeExperience = (i: number) =>
    setDoc(d => ({ ...d, experience: d.experience.filter((_, idx) => idx !== i) }));
  const addEducation = () =>
    setDoc(d => ({ ...d, education: [...d.education, emptyEducation()] }));
  const removeEducation = (i: number) =>
    setDoc(d => ({ ...d, education: d.education.filter((_, idx) => idx !== i) }));
  const addCertification = () =>
    setDoc(d => ({ ...d, certifications: [...d.certifications, { name: "", issuer: "", code: "", issued_date: "" }] }));
  const removeCertification = (i: number) =>
    setDoc(d => ({ ...d, certifications: d.certifications.filter((_, idx) => idx !== i) }));
  const addReferee = () =>
    setDoc(d => ({ ...d, references: [...d.references, { name: "", job_title: "", company: "", email: "" }] }));
  const removeReferee = (i: number) =>
    setDoc(d => ({ ...d, references: d.references.filter((_, idx) => idx !== i) }));

  // Create mode: surface an opt-in section, seed one empty entry, open it.
  const enableSection = (k: OptionalKey) => {
    setEnabledOptional(prev => new Set(prev).add(k));
    setOpen(o => ({ ...o, [k]: true }));
    if (k === "certifications" && doc.certifications.length === 0) addCertification();
    if (k === "awards"         && (doc.awards ?? []).length === 0) addAward();
    if (k === "languages"      && (doc.languages ?? []).length === 0) addLanguage();
  };

  return (
    <div className="pb-28">
      {/* HEADER — visual identity for the page */}
      <header className="mb-6 flex items-start gap-4">
        <div className="hidden sm:flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--brand)]/10 text-[var(--brand)] ring-1 ring-[var(--brand)]/20">
          <FileText className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          {isCreate ? (
            <>
              <p className="text-[11px] uppercase tracking-wider text-text-3 font-medium">New CV · built in app</p>
              <h1 className="text-[20px] sm:text-[22px] font-semibold text-text mt-0.5 leading-tight">Build your CV</h1>
              <p className="mt-1.5 text-[13px] text-text-2 leading-relaxed max-w-2xl">
                Add your experience and education, then add any other sections you need. We&apos;ll write the professional summary automatically when you tailor this CV to a job.
              </p>
            </>
          ) : (
            <>
              <p className="text-[11px] uppercase tracking-wider text-text-3 font-medium">Step 1 of 2 · before analysis</p>
              <h1 className="text-[20px] sm:text-[22px] font-semibold text-text mt-0.5 leading-tight">Review &amp; tidy your CV</h1>
              <p className="mt-1.5 text-[13px] text-text-2 leading-relaxed max-w-2xl">
                We rearranged <strong className="text-text font-medium">{label}</strong> into a consistent format using only your own words. Edit anything that&apos;s off — nothing was paraphrased or shortened.
              </p>
            </>
          )}
        </div>
        <div className="hidden sm:block shrink-0">
          <SaveBadge status={save} verified={status === "verified"} err={err} />
        </div>
      </header>

      {/* STATUS BANNER — pill style */}
      <div className="mb-6">
        {liveGaps.length > 0 ? (
          <div className="inline-flex items-center gap-2 rounded-full border border-red-500/40 bg-red-500/5 pl-2 pr-3.5 py-1 text-[12.5px] text-red-700 dark:text-red-300">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500/15">
              <AlertTriangle className="h-3 w-3 text-red-600" aria-hidden="true" />
            </span>
            <span><strong className="font-semibold">{liveGaps.length} item{liveGaps.length === 1 ? "" : "s"} need attention</strong> — review highlighted fields below</span>
          </div>
        ) : isCreate ? (
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-2)]/40 pl-2 pr-3.5 py-1 text-[12.5px] text-text-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--brand)]/10">
              <Sparkles className="h-3 w-3 text-[var(--brand)]" aria-hidden="true" />
            </span>
            <span>Fill in your details, then <strong className="font-semibold text-text">Save &amp; use this CV</strong>.</span>
          </div>
        ) : (
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/5 pl-2 pr-3.5 py-1 text-[12.5px] text-text">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15">
              <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-hidden="true" />
            </span>
            <span>All looks good</span>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {/* SKILLS — above summary per product call. Opt-in when building. */}
        {(!isCreate || optionalShown("skills")) && (
        <Section
          icon={Sparkles}
          title="Skills"
          meta={isCreate
            ? `${doc.skills.domain_knowledge.length + doc.skills.soft_skills.length + doc.skills.technical.length}`
            : `${doc.skills.domain_knowledge.length + doc.skills.soft_skills.length + doc.skills.technical.length} from your CV`}
          open={open.skills}
          onToggle={() => toggle("skills")}
        >
          <SkillsBucket label={skillLabels.domain_knowledge} tone="care"    bucket="domain_knowledge" items={doc.skills.domain_knowledge} onAdd={addSkill} onRemove={removeSkill} />
          <SkillsBucket label={skillLabels.soft_skills}      tone="soft"    bucket="soft_skills"      items={doc.skills.soft_skills}      onAdd={addSkill} onRemove={removeSkill} />
          <SkillsBucket label={skillLabels.technical}        tone="neutral" bucket="technical"        items={doc.skills.technical}        onAdd={addSkill} onRemove={removeSkill} />
        </Section>
        )}

        {/* SUMMARY — hidden when building; generated automatically at tailoring time. */}
        {!isCreate && (
        <Section
          icon={AlignLeft}
          title="Profile summary"
          meta={doc.summary ? `${doc.summary.split(/\s+/).filter(Boolean).length} words` : "empty"}
          open={open.summary}
          onToggle={() => toggle("summary")}
        >
          <GhostTextarea
            rows={4}
            value={doc.summary}
            onChange={v => setDoc(d => ({ ...d, summary: v }))}
            placeholder={doc.summary ? "" : "Optional — leave blank if your CV doesn't have one."}
          />
        </Section>
        )}

        {/* EXPERIENCE — timeline */}
        <Section
          icon={Briefcase}
          title="Experience"
          meta={doc.experience.length === 0 ? "empty" : `${doc.experience.length} role${doc.experience.length === 1 ? "" : "s"}`}
          open={open.experience}
          onToggle={() => toggle("experience")}
        >
          {doc.experience.length === 0 ? (
            <EmptyState icon={Briefcase} text="No roles found." />
          ) : (
            <ol className="relative">
              {doc.experience.map((e, i) => (
                <TimelineEntry
                  key={i}
                  dateLabel={joinDatesLabel(e.start_date, e.end_date, e.is_current)}
                  isFirst={i === 0}
                  isLast={i === doc.experience.length - 1}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <GhostField label="Employer" value={e.employer} onChange={v => patchExperience(i, { employer: v })} size="lg" />
                    </div>
                    {isCreate && doc.experience.length > 1 && (
                      <RemoveBtn label="Remove role" onClick={() => removeExperience(i)} />
                    )}
                  </div>
                  <Grid cols={3} mt>
                    <GhostField label="Role"     value={e.role}     onChange={v => patchExperience(i, { role: v })} />
                    <GhostField label="Location" value={e.location} onChange={v => patchExperience(i, { location: v })} />
                    <DatesField
                      start={e.start_date} end={e.end_date}
                      onStart={v => patchExperience(i, { start_date: v })}
                      onEnd={v => patchExperience(i, { end_date: v })}
                    />
                  </Grid>
                  <div className="mt-4">
                    <div className="text-[11px] uppercase tracking-wider text-text-3 font-medium mb-2">Bullets</div>
                    <div className="space-y-2">
                      {e.bullets.map((b, bi) => (
                        <BulletRow
                          key={bi}
                          value={b}
                          onChange={v => setBullet(i, bi, v)}
                          onRemove={() => removeBullet(i, bi)}
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => addBullet(i)}
                      className="inline-flex items-center gap-1.5 text-xs text-text-2 hover:text-text mt-2.5 rounded px-1.5 py-1 -ml-1.5 hover:bg-[var(--surface-2)]/60 transition-colors"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add bullet
                    </button>
                  </div>
                </TimelineEntry>
              ))}
            </ol>
          )}
          {isCreate && <AddBtn label="Add role" onClick={addExperience} />}
        </Section>

        {/* EDUCATION */}
        <Section
          icon={GraduationCap}
          title="Education"
          meta={doc.education.length === 0 ? "empty" : `${doc.education.length} entr${doc.education.length === 1 ? "y" : "ies"}`}
          open={open.education}
          onToggle={() => toggle("education")}
        >
          {doc.education.length === 0 ? (
            <EmptyState icon={GraduationCap} text="No education found." />
          ) : doc.education.map((e, i) => (
            <div key={i} className={`${i > 0 ? "pt-4 mt-4 border-t border-[var(--border)]/70" : ""}`}>
              {e._moved_from_certifications && (
                <span className="inline-flex items-center gap-1 mb-2 px-2 py-0.5 text-[11px] rounded-full border border-[var(--brand)]/30 bg-[var(--brand)]/5 text-text-2">
                  <BadgeCheck className="h-3 w-3 text-[var(--brand)]" />
                  Moved here from certifications
                </span>
              )}
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <GhostField label="Institution" value={e.institution} onChange={v => patchEducation(i, { institution: v })} size="lg" />
                </div>
                {isCreate && doc.education.length > 1 && (
                  <RemoveBtn label="Remove education" onClick={() => removeEducation(i)} />
                )}
              </div>
              <Grid cols={3} mt>
                <GhostField label="Qualification" value={e.qualification} onChange={v => patchEducation(i, { qualification: v })} />
                <GhostField label="Location"      value={e.location}      onChange={v => patchEducation(i, { location: v })} />
                <DatesField
                  start={e.start_date} end={e.end_date}
                  onStart={v => patchEducation(i, { start_date: v })}
                  onEnd={v => patchEducation(i, { end_date: v })}
                />
              </Grid>
              <label className="inline-flex items-center gap-2 mt-3 text-xs text-text-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="rounded border-[var(--border)] text-[var(--brand)] focus:ring-[var(--brand)]/30"
                  checked={e.completed}
                  onChange={ev => patchEducation(i, { completed: ev.target.checked })}
                />
                Completed
              </label>
            </div>
          ))}
          {isCreate && <AddBtn label="Add education" onClick={addEducation} />}
        </Section>

        {/* LANGUAGES — opt-in when building */}
        {(!isCreate || optionalShown("languages")) && (
        <Section
          icon={LanguagesIcon}
          title="Languages"
          meta={(doc.languages?.length ?? 0) === 0 ? "empty" : `${doc.languages.length}`}
          subtitle="Kept as record — not used in tailored CV"
          open={open.languages}
          onToggle={() => toggle("languages")}
        >
          {(doc.languages ?? []).length === 0 ? (
            <EmptyState icon={LanguagesIcon} text="No languages on your CV — optional." actionLabel="Add language" onAction={addLanguage} />
          ) : (
            <div className="space-y-2.5">
              {(doc.languages ?? []).map((l, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <GhostField label="Language"    value={l.language}    onChange={v => patchLanguage(i, { language: v })} />
                    <GhostField label="Proficiency" value={l.proficiency} onChange={v => patchLanguage(i, { proficiency: v })} />
                  </div>
                  <RemoveBtn label="Remove language" onClick={() => removeLanguage(i)} />
                </div>
              ))}
            </div>
          )}
          {(doc.languages ?? []).length > 0 && (
            <AddBtn label="Add language" onClick={addLanguage} />
          )}
        </Section>
        )}

        {/* AWARDS — opt-in when building */}
        {(!isCreate || optionalShown("awards")) && (
        <Section
          icon={Trophy}
          title="Awards"
          meta={(doc.awards?.length ?? 0) === 0 ? "empty" : `${doc.awards.length}`}
          subtitle="Recognitions, scholarships, honours"
          open={open.awards}
          onToggle={() => toggle("awards")}
        >
          {(doc.awards ?? []).length === 0 ? (
            <EmptyState icon={Trophy} text="No awards on your CV — optional." actionLabel="Add award" onAction={addAward} />
          ) : (doc.awards ?? []).map((a, i) => (
            <div key={i} className={`${i > 0 ? "pt-4 mt-4 border-t border-[var(--border)]/70" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <GhostField label="Name" value={a.name} onChange={v => patchAward(i, { name: v })} size="lg" />
                </div>
                <RemoveBtn label="Remove award" onClick={() => removeAward(i)} />
              </div>
              <Grid cols={3} mt>
                <GhostField label="Issuer"   value={a.issuer}   onChange={v => patchAward(i, { issuer: v })} />
                <GhostField label="Location" value={a.location} onChange={v => patchAward(i, { location: v })} />
                <GhostField label="Date"     value={a.date}     onChange={v => patchAward(i, { date: v })} />
              </Grid>
              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wider text-text-3 font-medium mb-1.5">Description <span className="normal-case tracking-normal text-text-3">(optional)</span></div>
                <GhostTextarea rows={2} value={a.description} onChange={v => patchAward(i, { description: v })} />
              </div>
            </div>
          ))}
          {(doc.awards ?? []).length > 0 && <AddBtn label="Add award" onClick={addAward} />}
        </Section>
        )}

        {/* CERTIFICATIONS — review: only shown if anything remained.
            create: opt-in, with add/remove. */}
        {(isCreate ? (optionalShown("certifications") || doc.certifications.length > 0) : doc.certifications.length > 0) && (
          <Section
            icon={BadgeCheck}
            title="Certifications & licences"
            meta={`${doc.certifications.length}`}
            subtitle="Care VET qualifications moved to Education automatically"
            open={open.certifications}
            onToggle={() => toggle("certifications")}
          >
            {doc.certifications.map((c, i) => (
              <div key={i} className={`${i > 0 ? "pt-4 mt-4 border-t border-[var(--border)]/70" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <GhostField label="Name" value={c.name} onChange={v => patchCert(i, { name: v })} size="lg" />
                  </div>
                  {isCreate && (
                    <RemoveBtn label="Remove certification" onClick={() => removeCertification(i)} />
                  )}
                </div>
                <Grid cols={3} mt>
                  <GhostField label="Issuer" value={c.issuer}      onChange={v => patchCert(i, { issuer: v })} />
                  <GhostField label="Code"   value={c.code}        onChange={v => patchCert(i, { code: v })} />
                  <GhostField label="Issued" value={c.issued_date} onChange={v => patchCert(i, { issued_date: v })} />
                </Grid>
              </div>
            ))}
            {isCreate && <AddBtn label="Add certification" onClick={addCertification} />}
          </Section>
        )}

        {/* REFERENCES — review mode only. When building, referees live in My
            Details (profile-level ReferencesSection), so the builder omits them. */}
        {!isCreate && (
        <Section
          icon={Users}
          title="References"
          meta={doc.references.length === 0 ? "none" : `${doc.references.length} referee${doc.references.length === 1 ? "" : "s"}`}
          open={open.references}
          onToggle={() => toggle("references")}
        >
          {doc.references.length === 0 ? (
            <EmptyState icon={Users} text="No referees on the CV — referees can stay on a separate sheet." />
          ) : doc.references.map((r, i) => (
            <div key={i} className={`${i > 0 ? "pt-4 mt-4 border-t border-[var(--border)]/70" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <Grid cols={2}>
                    <GhostField label="Name"      value={r.name}      onChange={v => patchReferee(i, { name: v })} />
                    <GhostField label="Email"     value={r.email}     onChange={v => patchReferee(i, { email: v })} />
                    <GhostField label="Job title" value={r.job_title} onChange={v => patchReferee(i, { job_title: v })} />
                    <GhostField label="Company"   value={r.company}   onChange={v => patchReferee(i, { company: v })} />
                  </Grid>
                </div>
                {isCreate && (
                  <RemoveBtn label="Remove referee" onClick={() => removeReferee(i)} />
                )}
              </div>
            </div>
          ))}
          {isCreate && <AddBtn label="Add referee" onClick={addReferee} />}
        </Section>
        )}

        {/* ADD-A-SECTION — create mode only: surface opt-in sections on demand. */}
        {isCreate && OPTIONAL_SECTIONS.some(s => !optionalShown(s.key)) && (
          <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)]/20 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wider text-text-3 font-medium mb-2">Add a section</div>
            <div className="flex flex-wrap gap-2">
              {OPTIONAL_SECTIONS.filter(s => !optionalShown(s.key)).map(s => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => enableSection(s.key)}
                  className="inline-flex items-center gap-1.5 text-[12.5px] rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-text hover:border-[var(--brand)]/50 hover:text-[var(--brand)] hover:bg-[var(--brand)]/5 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <s.icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* SLIM SAVE TOAST — sticky bottom, centred, doesn't span full width */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur-md shadow-lg pl-4 pr-1 py-1">
          <SaveBadge status={save} verified={status === "verified"} err={err} compact />
          <button
            type="button"
            onClick={isCreate ? saveAndUse : saveAndCollapse}
            disabled={save === "saving"}
            className="rounded-full bg-[var(--brand)] px-4 py-1.5 text-[13px] font-medium text-[var(--brand-fg)] hover:opacity-90 transition-opacity shrink-0 disabled:opacity-50"
          >
            Save &amp; use this CV
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── sub-components ─────────────────────────────────────────────────────────

function Section({
  icon: Icon, title, subtitle, meta, open, onToggle, children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  meta?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`group relative rounded-xl border bg-[var(--surface)] transition-all ${open ? "border-[var(--border)] shadow-sm" : "border-[var(--border)]/70 hover:border-[var(--border)] hover:shadow-sm"}`}>
      {/* Left accent stripe — only when open */}
      {open && (
        <span aria-hidden="true" className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full bg-[var(--brand)]/70" />
      )}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${open ? "bg-[var(--brand)]/10 text-[var(--brand)]" : "bg-[var(--surface-2)]/60 text-text-3 group-hover:bg-[var(--brand)]/10 group-hover:text-[var(--brand)]"}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14.5px] font-semibold text-text">{title}</span>
            {meta && (
              <span className="text-[11px] text-text-3 px-1.5 py-0.5 rounded-full bg-[var(--surface-2)]/60">
                {meta}
              </span>
            )}
          </div>
          {subtitle && <p className="text-[12px] text-text-3 mt-0.5 truncate">{subtitle}</p>}
        </div>
        {open
          ? <ChevronDown className="h-4 w-4 text-text-3 shrink-0" aria-hidden="true" />
          : <ChevronRight className="h-4 w-4 text-text-3 shrink-0" aria-hidden="true" />}
      </button>
      {open && <div className="px-4 pb-4 pt-1 space-y-3">{children}</div>}
    </section>
  );
}

function Grid({ cols = 2, mt, children }: { cols?: number; mt?: boolean; children: React.ReactNode }) {
  const colClass = cols === 3 ? "sm:grid-cols-3" : cols === 2 ? "sm:grid-cols-2" : "";
  return <div className={`grid gap-3 ${mt ? "mt-3" : ""} grid-cols-1 ${colClass}`}>{children}</div>;
}

/**
 * GhostField — ghost-style input that reads as text until hovered/focused.
 * Removes form chrome from the page; the CV reads like a document.
 */
function GhostField({
  label, value, onChange, size = "md",
}: { label: string; value: string; onChange: (v: string) => void; size?: "md" | "lg" }) {
  const sized = size === "lg" ? "text-[14.5px] font-semibold py-1" : "text-[13px] py-1";
  return (
    <label className="block group/field">
      <span className="text-[11px] uppercase tracking-wider text-text-3 font-medium block mb-0.5">{label}</span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`block w-full ${sized} text-text bg-transparent border-b border-transparent rounded-none px-1 -mx-1 hover:border-[var(--border)] hover:bg-[var(--surface-2)]/40 focus:bg-[var(--surface-2)]/50 focus:border-[var(--brand)]/70 focus:outline-none transition-colors`}
      />
    </label>
  );
}

function GhostTextarea({
  rows, value, onChange, placeholder,
}: { rows: number; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <textarea
      rows={rows}
      placeholder={placeholder}
      className="block w-full text-[13px] text-text bg-[var(--surface-2)]/30 border border-transparent rounded-lg px-3 py-2 hover:bg-[var(--surface-2)]/50 focus:bg-[var(--surface)] focus:border-[var(--brand)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/15 transition-colors resize-y leading-relaxed"
      value={value}
      onChange={e => onChange(e.target.value)}
    />
  );
}

function DatesField({ start, end, onStart, onEnd }: { start: string; end: string; onStart: (v: string) => void; onEnd: (v: string) => void }) {
  const blank = !start && !end;
  return (
    <div>
      <span className="text-[11px] uppercase tracking-wider text-text-3 font-medium block mb-0.5">
        Dates {blank && <span className="normal-case tracking-normal text-red-600 font-semibold">· missing</span>}
      </span>
      <div className="grid grid-cols-2 gap-1.5">
        <input
          type="text"
          value={start}
          onChange={e => onStart(e.target.value)}
          placeholder="Start"
          className="text-[13px] text-text bg-transparent border-b border-transparent rounded-none px-1 py-1 -mx-1 hover:border-[var(--border)] hover:bg-[var(--surface-2)]/40 focus:bg-[var(--surface-2)]/50 focus:border-[var(--brand)]/70 focus:outline-none transition-colors"
        />
        <input
          type="text"
          value={end}
          onChange={e => onEnd(e.target.value)}
          placeholder="End or Present"
          className="text-[13px] text-text bg-transparent border-b border-transparent rounded-none px-1 py-1 -mx-1 hover:border-[var(--border)] hover:bg-[var(--surface-2)]/40 focus:bg-[var(--surface-2)]/50 focus:border-[var(--brand)]/70 focus:outline-none transition-colors"
        />
      </div>
    </div>
  );
}

function BulletRow({ value, onChange, onRemove }: { value: string; onChange: (v: string) => void; onRemove: () => void }) {
  return (
    <div className="group/bullet flex items-start gap-2 -mx-1.5 px-1.5 py-1 rounded-md hover:bg-[var(--surface-2)]/30 transition-colors">
      <span className="mt-2 select-none text-[var(--brand)]/60 leading-none text-[10px]" aria-hidden="true">●</span>
      <textarea
        rows={1}
        className="flex-1 min-h-[28px] text-[13px] text-text bg-transparent border border-transparent rounded-md px-2 py-1 -mx-2 hover:bg-[var(--surface-2)]/40 focus:bg-[var(--surface)] focus:border-[var(--brand)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/15 transition-colors resize-y leading-relaxed"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove bullet"
        className="mt-1 text-text-3 hover:text-text p-1 opacity-0 group-hover/bullet:opacity-100 focus:opacity-100 transition-opacity"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

type SkillTone = "care" | "soft" | "neutral";

function SkillsBucket({
  label, tone, bucket, items, onAdd, onRemove,
}: {
  label: string;
  tone: SkillTone;
  bucket: "domain_knowledge" | "soft_skills" | "technical";
  items: string[];
  onAdd: (b: "domain_knowledge" | "soft_skills" | "technical", v: string) => void;
  onRemove: (b: "domain_knowledge" | "soft_skills" | "technical", v: string) => void;
}) {
  const [input, setInput] = useState("");
  const dotClass =
    tone === "care"    ? "bg-emerald-500" :
    tone === "soft"    ? "bg-amber-500"   :
                         "bg-text-3/60";
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
        <div className="text-[11px] uppercase tracking-wider text-text-3 font-medium">{label}</div>
        <span className="text-[11px] text-text-3">{items.length}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 items-center">
        {items.map(s => (
          <span key={s} className="group/chip inline-flex items-center gap-1 text-[12px] pl-2 pr-1 py-0.5 rounded-full bg-[var(--surface-2)]/80 border border-[var(--border)]/60 hover:border-[var(--border)] transition-colors">
            <span className="text-text">{s}</span>
            <button
              type="button"
              onClick={() => onRemove(bucket, s)}
              aria-label={`Remove ${s}`}
              className="text-text-3 hover:text-text rounded-full p-0.5"
            ><X className="h-3 w-3" /></button>
          </span>
        ))}
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); onAdd(bucket, input); setInput(""); }
          }}
          placeholder="add…"
          className="text-[12px] h-6 w-24 rounded-full border border-dashed border-[var(--border)] bg-transparent px-2.5 placeholder:text-text-3 focus:outline-none focus:border-[var(--brand)]/70 focus:bg-[var(--surface-2)]/40 transition-colors"
        />
      </div>
    </div>
  );
}

function TimelineEntry({
  dateLabel, isFirst, isLast, children,
}: {
  dateLabel: string;
  isFirst: boolean;
  isLast:  boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={`relative pl-6 sm:pl-8 ${isLast ? "" : "pb-6"}`}>
      {/* Vertical line connecting entries */}
      {!isLast && (
        <span aria-hidden="true" className="absolute left-[7px] sm:left-[9px] top-3 bottom-0 w-px bg-[var(--border)]" />
      )}
      {/* Dot — filled for first/current, hollow otherwise */}
      <span aria-hidden="true" className={`absolute left-[3px] sm:left-[5px] top-2.5 h-2 w-2 rounded-full ring-2 ring-[var(--surface)] ${isFirst ? "bg-[var(--brand)]" : "bg-[var(--border)]"}`} />
      {/* Date pill */}
      <div className="text-[11px] text-text-2 font-medium mb-2 -mt-0.5">{dateLabel || <span className="text-text-3 italic">no dates</span>}</div>
      <div>{children}</div>
    </li>
  );
}

function EmptyState({ icon: Icon, text, actionLabel, onAction }: {
  icon: LucideIcon; text: string; actionLabel?: string; onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-6 px-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-2)]/60 text-text-3 mb-2">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="text-[13px] text-text-3 max-w-xs">{text}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-3 inline-flex items-center gap-1.5 text-xs text-[var(--brand)] hover:underline"
        >
          <Plus className="h-3.5 w-3.5" /> {actionLabel}
        </button>
      )}
    </div>
  );
}

function AddBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-xs text-text-2 hover:text-text mt-3 rounded-md px-2 py-1 -ml-2 hover:bg-[var(--surface-2)]/60 transition-colors"
    >
      <Plus className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function RemoveBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="mt-5 text-text-3 hover:text-red rounded-md p-1 hover:bg-[var(--surface-2)]/60 transition-colors shrink-0"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

function SaveBadge({ status, verified, err, compact }: { status: SaveStatus; verified: boolean; err: string | null; compact?: boolean }) {
  const map: Record<SaveStatus, { text: string; tone: string; dot: string }> = {
    idle:   { text: verified ? "Verified" : "Saved",         tone: "text-text-2",  dot: "bg-emerald-500" },
    dirty:  { text: "Unsaved — autosaves in 10s",            tone: "text-text-2",  dot: "bg-text-3" },
    saving: { text: "Saving…",                               tone: "text-text-2",  dot: "bg-[var(--brand)] animate-pulse" },
    saved:  { text: verified ? "Verified" : "Saved",         tone: "text-text",    dot: "bg-emerald-500" },
    error:  { text: err ?? "Save failed",                    tone: "text-red",     dot: "bg-red-500" },
  };
  const m = map[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] ${m.tone} ${compact ? "" : ""}`}>
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.text}
    </span>
  );
}

function joinDatesLabel(start: string, end: string, isCurrent: boolean): string {
  const s = (start || "").trim();
  const e = (end || "").trim();
  if (isCurrent && s) return `${s} – Present`;
  if (s && e) return `${s} – ${e}`;
  return s || e;
}

// Lightweight client-side mirror of gap detection (the authoritative list is
// recomputed server-side on save).
function clientGaps(d: StructuredCv): string[] {
  const g: string[] = [];
  if (!d.summary)        g.push("no profile summary");
  (d.experience || []).forEach((e, i) => {
    if (!e.start_date && !e.end_date) g.push(`role ${i + 1} dates missing`);
    if (!e.bullets || e.bullets.length === 0) g.push(`role ${i + 1} bullets missing`);
  });
  (d.education || []).forEach((e, i) => {
    if (!e.start_date && !e.end_date) g.push(`education ${i + 1} year missing`);
  });
  return g;
}

// Create-mode gaps: no summary requirement (it's generated at tailoring time),
// and entirely-empty seeded rows don't count as gaps until the user fills them.
function createGaps(d: StructuredCv): string[] {
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

function emptyExperience(): StructuredCvExperience {
  return { employer: "", role: "", location: "", start_date: "", end_date: "", is_current: false, bullets: [""] };
}

function emptyEducation(): StructuredCvEducation {
  return { institution: "", qualification: "", location: "", start_date: "", end_date: "", completed: false };
}
