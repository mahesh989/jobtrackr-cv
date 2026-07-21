"use client";

/**
 * ReviewClient — post-upload review form + create-from-scratch editor.
 *
 * Review mode  ("review"): post-upload tidy form; autosave on edit; Save
 *   button collapses all sections and marks the CV verified.
 * Create mode ("create"): blank CV builder; no autosave; Save button persists
 *   + redirects to My CV page where the user can set it as active.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronDown, ChevronRight, Plus, X,
  Sparkles, Briefcase, GraduationCap, Languages as LanguagesIcon,
  Trophy, BadgeCheck, Users, AlignLeft, FileText, ArrowLeft, Loader2,
  FolderGit2, ExternalLink,
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
  StructuredCvProject,
  CustomCvSection,
} from "@/lib/cvBackend";
import { type SkillLabels, DEFAULT_SKILL_LABELS } from "@/lib/cv/skillLabels";
import { Input, Textarea, IconButton } from "@/components/ui";
import {
  ReviewStatusBanner, SaveToast, AddSectionPanel, SaveBadge,
  OPTIONAL_SECTIONS,
  type SaveStatus, type OptionalKey,
} from "./ReviewComponents";

const AUTOSAVE_MS = 10_000;

type SectionKey =
  | "skills" | "summary" | "experience" | "education"
  | "projects" | "languages" | "awards" | "certifications" | "references";

interface Props {
  cvId:                string;
  label:               string;
  initialStructuredCv: StructuredCv;
  initialStatus:       string;
  mode?:               "review" | "create";
  skillLabels?:        SkillLabels;
}

export function ReviewClient({
  cvId, label, initialStructuredCv, initialStatus,
  mode = "review", skillLabels = DEFAULT_SKILL_LABELS,
}: Props) {
  const router   = useRouter();
  const isCreate = mode === "create";

  const [doc, setDoc] = useState<StructuredCv>(() => {
    if (!isCreate) return initialStructuredCv;
    return {
      ...initialStructuredCv,
      experience: initialStructuredCv.experience.length > 0 ? initialStructuredCv.experience : [emptyExperience()],
      education:  initialStructuredCv.education.length  > 0 ? initialStructuredCv.education  : [emptyEducation()],
    };
  });
  const [status, setStatus] = useState<string>(initialStatus);
  const [save,   setSave]   = useState<SaveStatus>("idle");
  const [err,    setErr]    = useState<string | null>(null);

  // Create mode: which opt-in sections are currently shown.
  const [enabledOptional, setEnabledOptional] = useState<Set<OptionalKey>>(() => {
    const s = new Set<OptionalKey>();
    const d = initialStructuredCv;
    if (d.skills.technical.length + d.skills.soft_skills.length + d.skills.domain_knowledge.length > 0) s.add("skills");
    if ((d.projects ?? []).length > 0) s.add("projects");
    if ((d.certifications ?? []).length > 0) s.add("certifications");
    if ((d.awards ?? []).length > 0) s.add("awards");
    if ((d.languages ?? []).length > 0) s.add("languages");
    return s;
  });

  // Custom sections — stored in structured_cv.custom_sections (jsonb extra field).
  const [customSects, setCustomSects] = useState<CustomCvSection[]>(
    () => (initialStructuredCv as { custom_sections?: CustomCvSection[] }).custom_sections ?? []
  );
  const [addingCustom, setAddingCustom] = useState(false);
  const [newSectName,  setNewSectName]  = useState("");

  const optionalShown = (k: OptionalKey) => enabledOptional.has(k);

  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    skills: true, summary: true, experience: true, education: true,
    projects: true, languages: true, awards: true, certifications: true, references: true,
  });
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});

  const toggle     = (k: SectionKey) => setOpen(o => ({ ...o, [k]: !o[k] }));

  // Deep-link support — Profile > Details links here with ?section=references
  // so the referee note's "Review form" link lands the user on an already-
  // open, scrolled-to References block instead of a collapsed one at the top.
  const searchParams = useSearchParams();
  useEffect(() => {
    const target = searchParams.get("section");
    if (target !== "references") return;
    const t = setTimeout(() => {
      document.getElementById("references")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
    return () => clearTimeout(t);
  }, [searchParams]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(async (next: StructuredCv, cs: CustomCvSection[], verified: boolean) => {
    setSave("saving");
    setErr(null);
    try {
      const payload = { ...next, custom_sections: cs };
      const res = await fetch(`/api/cv/${cvId}/structured`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ structured_cv: payload, verified }),
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
    // Create mode: no autosave — user saves explicitly via the Save button.
    if (isCreate) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSave("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { persist(doc, customSects, false); }, AUTOSAVE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [doc, customSects, persist, isCreate]);

  // Create-mode validation — Experience and Education are mandatory before a
  // CV can be marked "Reviewed". Drafts skip this entirely.
  const [showErrors, setShowErrors] = useState(false);
  const validationErrors = useMemo(() => validateCreate(doc), [doc]);

  // Once the user has saved in create mode, Cancel must NOT delete the draft.
  const savedRef = useRef(false);
  // Was this CV blank when the builder opened? (i.e. freshly created, never
  // filled in). Only then does Cancel discard it — an existing draft opened
  // for editing keeps its content when cancelled.
  const initiallyEmpty = useRef(
    isCreate &&
    initialStructuredCv.experience.length === 0 &&
    initialStructuredCv.education.length === 0 &&
    !(initialStructuredCv.summary ?? "").trim(),
  );

  // Return to My CV scrolled to this CV's card (both flows land here on save).
  const returnToCard = () => router.push(`/cv#cv-${cvId}`);

  // Create mode: save as draft — no validation, stays unverified. User can
  // come back and finish later.
  async function saveDraft() {
    if (timer.current) clearTimeout(timer.current);
    const ok = await persist(doc, customSects, false);
    if (ok) { savedRef.current = true; returnToCard(); }
  }

  // Create mode: finish — validate mandatory sections, mark verified, return.
  async function saveFinish() {
    if (validationErrors.length > 0) {
      setShowErrors(true);
      // Open the sections that have problems and scroll to the top.
      setOpen(o => ({ ...o, experience: true, education: true }));
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    const ok = await persist(doc, customSects, true);
    if (ok) { savedRef.current = true; returnToCard(); }
  }

  // Create mode: cancel — discard the never-saved blank draft, then return.
  const [cancelling, setCancelling] = useState(false);
  async function cancelCreate() {
    if (timer.current) clearTimeout(timer.current);
    if (initiallyEmpty.current && !savedRef.current) {
      setCancelling(true);
      try {
        await fetch(`/api/cv/${cvId}`, { method: "DELETE" });
      } catch {
        /* best-effort — even if the delete fails, don't trap the user here */
      }
    }
    router.push("/cv");
  }

  const liveGaps = useMemo(() => isCreate ? createGaps(doc) : clientGaps(doc), [doc, isCreate]);

  // Field-level red-border flags (create mode, after a failed "Save" attempt).
  const noCompleteExp = isCreate && !doc.experience.some(expComplete);
  const noCompleteEdu = isCreate && !doc.education.some(eduComplete);
  const expFieldErr = (i: number, field: "employer" | "role" | "dates" | "bullets"): boolean => {
    if (!isCreate || !showErrors) return false;
    const e = doc.experience[i];
    const flagged = expHasContent(e) || (i === 0 && noCompleteExp);
    if (!flagged) return false;
    if (field === "employer") return !e.employer.trim();
    if (field === "role")     return !e.role.trim();
    if (field === "dates")    return !(e.start_date.trim() || e.end_date.trim());
    return !(e.bullets ?? []).some(b => b.trim());
  };
  const eduFieldErr = (i: number, field: "institution" | "qualification"): boolean => {
    if (!isCreate || !showErrors) return false;
    const e = doc.education[i];
    const flagged = eduHasContent(e) || (i === 0 && noCompleteEdu);
    if (!flagged) return false;
    if (field === "institution") return !e.institution.trim();
    return !e.qualification.trim();
  };

  // — patching helpers —
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
    setDoc(d => ({ ...d, experience: d.experience.map((e, i) =>
      i !== roleIdx ? e : { ...e, bullets: e.bullets.map((b, bi) => bi === bulletIdx ? value : b) }) }));
  const addBullet = (roleIdx: number) =>
    setDoc(d => ({ ...d, experience: d.experience.map((e, i) =>
      i !== roleIdx ? e : { ...e, bullets: [...e.bullets, ""] }) }));
  const removeBullet = (roleIdx: number, bulletIdx: number) =>
    setDoc(d => ({ ...d, experience: d.experience.map((e, i) =>
      i !== roleIdx ? e : { ...e, bullets: e.bullets.filter((_, bi) => bi !== bulletIdx) }) }));

  const addSkill = (bucket: "domain_knowledge" | "soft_skills" | "technical", value: string) => {
    const v = value.trim().toLowerCase();
    if (!v) return;
    setDoc(d => ({ ...d, skills: { ...d.skills, [bucket]: Array.from(new Set([...d.skills[bucket], v])) } }));
  };
  const removeSkill = (bucket: "domain_knowledge" | "soft_skills" | "technical", value: string) =>
    setDoc(d => ({ ...d, skills: { ...d.skills, [bucket]: d.skills[bucket].filter(s => s !== value) } }));

  const addExperience    = () => setDoc(d => ({ ...d, experience:     [...d.experience, emptyExperience()] }));
  const removeExperience = (i: number) => setDoc(d => ({ ...d, experience: d.experience.filter((_, idx) => idx !== i) }));
  const addEducation     = () => setDoc(d => ({ ...d, education:      [...d.education, emptyEducation()] }));
  const removeEducation  = (i: number) => setDoc(d => ({ ...d, education: d.education.filter((_, idx) => idx !== i) }));
  const addCertification = () => setDoc(d => ({ ...d, certifications: [...d.certifications, { name: "", issuer: "", code: "", issued_date: "" }] }));
  const removeCertification = (i: number) => setDoc(d => ({ ...d, certifications: d.certifications.filter((_, idx) => idx !== i) }));
  const addReferee = () => setDoc(d => ({ ...d, references: [...d.references, { name: "", job_title: "", company: "", email: "" }] }));
  const removeReferee = (i: number) => setDoc(d => ({ ...d, references: (d.references ?? []).filter((_, idx) => idx !== i) }));
  const patchProject = (i: number, next: Partial<StructuredCvProject>) =>
    setDoc(d => ({ ...d, projects: (d.projects ?? []).map((p, idx) => idx === i ? { ...p, ...next } : p) }));
  const addProject = () =>
    setDoc(d => ({ ...d, projects: [...(d.projects ?? []), { name: "", url: "", description: "" }] }));
  const removeProject = (i: number) =>
    setDoc(d => ({ ...d, projects: (d.projects ?? []).filter((_, idx) => idx !== i) }));

  const enableSection = (k: OptionalKey) => {
    setEnabledOptional(prev => new Set(prev).add(k));
    setOpen(o => ({ ...o, [k]: true }));
    if (k === "projects"       && (doc.projects ?? []).length === 0) addProject();
    if (k === "certifications" && doc.certifications.length === 0) addCertification();
    if (k === "awards"         && (doc.awards ?? []).length === 0) addAward();
    if (k === "languages"      && (doc.languages ?? []).length === 0) addLanguage();
  };

  const disableSection = (k: OptionalKey) => {
    setEnabledOptional(prev => { const n = new Set(prev); n.delete(k); return n; });
    if (k === "skills")         setDoc(d => ({ ...d, skills: { domain_knowledge: [], soft_skills: [], technical: [] } }));
    if (k === "projects")       setDoc(d => ({ ...d, projects: [] }));
    if (k === "certifications") setDoc(d => ({ ...d, certifications: [] }));
    if (k === "awards")         setDoc(d => ({ ...d, awards: [] }));
    if (k === "languages")      setDoc(d => ({ ...d, languages: [] }));
  };

  // Custom section helpers
  const addCustomSection = () => {
    const title = newSectName.trim();
    if (!title) return;
    const id = `cs_${cvId}_${customSects.length}_${title.replace(/\s+/g, "_").slice(0, 20)}`;
    setCustomSects(cs => [...cs, { id, title, fields: [{ label: "", value: "" }] }]);
    setCustomOpen(o => ({ ...o, [id]: true }));
    setNewSectName("");
    setAddingCustom(false);
  };
  const removeCustomSection = (id: string) =>
    setCustomSects(cs => cs.filter(s => s.id !== id));
  const patchCustomField = (sectId: string, fi: number, next: Partial<{ label: string; value: string }>) =>
    setCustomSects(cs => cs.map(s => s.id !== sectId ? s : {
      ...s, fields: s.fields.map((f, idx) => idx === fi ? { ...f, ...next } : f),
    }));
  const addCustomField = (sectId: string) =>
    setCustomSects(cs => cs.map(s => s.id !== sectId ? s : { ...s, fields: [...s.fields, { label: "", value: "" }] }));
  const removeCustomField = (sectId: string, fi: number) =>
    setCustomSects(cs => cs.map(s => s.id !== sectId ? s : { ...s, fields: s.fields.filter((_, idx) => idx !== fi) }));

  const hasMoreOptional = OPTIONAL_SECTIONS.some(s => !optionalShown(s.key));

  // Create mode — AI skill extraction from experience/education text.
  const [extractingSkills, setExtractingSkills] = useState(false);
  const [extractSkillsErr, setExtractSkillsErr] = useState<string | null>(null);

  async function handleExtractSkills() {
    setExtractingSkills(true);
    setExtractSkillsErr(null);
    // Build text from the current doc without requiring a prior save.
    const expLines = doc.experience.flatMap(e => [
      `${e.role} at ${e.employer}`,
      ...e.bullets.filter(b => b.trim()).map(b => `- ${b}`),
    ]);
    const eduLines = doc.education.map(e =>
      [e.qualification, e.institution].filter(Boolean).join(" at ")
    );
    const builtText = [...expLines, ...eduLines].join("\n").trim();
    try {
      const res = await fetch(`/api/cv/${cvId}/extract-skills`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ cv_text: builtText.length >= 50 ? builtText : undefined }),
      });
      const j = await res.json() as { domain_knowledge?: string[]; soft_skills?: string[]; technical?: string[]; error?: string };
      if (!res.ok) { setExtractSkillsErr(j.error ?? "Extraction failed"); return; }
      // Merge suggestions into existing buckets (deduplicate).
      setDoc(d => ({
        ...d,
        skills: {
          domain_knowledge: Array.from(new Set([...d.skills.domain_knowledge, ...(j.domain_knowledge ?? [])])),
          soft_skills:      Array.from(new Set([...d.skills.soft_skills,      ...(j.soft_skills      ?? [])])),
          technical:        Array.from(new Set([...d.skills.technical,         ...(j.technical         ?? [])])),
        },
      }));
    } catch (e) {
      setExtractSkillsErr(e instanceof Error ? e.message : "Extraction failed");
    } finally {
      setExtractingSkills(false);
    }
  }

  return (
    <div className="pb-28">
      {/* HEADER */}
      <header className="mb-6 flex items-start gap-4">
        <div className="hidden sm:flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--brand)]/10 text-[var(--brand)] ring-1 ring-[var(--brand)]/20">
          <FileText className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <button type="button" onClick={() => router.push("/cv")} className="inline-flex items-center gap-1 text-label text-text-3 hover:text-text transition-colors mb-2"><ArrowLeft className="h-3.5 w-3.5" /> 
            Back to Profile
          </button>
          {isCreate ? (
            <>
              <p className="text-caption uppercase tracking-wider text-text-3 font-medium">New CV · built in app</p>
              <h1 className="text-h2 sm:text-h1 font-semibold text-text mt-0.5 leading-tight">Build your CV</h1>
              <p className="mt-1.5 text-body text-text-2 leading-relaxed max-w-2xl">
                Add your experience and education, then add any other sections you need. We&apos;ll write the professional summary automatically when you tailor this CV to a job.
              </p>
            </>
          ) : (
            <>
              <p className="text-caption uppercase tracking-wider text-text-3 font-medium">Step 1 of 2 · before analysis</p>
              <h1 className="text-h2 sm:text-h1 font-semibold text-text mt-0.5 leading-tight">Review &amp; tidy your CV</h1>
              <p className="mt-1.5 text-body text-text-2 leading-relaxed max-w-2xl">
                We rearranged <strong className="text-text font-medium">{label}</strong> into a consistent format using only your own words. Edit anything that&apos;s off — nothing was paraphrased or shortened.
              </p>
            </>
          )}
        </div>
        <div className="hidden sm:block shrink-0">
          <SaveBadge status={save} verified={status === "verified"} err={err} />
        </div>
      </header>

      {/* STATUS BANNER */}
      <ReviewStatusBanner
        isCreate={isCreate}
        showErrors={showErrors}
        validationErrors={validationErrors}
        liveGaps={liveGaps}
      />

      <div className="space-y-3">

        {/* SKILLS — opt-in when building */}
        {(!isCreate || optionalShown("skills")) && (
          <Section
            icon={Sparkles}
            title="Skills"
            meta={isCreate
              ? `${doc.skills.domain_knowledge.length + doc.skills.soft_skills.length + doc.skills.technical.length}`
              : `${doc.skills.domain_knowledge.length + doc.skills.soft_skills.length + doc.skills.technical.length} from your CV`}
            open={open.skills}
            onToggle={() => toggle("skills")}
            onClose={isCreate ? () => disableSection("skills") : undefined}
          >
            <SkillsBucket label={skillLabels.domain_knowledge} tone="care"    bucket="domain_knowledge" items={doc.skills.domain_knowledge} onAdd={addSkill} onRemove={removeSkill} />
            <SkillsBucket label={skillLabels.soft_skills}      tone="soft"    bucket="soft_skills"      items={doc.skills.soft_skills}      onAdd={addSkill} onRemove={removeSkill} />
            <SkillsBucket label={skillLabels.technical}        tone="neutral" bucket="technical"        items={doc.skills.technical}        onAdd={addSkill} onRemove={removeSkill} />
            {/* Create mode: AI extraction from experience bullets */}
            {isCreate && (
              <div className="pt-2 border-t border-[var(--border)]/50 flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={handleExtractSkills}
                  disabled={extractingSkills}
                  className="inline-flex items-center gap-1.5 text-label text-[var(--brand)] hover:underline disabled:opacity-50 disabled:no-underline"
                >
                  {extractingSkills
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Extracting…</>
                    : <><Sparkles className="h-3.5 w-3.5" /> Suggest from experience</>
                  }
                </button>
                <span className="text-caption text-text-3">AI reads your bullets and suggests skills — you can remove any that don&apos;t fit.</span>
                {extractSkillsErr && (
                  <p className="w-full text-caption text-red-600">{extractSkillsErr}</p>
                )}
              </div>
            )}
          </Section>
        )}

        {/* SUMMARY — review mode only; auto-generated in create mode */}
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

        {/* EXPERIENCE */}
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
                      <GhostField label="Employer" value={e.employer} onChange={v => patchExperience(i, { employer: v })} size="lg" required={isCreate} invalid={expFieldErr(i, "employer")} />
                    </div>
                    {doc.experience.length > 1 && (
                      <RemoveBtn label="Remove role" onClick={() => removeExperience(i)} />
                    )}
                  </div>
                  <Grid cols={3} mt>
                    <GhostField label="Role"     value={e.role}     onChange={v => patchExperience(i, { role: v })} required={isCreate} invalid={expFieldErr(i, "role")} />
                    <GhostField label="Location" value={e.location} onChange={v => patchExperience(i, { location: v })} />
                    <DatesField
                      start={e.start_date} end={e.end_date}
                      onStart={v => patchExperience(i, { start_date: v })}
                      onEnd={v => patchExperience(i, { end_date: v })}
                      invalid={expFieldErr(i, "dates")}
                    />
                  </Grid>
                  <div className="mt-4">
                    <div className="text-caption uppercase tracking-wider font-medium mb-2">
                      <span className={expFieldErr(i, "bullets") ? "text-red-600" : "text-text-3"}>
                        Bullets{isCreate && <span className="text-red-500 ml-0.5">*</span>}
                        {expFieldErr(i, "bullets") && <span className="normal-case tracking-normal ml-1.5">· add at least one</span>}
                      </span>
                    </div>
                    <div className="space-y-2 ml-1">
                      {e.bullets.map((b, bi) => (
                        <BulletRow
                          key={bi}
                          value={b}
                          onChange={v => setBullet(i, bi, v)}
                          onRemove={() => removeBullet(i, bi)}
                        />
                      ))}
                    </div>
                    <AddBtn label="Add bullet" onClick={() => addBullet(i)} />
                  </div>
                </TimelineEntry>
              ))}
            </ol>
          )}
          <AddBtn label="Add role" onClick={addExperience} />
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
                <span className="inline-flex items-center gap-1 mb-2 px-2 py-0.5 text-caption rounded-full border border-[var(--brand)]/30 bg-[var(--brand)]/5 text-text-2">
                  <BadgeCheck className="h-3 w-3 text-[var(--brand)]" />
                  Moved here from certifications
                </span>
              )}
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <GhostField label="Institution" value={e.institution} onChange={v => patchEducation(i, { institution: v })} size="lg" required={isCreate} invalid={eduFieldErr(i, "institution")} />
                </div>
                {doc.education.length > 1 && (
                  <RemoveBtn label="Remove education" onClick={() => removeEducation(i)} />
                )}
              </div>
              <Grid cols={3} mt>
                <GhostField label="Qualification" value={e.qualification} onChange={v => patchEducation(i, { qualification: v })} required={isCreate} invalid={eduFieldErr(i, "qualification")} />
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
          <AddBtn label="Add education" onClick={addEducation} />
        </Section>

        {/* PROJECTS — opt-in when building */}
        {(isCreate ? optionalShown("projects") : (doc.projects ?? []).length > 0) && (
          <Section
            icon={FolderGit2}
            title="Projects"
            meta={(doc.projects?.length ?? 0) === 0 ? "empty" : `${doc.projects!.length}`}
            subtitle="Portfolio / side projects — the AI references relevant ones per role"
            open={open.projects}
            onToggle={() => toggle("projects")}
            onClose={isCreate ? () => disableSection("projects") : undefined}
          >
            {(doc.projects ?? []).length === 0 ? (
              <EmptyState icon={FolderGit2} text="No projects yet — optional." actionLabel="Add project" onAction={addProject} />
            ) : (doc.projects ?? []).map((p, i) => (
              <div key={i} className={`${i > 0 ? "pt-4 mt-4 border-t border-[var(--border)]/70" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <GhostField label="Name" value={p.name} onChange={v => patchProject(i, { name: v })} size="lg" />
                  </div>
                  <RemoveBtn label="Remove project" onClick={() => removeProject(i)} />
                </div>
                <Grid cols={1} mt>
                  <div className="flex items-end gap-1.5">
                    <div className="flex-1 min-w-0">
                      <GhostField label="URL" value={p.url} onChange={v => patchProject(i, { url: v })} />
                    </div>
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noopener noreferrer" className="mb-1.5 shrink-0 text-text-3 hover:text-[var(--brand)]" aria-label="Open project URL">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                </Grid>
                <div className="mt-3">
                  <div className="text-caption uppercase tracking-wider text-text-3 font-medium mb-1.5">
                    Description <span className="normal-case tracking-normal text-text-3">(optional)</span>
                  </div>
                  <GhostTextarea rows={2} value={p.description} onChange={v => patchProject(i, { description: v })} />
                </div>
              </div>
            ))}
            {(doc.projects ?? []).length > 0 && <AddBtn label="Add project" onClick={addProject} />}
          </Section>
        )}

        {/* LANGUAGES — opt-in when building */}
        {(!isCreate || optionalShown("languages")) && (
          <Section
            icon={LanguagesIcon}
            title="Languages"
            meta={(doc.languages?.length ?? 0) === 0 ? "empty" : `${doc.languages.length}`}
            subtitle="Kept as record — not used in tailored CV"
            open={open.languages}
            onToggle={() => toggle("languages")}
            onClose={isCreate ? () => disableSection("languages") : undefined}
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
            {(doc.languages ?? []).length > 0 && <AddBtn label="Add language" onClick={addLanguage} />}
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
            onClose={isCreate ? () => disableSection("awards") : undefined}
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
                  <div className="text-caption uppercase tracking-wider text-text-3 font-medium mb-1.5">
                    Description <span className="normal-case tracking-normal text-text-3">(optional)</span>
                  </div>
                  <GhostTextarea rows={2} value={a.description} onChange={v => patchAward(i, { description: v })} />
                </div>
              </div>
            ))}
            {(doc.awards ?? []).length > 0 && <AddBtn label="Add award" onClick={addAward} />}
          </Section>
        )}

        {/* CERTIFICATIONS */}
        {(isCreate ? (optionalShown("certifications") || doc.certifications.length > 0) : doc.certifications.length > 0) && (
          <Section
            icon={BadgeCheck}
            title="Certifications & licences"
            meta={`${doc.certifications.length}`}
            subtitle="Care VET qualifications moved to Education automatically"
            open={open.certifications}
            onToggle={() => toggle("certifications")}
            onClose={isCreate ? () => disableSection("certifications") : undefined}
          >
            {doc.certifications.map((c, i) => (
              <div key={i} className={`${i > 0 ? "pt-4 mt-4 border-t border-[var(--border)]/70" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <GhostField label="Name" value={c.name} onChange={v => patchCert(i, { name: v })} size="lg" />
                  </div>
                  <RemoveBtn label="Remove certification" onClick={() => removeCertification(i)} />
                </div>
                <Grid cols={3} mt>
                  <GhostField label="Issuer" value={c.issuer}      onChange={v => patchCert(i, { issuer: v })} />
                  <GhostField label="Code"   value={c.code}        onChange={v => patchCert(i, { code: v })} />
                  <GhostField label="Issued" value={c.issued_date} onChange={v => patchCert(i, { issued_date: v })} />
                </Grid>
              </div>
            ))}
            <AddBtn label="Add certification" onClick={addCertification} />
          </Section>
        )}

        {/* REFERENCES — review mode only */}
        {!isCreate && (
          <Section
            id="references"
            icon={Users}
            title="References"
            meta={doc.references.length === 0 ? "none" : `${doc.references.length} referee${doc.references.length === 1 ? "" : "s"}`}
            open={open.references}
            onToggle={() => toggle("references")}
          >
            {doc.references.length === 0 ? (
              <EmptyState icon={Users} text="No referees on the CV — referees can stay on a separate sheet." />
            ) : doc.references.map((r, i) => (
              <div key={i} className={`${i > 0 ? "pt-4 mt-4 border-t border-[var(--border)]/70" : ""} flex items-start gap-2`}>
                <div className="flex-1">
                  <Grid cols={2}>
                    <GhostField label="Name"      value={r.name}      onChange={v => patchReferee(i, { name: v })} />
                    <GhostField label="Email"     value={r.email}     onChange={v => patchReferee(i, { email: v })} />
                    <GhostField label="Job title" value={r.job_title} onChange={v => patchReferee(i, { job_title: v })} />
                    <GhostField label="Company"   value={r.company}   onChange={v => patchReferee(i, { company: v })} />
                  </Grid>
                </div>
                <RemoveBtn label="Remove referee" onClick={() => removeReferee(i)} />
              </div>
            ))}
            <AddBtn label="Add referee" onClick={addReferee} />
          </Section>
        )}

        {/* CUSTOM SECTIONS — create mode only */}
        {isCreate && customSects.map(sect => (
          <Section
            key={sect.id}
            icon={AlignLeft}
            title={sect.title}
            meta={`${sect.fields.filter(f => f.value.trim() || f.label.trim()).length} field${sect.fields.filter(f => f.value.trim() || f.label.trim()).length === 1 ? "" : "s"}`}
            open={customOpen[sect.id] ?? true}
            onToggle={() => setCustomOpen(o => ({ ...o, [sect.id]: !(o[sect.id] ?? true) }))}
            onClose={() => removeCustomSection(sect.id)}
          >
            <div className="space-y-3">
              {sect.fields.map((f, fi) => (
                <div key={fi} className="flex items-end gap-2">
                  <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <GhostField label="Field label" value={f.label} onChange={v => patchCustomField(sect.id, fi, { label: v })} />
                    <GhostField label="Value"       value={f.value} onChange={v => patchCustomField(sect.id, fi, { value: v })} />
                  </div>
                  <RemoveBtn label="Remove field" onClick={() => removeCustomField(sect.id, fi)} />
                </div>
              ))}
            </div>
            <AddBtn label="Add field" onClick={() => addCustomField(sect.id)} />
          </Section>
        ))}

        {/* ADD-A-SECTION — create mode only */}
        <AddSectionPanel
          isCreate={isCreate}
          hasMoreOptional={hasMoreOptional}
          addingCustom={addingCustom}
          optionalShown={optionalShown}
          enableSection={enableSection}
          setAddingCustom={setAddingCustom}
          newSectName={newSectName}
          setNewSectName={setNewSectName}
          addCustomSection={addCustomSection}
        />
      </div>

      {/* SAVE TOAST — sticky bottom */}
      <SaveToast
        save={save}
        status={status}
        err={err}
        isCreate={isCreate}
        cancelling={cancelling}
        cancelCreate={cancelCreate}
        saveDraft={saveDraft}
        saveFinish={saveFinish}
      />
    </div>
  );
}

// ─── sub-components ──────────────────────────────────────────────────────────

function Section({
  id, icon: Icon, title, subtitle, meta, open, onToggle, onClose, children,
}: {
  id?:       string;
  icon:      LucideIcon;
  title:     string;
  subtitle?: string;
  meta?:     string;
  open:      boolean;
  onToggle:  () => void;
  onClose?:  () => void;
  children:  React.ReactNode;
}) {
  return (
    <section id={id} className={`group relative rounded-xl border bg-[var(--surface)] transition-all ${open ? "border-[var(--border)] shadow-sm" : "border-[var(--border)]/70 hover:border-[var(--border)] hover:shadow-sm"}`}>
      {open && <span aria-hidden="true" className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full bg-[var(--brand)]/70" />}
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <button type="button" onClick={onToggle} className="flex flex-1 items-center gap-3 text-left min-w-0" aria-expanded={open}>
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${open ? "bg-[var(--brand)]/10 text-[var(--brand)]" : "bg-[var(--surface-2)]/60 text-text-3 group-hover:bg-[var(--brand)]/10 group-hover:text-[var(--brand)]"}`}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-title font-semibold text-text">{title}</span>
              {meta && (
                <span className="text-caption text-text-3 px-1.5 py-0.5 rounded-full bg-[var(--surface-2)]/60">
                  {meta}
                </span>
              )}
            </div>
            {subtitle && <p className="text-label text-text-3 mt-0.5 truncate">{subtitle}</p>}
          </div>
          {open
            ? <ChevronDown  className="h-4 w-4 text-text-3 shrink-0" aria-hidden="true" />
            : <ChevronRight className="h-4 w-4 text-text-3 shrink-0" aria-hidden="true" />}
        </button>
        {onClose && (
          <IconButton
            onClick={onClose}
            aria-label={`Remove ${title} section`}
            icon={<X className="h-3.5 w-3.5" />}
          />
        )}
      </div>
      {open && <div className="px-4 pb-4 pt-1 space-y-3">{children}</div>}
    </section>
  );
}

function Grid({ cols = 2, mt, children }: { cols?: number; mt?: boolean; children: React.ReactNode }) {
  const colClass = cols === 3 ? "sm:grid-cols-3" : cols === 2 ? "sm:grid-cols-2" : "";
  return <div className={`grid gap-3 ${mt ? "mt-3" : ""} grid-cols-1 ${colClass}`}>{children}</div>;
}

function GhostField({
  label, value, onChange, size = "md", invalid = false, required = false,
}: { label: string; value: string; onChange: (v: string) => void; size?: "md" | "lg"; invalid?: boolean; required?: boolean }) {
  // Leans on the shared Input's field SSOT: `required` renders the red
  // asterisk, `error` renders the red invalid border — no bespoke border /
  // focus-ring override (that stacked a second ring on top of .field's).
  const sized = size === "lg" ? "text-title font-semibold" : "";
  return (
    <Input
      label={label}
      required={required}
      error={invalid ? "required" : undefined}
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      className={sized}
    />
  );
}

function GhostTextarea({
  rows, value, onChange, placeholder,
}: { rows: number; value: string; onChange: (v: string) => void; placeholder?: string }) {
  // Shared Textarea (field SSOT) + autoGrow so it matches every other field
  // and expands to fit content instead of scrolling / needing a drag handle.
  return (
    <Textarea
      autoGrow
      rows={rows}
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value)}
      className="leading-relaxed"
    />
  );
}

function DatesField({ start, end, onStart, onEnd, invalid = false }: {
  start: string; end: string; onStart: (v: string) => void; onEnd: (v: string) => void; invalid?: boolean;
}) {
  const blank = !start && !end;
  const border = invalid
    ? "border-red-500 focus:border-red-500 focus:ring-red-500/20"
    : "border-[var(--border)] focus:border-[var(--brand)]/70 focus:ring-[var(--brand)]/15";
  return (
    <div>
      <span className="text-caption uppercase tracking-wider text-text-3 font-medium block mb-1">
        Dates {(blank || invalid) && <span className="normal-case tracking-normal text-red-600 font-semibold">· {invalid ? "required" : "missing"}</span>}
      </span>
      <div className="grid grid-cols-2 gap-1.5">
        <Input
          type="text"
          value={start}
          onChange={e => onStart(e.target.value)}
          placeholder="Start"
          aria-label="Start date"
          className={`text-body py-1.5 ${border}`}
        />
        <Input
          type="text"
          value={end}
          onChange={e => onEnd(e.target.value)}
          placeholder="End or Present"
          aria-label="End date"
          className={`text-body py-1.5 ${border}`}
        />
      </div>
    </div>
  );
}

function BulletRow({ value, onChange, onRemove }: {
  value: string; onChange: (v: string) => void; onRemove: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Auto-grow: the box height tracks the content (no scrollbar, no manual
  // drag handle) — resets to auto so it can shrink as well as grow.
  const autoGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(autoGrow, [value, autoGrow]);
  return (
    <div className="group/bullet flex items-start gap-2 py-1 rounded-md hover:bg-[var(--surface-2)]/30 transition-colors">
      <span className="mt-[13px] select-none text-[var(--brand)]/60 leading-none text-micro shrink-0" aria-hidden="true">●</span>
      <textarea
        ref={ref}
        rows={1}
        className="field min-w-0 resize-none overflow-hidden leading-relaxed"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      <button type="button" onClick={onRemove} aria-label="Remove bullet" className="mt-2 p-1 opacity-0 group-hover/bullet:opacity-100 focus:opacity-100 transition-opacity">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

type SkillTone = "care" | "soft" | "neutral";

function SkillsBucket({
  label, tone, bucket, items, onAdd, onRemove,
}: {
  label:    string;
  tone:     SkillTone;
  bucket:   "domain_knowledge" | "soft_skills" | "technical";
  items:    string[];
  onAdd:    (b: "domain_knowledge" | "soft_skills" | "technical", v: string) => void;
  onRemove: (b: "domain_knowledge" | "soft_skills" | "technical", v: string) => void;
}) {
  const [input, setInput] = useState("");
  const dotClass =
    tone === "care"  ? "bg-emerald-500" :
    tone === "soft"  ? "bg-amber-500"   :
                       "bg-text-3/60";
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
        <div className="text-caption uppercase tracking-wider text-text-3 font-medium">{label}</div>
        <span className="text-caption text-text-3">{items.length}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 items-center">
        {items.map(s => (
          <span key={s} className="group/chip inline-flex items-center gap-1 text-label pl-2 pr-1 py-0.5 rounded-full bg-[var(--surface-2)]/80 border border-[var(--border)]/60 hover:border-[var(--border)] transition-colors">
            <span className="text-text">{s}</span>
            <button
              type="button"
              onClick={() => onRemove(bucket, s)}
              aria-label={`Remove ${s}`}
              className="text-text-3 hover:text-text rounded-full p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <Input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); onAdd(bucket, input); setInput(""); }
          }}
          placeholder="add…"
          className="text-label h-6 w-24 rounded-full border border-dashed border-[var(--border)] bg-transparent px-2.5 placeholder:text-text-3 focus:outline-none focus:border-[var(--brand)]/70 focus:bg-[var(--surface-2)]/40 transition-colors"
          aria-label={`Add ${label}`}
        />
      </div>
    </div>
  );
}

function TimelineEntry({
  dateLabel, isFirst, isLast, children,
}: {
  dateLabel: string;
  isFirst:   boolean;
  isLast:    boolean;
  children:  React.ReactNode;
}) {
  return (
    <li className={`relative pl-7 sm:pl-9 ${isLast ? "" : "pb-6"}`}>
      {!isLast && (
        <span aria-hidden="true" className="absolute left-[9px] sm:left-[11px] top-3 bottom-0 w-px bg-[var(--border)]" />
      )}
      <span aria-hidden="true" className={`absolute left-[5px] sm:left-[7px] top-2.5 h-2 w-2 rounded-full ring-2 ring-[var(--surface)] ${isFirst ? "bg-[var(--brand)]" : "bg-[var(--border)]"}`} />
      <div className="text-caption text-text-2 font-medium mb-2 -mt-0.5">{dateLabel || <span className="text-text-3 italic">no dates</span>}</div>
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
      <p className="text-body text-text-3 max-w-xs">{text}</p>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} className="mt-3 inline-flex items-center gap-1.5 text-xs text-[var(--brand)] hover:underline">
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
    <IconButton
      onClick={onClick}
      aria-label={label}
      variant="danger"
      size="sm"
      icon={<X className="h-3.5 w-3.5" />}
      className="mt-5"
    />
  );
}


function joinDatesLabel(start: string, end: string, isCurrent: boolean): string {
  const s = (start || "").trim();
  const e = (end || "").trim();
  if (isCurrent && s) return `${s} – Present`;
  if (s && e) return `${s} – ${e}`;
  return s || e;
}

function clientGaps(d: StructuredCv): string[] {
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

// ── Create-mode required-field helpers ───────────────────────────────────────
function expHasContent(e: StructuredCvExperience): boolean {
  return !!(e.employer.trim() || e.role.trim() || e.location.trim()
    || e.start_date.trim() || e.end_date.trim() || (e.bullets ?? []).some(b => b.trim()));
}
function expComplete(e: StructuredCvExperience): boolean {
  return !!(e.employer.trim() && e.role.trim() && (e.start_date.trim() || e.end_date.trim())
    && (e.bullets ?? []).some(b => b.trim()));
}
function eduHasContent(e: StructuredCvEducation): boolean {
  return !!(e.institution.trim() || e.qualification.trim() || e.location.trim()
    || e.start_date.trim() || e.end_date.trim());
}
function eduComplete(e: StructuredCvEducation): boolean {
  return !!(e.institution.trim() && e.qualification.trim());
}

/** Mandatory-section validation for marking a built CV "Reviewed". Returns a
 *  list of human-readable problems (empty = valid). */
function validateCreate(d: StructuredCv): string[] {
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

function emptyExperience(): StructuredCvExperience {
  return { employer: "", role: "", location: "", start_date: "", end_date: "", is_current: false, bullets: [""] };
}

function emptyEducation(): StructuredCvEducation {
  return { institution: "", qualification: "", location: "", start_date: "", end_date: "", completed: false };
}
