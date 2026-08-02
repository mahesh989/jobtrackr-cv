"use client";

/**
 * ReviewClient — post-upload review form + create-from-scratch editor.
 *
 * Review mode  ("review"): post-upload tidy form; autosave on edit; Save
 *   button collapses all sections and marks the CV verified.
 * Create mode ("create"): blank CV builder; no autosave; Save button persists
 *   + redirects to My CV page where the user can set it as active.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText } from "lucide-react";
import type { StructuredCv, CustomCvSection } from "@/lib/cv/backend";
import { type SkillLabels, DEFAULT_SKILL_LABELS } from "@/lib/cv/skillLabels";
import {
  ReviewStatusBanner, SaveToast, AddSectionPanel, SaveBadge,
  OPTIONAL_SECTIONS,
  type OptionalKey } from "./ReviewComponents";
import { clientGaps, createGaps, expHasContent, expComplete, eduHasContent, eduComplete, validateCreate, emptyExperience, emptyEducation } from "./reviewValidation";
import { withSetupParams } from "@/lib/setupParams";
import { useReviewAutosave } from "./useReviewAutosave";
import { makeDocPatchers } from "./cvDocPatchers";
import {
  SkillsSection, SummarySection, ExperienceSection, EducationSection,
  ProjectsSection, LanguagesSection, AwardsSection, CertificationsSection,
  ReferencesSection, CustomSection,
} from "./ReviewSections";

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
  mode = "review", skillLabels = DEFAULT_SKILL_LABELS }: Props) {
  const router   = useRouter();
  const isCreate = mode === "create";

  const [doc, setDoc] = useState<StructuredCv>(() => {
    if (!isCreate) return initialStructuredCv;
    return {
      ...initialStructuredCv,
      experience: initialStructuredCv.experience.length > 0 ? initialStructuredCv.experience : [emptyExperience()],
      education:  initialStructuredCv.education.length  > 0 ? initialStructuredCv.education  : [emptyEducation()] };
  });

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
    projects: true, languages: true, awards: true, certifications: true, references: true });
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

  // Autosave, dirty-flush and save status all live in the hook — see
  // useReviewAutosave for why each ref there is load-bearing.
  const { save, err, status, persist, cancelPending } = useReviewAutosave({
    cvId, doc, customSects, initialStructuredCv, initialStatus,
    enabled: !isCreate,
  });

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

  // Return to My CV scrolled to this CV's card (both flows land here on
  // save). Preserves ?setup=1&step=N — dropping it here was the "upload
  // succeeded, clicked Back to Profile, and setup context vanished" bug.
  const returnToCard = () => router.push(withSetupParams(`/cv#cv-${cvId}`, searchParams));

  // Create mode: save as draft — no validation, stays unverified. User can
  // come back and finish later.
  async function saveDraft() {
    cancelPending();
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
    cancelPending();
    const ok = await persist(doc, customSects, true);
    if (ok) { savedRef.current = true; returnToCard(); }
  }

  // Create mode: cancel — discard the never-saved blank draft, then return.
  const [cancelling, setCancelling] = useState(false);
  async function cancelCreate() {
    cancelPending();
    if (initiallyEmpty.current && !savedRef.current) {
      setCancelling(true);
      try {
        await fetch(`/api/cv/${cvId}`, { method: "DELETE" });
      } catch {
        /* best-effort — even if the delete fails, don't trap the user here */
      }
    }
    router.push(withSetupParams("/cv", searchParams));
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

  // Document updaters — see cvDocPatchers for why these are not memoised.
  const {
    patchExperience, patchEducation, patchAward, addAward, removeAward,
    patchLanguage, addLanguage, removeLanguage, patchCert, patchReferee,
    setBullet, addBullet, removeBullet, addSkill, removeSkill,
    addExperience, removeExperience, addEducation, removeEducation,
    addCertification, removeCertification, addReferee, removeReferee,
    patchProject, addProject, removeProject,
  } = makeDocPatchers(setDoc);

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
      ...s, fields: s.fields.map((f, idx) => idx === fi ? { ...f, ...next } : f) }));
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
        body:    JSON.stringify({ cv_text: builtText.length >= 50 ? builtText : undefined }) });
      const j = await res.json() as { domain_knowledge?: string[]; soft_skills?: string[]; technical?: string[]; error?: string };
      if (!res.ok) { setExtractSkillsErr(j.error ?? "Extraction failed"); return; }
      // Merge suggestions into existing buckets (deduplicate).
      setDoc(d => ({
        ...d,
        skills: {
          domain_knowledge: Array.from(new Set([...d.skills.domain_knowledge, ...(j.domain_knowledge ?? [])])),
          soft_skills:      Array.from(new Set([...d.skills.soft_skills,      ...(j.soft_skills      ?? [])])),
          technical:        Array.from(new Set([...d.skills.technical,         ...(j.technical         ?? [])])) } }));
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
          <SkillsSection
            skills={doc.skills}
            skillLabels={skillLabels}
            open={open.skills}
            onToggle={() => toggle("skills")}
            isCreate={isCreate}
            onClose={isCreate ? () => disableSection("skills") : undefined}
            addSkill={addSkill}
            removeSkill={removeSkill}
            onExtract={handleExtractSkills}
            extracting={extractingSkills}
            extractErr={extractSkillsErr}
          />
        )}

        {/* SUMMARY — review mode only; auto-generated in create mode */}
        {!isCreate && (
          <SummarySection
            summary={doc.summary}
            open={open.summary}
            onToggle={() => toggle("summary")}
            onChange={v => setDoc(d => ({ ...d, summary: v }))}
          />
        )}

        {/* EXPERIENCE */}
        <ExperienceSection
          experience={doc.experience}
          open={open.experience}
          onToggle={() => toggle("experience")}
          isCreate={isCreate}
          fieldErr={expFieldErr}
          patchExperience={patchExperience}
          addExperience={addExperience}
          removeExperience={removeExperience}
          setBullet={setBullet}
          addBullet={addBullet}
          removeBullet={removeBullet}
        />

        {/* EDUCATION */}
        <EducationSection
          education={doc.education}
          open={open.education}
          onToggle={() => toggle("education")}
          isCreate={isCreate}
          fieldErr={eduFieldErr}
          patchEducation={patchEducation}
          addEducation={addEducation}
          removeEducation={removeEducation}
        />

        {/* PROJECTS — opt-in when building */}
        {(isCreate ? optionalShown("projects") : (doc.projects ?? []).length > 0) && (
          <ProjectsSection
            projects={doc.projects ?? []}
            open={open.projects}
            onToggle={() => toggle("projects")}
            onClose={isCreate ? () => disableSection("projects") : undefined}
            patchProject={patchProject}
            addProject={addProject}
            removeProject={removeProject}
          />
        )}

        {/* LANGUAGES — opt-in when building */}
        {(!isCreate || optionalShown("languages")) && (
          <LanguagesSection
            languages={doc.languages ?? []}
            open={open.languages}
            onToggle={() => toggle("languages")}
            onClose={isCreate ? () => disableSection("languages") : undefined}
            patchLanguage={patchLanguage}
            addLanguage={addLanguage}
            removeLanguage={removeLanguage}
          />
        )}

        {/* AWARDS — opt-in when building */}
        {(!isCreate || optionalShown("awards")) && (
          <AwardsSection
            awards={doc.awards ?? []}
            open={open.awards}
            onToggle={() => toggle("awards")}
            onClose={isCreate ? () => disableSection("awards") : undefined}
            patchAward={patchAward}
            addAward={addAward}
            removeAward={removeAward}
          />
        )}

        {/* CERTIFICATIONS */}
        {(isCreate ? (optionalShown("certifications") || doc.certifications.length > 0) : doc.certifications.length > 0) && (
          <CertificationsSection
            certifications={doc.certifications}
            open={open.certifications}
            onToggle={() => toggle("certifications")}
            onClose={isCreate ? () => disableSection("certifications") : undefined}
            patchCert={patchCert}
            addCertification={addCertification}
            removeCertification={removeCertification}
          />
        )}

        {/* REFERENCES — review mode only */}
        {!isCreate && (
          <ReferencesSection
            references={doc.references}
            open={open.references}
            onToggle={() => toggle("references")}
            patchReferee={patchReferee}
            addReferee={addReferee}
            removeReferee={removeReferee}
          />
        )}

        {/* CUSTOM SECTIONS — create mode only */}
        {isCreate && customSects.map(sect => (
          <CustomSection
            key={sect.id}
            sect={sect}
            open={customOpen[sect.id] ?? true}
            onToggle={() => setCustomOpen(o => ({ ...o, [sect.id]: !(o[sect.id] ?? true) }))}
            onClose={() => removeCustomSection(sect.id)}
            patchCustomField={patchCustomField}
            addCustomField={addCustomField}
            removeCustomField={removeCustomField}
          />
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
        backToProfile={() => router.push(withSetupParams("/cv", searchParams))}
      />
    </div>
  );
}

