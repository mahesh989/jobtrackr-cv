"use client";

/**
 * Per-section render blocks for the CV review editor, split out of
 * ReviewClient's single JSX return.
 *
 * These are deliberately plain function components, not React.memo ones. The
 * patchers they receive are recreated every render (see cvDocPatchers), so a
 * memo boundary here would re-render anyway while changing when it happens —
 * memoising sections is only worth doing together with the patchers.
 *
 * Visibility gating stays in ReviewClient so the section order and mode rules
 * remain readable in one place; each component below renders unconditionally.
 */

import {
  AlignLeft, Briefcase, GraduationCap, BadgeCheck, Sparkles, Loader2,
  FolderGit2, ExternalLink, Languages as LanguagesIcon, Trophy, Users,
} from "lucide-react";
import type {
  StructuredCvExperience, StructuredCvEducation, StructuredCvSkills,
  StructuredCvProject, StructuredCvLanguage, StructuredCvAward,
  StructuredCvCertification, StructuredCvReferee, CustomCvSection,
} from "@/lib/types";
import type { SkillLabels } from "@/lib/cv/skillLabels";
import {
  Section, Grid, GhostField, GhostTextarea, DatesField, BulletRow,
  SkillsBucket, TimelineEntry, EmptyState, AddBtn, RemoveBtn,
} from "./ReviewFields";
import { joinDatesLabel } from "./reviewValidation";

export type ExpField = "employer" | "role" | "dates" | "bullets";
export type EduField = "institution" | "qualification";

// ── SUMMARY ──────────────────────────────────────────────────────────────────
export function SummarySection({ summary, open, onToggle, onChange }: {
  summary:  string;
  open:     boolean;
  onToggle: () => void;
  onChange: (v: string) => void;
}) {
  return (
    <Section
      icon={AlignLeft}
      title="Profile summary"
      meta={summary ? `${summary.split(/\s+/).filter(Boolean).length} words` : "empty"}
      open={open}
      onToggle={onToggle}
    >
      <GhostTextarea
        rows={4}
        value={summary}
        onChange={onChange}
        placeholder={summary ? "" : "Optional — leave blank if your CV doesn't have one."}
      />
    </Section>
  );
}

// ── SKILLS ───────────────────────────────────────────────────────────────────
type SkillBucket = "domain_knowledge" | "soft_skills" | "technical";

export function SkillsSection({
  skills, skillLabels, open, onToggle, isCreate, onClose,
  addSkill, removeSkill, onExtract, extracting, extractErr,
}: {
  skills:      StructuredCvSkills;
  skillLabels: SkillLabels;
  open:        boolean;
  onToggle:    () => void;
  isCreate:    boolean;
  onClose?:    () => void;
  addSkill:    (b: SkillBucket, v: string) => void;
  removeSkill: (b: SkillBucket, v: string) => void;
  onExtract:   () => void;
  extracting:  boolean;
  extractErr:  string | null;
}) {
  const total = skills.domain_knowledge.length + skills.soft_skills.length + skills.technical.length;
  return (
    <Section
      icon={Sparkles}
      title="Skills"
      meta={isCreate ? `${total}` : `${total} from your CV`}
      open={open}
      onToggle={onToggle}
      onClose={onClose}
    >
      <SkillsBucket label={skillLabels.domain_knowledge} tone="care"    bucket="domain_knowledge" items={skills.domain_knowledge} onAdd={addSkill} onRemove={removeSkill} />
      <SkillsBucket label={skillLabels.soft_skills}      tone="soft"    bucket="soft_skills"      items={skills.soft_skills}      onAdd={addSkill} onRemove={removeSkill} />
      <SkillsBucket label={skillLabels.technical}        tone="neutral" bucket="technical"        items={skills.technical}        onAdd={addSkill} onRemove={removeSkill} />
      {/* Create mode: AI extraction from experience bullets */}
      {isCreate && (
        <div className="pt-2 border-t border-[var(--border)]/50 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={onExtract}
            disabled={extracting}
            className="inline-flex items-center gap-1.5 text-label text-[var(--brand)] hover:underline disabled:opacity-50 disabled:no-underline"
          >
            {extracting
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Extracting…</>
              : <><Sparkles className="h-3.5 w-3.5" /> Suggest from experience</>
            }
          </button>
          <span className="text-caption text-text-3">AI reads your bullets and suggests skills — you can remove any that don&apos;t fit.</span>
          {extractErr && (
            <p className="w-full text-caption text-danger">{extractErr}</p>
          )}
        </div>
      )}
    </Section>
  );
}

// ── EXPERIENCE ───────────────────────────────────────────────────────────────
export function ExperienceSection({
  experience, open, onToggle, isCreate, fieldErr,
  patchExperience, addExperience, removeExperience,
  setBullet, addBullet, removeBullet,
}: {
  experience:       StructuredCvExperience[];
  open:             boolean;
  onToggle:         () => void;
  isCreate:         boolean;
  fieldErr:         (i: number, field: ExpField) => boolean;
  patchExperience:  (i: number, next: Partial<StructuredCvExperience>) => void;
  addExperience:    () => void;
  removeExperience: (i: number) => void;
  setBullet:        (i: number, bi: number, v: string) => void;
  addBullet:        (i: number) => void;
  removeBullet:     (i: number, bi: number) => void;
}) {
  return (
    <Section
      icon={Briefcase}
      title="Experience"
      meta={experience.length === 0 ? "empty" : `${experience.length} role${experience.length === 1 ? "" : "s"}`}
      open={open}
      onToggle={onToggle}
    >
      {experience.length === 0 ? (
        <EmptyState icon={Briefcase} text="No roles found." />
      ) : (
        <ol className="relative">
          {experience.map((e, i) => (
            <TimelineEntry
              key={i}
              dateLabel={joinDatesLabel(e.start_date, e.end_date, e.is_current)}
              isFirst={i === 0}
              isLast={i === experience.length - 1}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <GhostField label="Employer" value={e.employer} onChange={v => patchExperience(i, { employer: v })} size="lg" required={isCreate} invalid={fieldErr(i, "employer")} />
                </div>
                {experience.length > 1 && (
                  <RemoveBtn label="Remove role" onClick={() => removeExperience(i)} />
                )}
              </div>
              <Grid cols={3} mt>
                <GhostField label="Role"     value={e.role}     onChange={v => patchExperience(i, { role: v })} required={isCreate} invalid={fieldErr(i, "role")} />
                <GhostField label="Location" value={e.location} onChange={v => patchExperience(i, { location: v })} />
                <DatesField
                  start={e.start_date} end={e.end_date}
                  onStart={v => patchExperience(i, { start_date: v })}
                  onEnd={v => patchExperience(i, { end_date: v })}
                  invalid={fieldErr(i, "dates")}
                />
              </Grid>
              <div className="mt-4">
                <div className="text-caption uppercase tracking-wider font-medium mb-2">
                  <span className={fieldErr(i, "bullets") ? "text-danger" : "text-text-3"}>
                    Bullets{isCreate && <span className="text-danger ml-0.5">*</span>}
                    {fieldErr(i, "bullets") && <span className="normal-case tracking-normal ml-1.5">· add at least one</span>}
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
  );
}

// ── EDUCATION ────────────────────────────────────────────────────────────────
export function EducationSection({
  education, open, onToggle, isCreate, fieldErr,
  patchEducation, addEducation, removeEducation,
}: {
  education:       StructuredCvEducation[];
  open:            boolean;
  onToggle:        () => void;
  isCreate:        boolean;
  fieldErr:        (i: number, field: EduField) => boolean;
  patchEducation:  (i: number, next: Partial<StructuredCvEducation>) => void;
  addEducation:    () => void;
  removeEducation: (i: number) => void;
}) {
  return (
    <Section
      icon={GraduationCap}
      title="Education"
      meta={education.length === 0 ? "empty" : `${education.length} entr${education.length === 1 ? "y" : "ies"}`}
      open={open}
      onToggle={onToggle}
    >
      {education.length === 0 ? (
        <EmptyState icon={GraduationCap} text="No education found." />
      ) : education.map((e, i) => (
        <div key={i} className={`${i > 0 ? "pt-4 mt-4 border-t border-[var(--border)]/70" : ""}`}>
          {e._moved_from_certifications && (
            <span className="inline-flex items-center gap-1 mb-2 px-2 py-0.5 text-caption rounded-full border border-[var(--brand)]/30 bg-[var(--brand)]/5 text-text-2">
              <BadgeCheck className="h-3 w-3 text-[var(--brand)]" />
              Moved here from certifications
            </span>
          )}
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <GhostField label="Institution" value={e.institution} onChange={v => patchEducation(i, { institution: v })} size="lg" required={isCreate} invalid={fieldErr(i, "institution")} />
            </div>
            {education.length > 1 && (
              <RemoveBtn label="Remove education" onClick={() => removeEducation(i)} />
            )}
          </div>
          <Grid cols={3} mt>
            <GhostField label="Qualification" value={e.qualification} onChange={v => patchEducation(i, { qualification: v })} required={isCreate} invalid={fieldErr(i, "qualification")} />
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
  );
}

// ── PROJECTS ─────────────────────────────────────────────────────────────────
export function ProjectsSection({
  projects, open, onToggle, onClose, patchProject, addProject, removeProject,
}: {
  projects:      StructuredCvProject[];
  open:          boolean;
  onToggle:      () => void;
  onClose?:      () => void;
  patchProject:  (i: number, next: Partial<StructuredCvProject>) => void;
  addProject:    () => void;
  removeProject: (i: number) => void;
}) {
  return (
    <Section
      icon={FolderGit2}
      title="Projects"
      meta={projects.length === 0 ? "empty" : `${projects.length}`}
      subtitle="Portfolio / side projects — the AI references relevant ones per role"
      open={open}
      onToggle={onToggle}
      onClose={onClose}
    >
      {projects.length === 0 ? (
        <EmptyState icon={FolderGit2} text="No projects yet — optional." actionLabel="Add project" onAction={addProject} />
      ) : projects.map((p, i) => (
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
      {projects.length > 0 && <AddBtn label="Add project" onClick={addProject} />}
    </Section>
  );
}

// ── LANGUAGES ────────────────────────────────────────────────────────────────
export function LanguagesSection({
  languages, open, onToggle, onClose, patchLanguage, addLanguage, removeLanguage,
}: {
  languages:      StructuredCvLanguage[];
  open:           boolean;
  onToggle:       () => void;
  onClose?:       () => void;
  patchLanguage:  (i: number, next: Partial<StructuredCvLanguage>) => void;
  addLanguage:    () => void;
  removeLanguage: (i: number) => void;
}) {
  return (
    <Section
      icon={LanguagesIcon}
      title="Languages"
      meta={languages.length === 0 ? "empty" : `${languages.length}`}
      subtitle="Kept as record — not used in tailored CV"
      open={open}
      onToggle={onToggle}
      onClose={onClose}
    >
      {languages.length === 0 ? (
        <EmptyState icon={LanguagesIcon} text="No languages on your CV — optional." actionLabel="Add language" onAction={addLanguage} />
      ) : (
        <div className="space-y-2.5">
          {languages.map((l, i) => (
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
      {languages.length > 0 && <AddBtn label="Add language" onClick={addLanguage} />}
    </Section>
  );
}

// ── AWARDS ───────────────────────────────────────────────────────────────────
export function AwardsSection({
  awards, open, onToggle, onClose, patchAward, addAward, removeAward,
}: {
  awards:      StructuredCvAward[];
  open:        boolean;
  onToggle:    () => void;
  onClose?:    () => void;
  patchAward:  (i: number, next: Partial<StructuredCvAward>) => void;
  addAward:    () => void;
  removeAward: (i: number) => void;
}) {
  return (
    <Section
      icon={Trophy}
      title="Awards"
      meta={awards.length === 0 ? "empty" : `${awards.length}`}
      subtitle="Recognitions, scholarships, honours"
      open={open}
      onToggle={onToggle}
      onClose={onClose}
    >
      {awards.length === 0 ? (
        <EmptyState icon={Trophy} text="No awards on your CV — optional." actionLabel="Add award" onAction={addAward} />
      ) : awards.map((a, i) => (
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
      {awards.length > 0 && <AddBtn label="Add award" onClick={addAward} />}
    </Section>
  );
}

// ── CERTIFICATIONS ───────────────────────────────────────────────────────────
export function CertificationsSection({
  certifications, open, onToggle, onClose,
  patchCert, addCertification, removeCertification,
}: {
  certifications:      StructuredCvCertification[];
  open:                boolean;
  onToggle:            () => void;
  onClose?:            () => void;
  patchCert:           (i: number, next: Partial<StructuredCvCertification>) => void;
  addCertification:    () => void;
  removeCertification: (i: number) => void;
}) {
  return (
    <Section
      icon={BadgeCheck}
      title="Certifications & licences"
      meta={`${certifications.length}`}
      subtitle="Care VET qualifications moved to Education automatically"
      open={open}
      onToggle={onToggle}
      onClose={onClose}
    >
      {certifications.map((c, i) => (
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
  );
}

// ── REFERENCES ───────────────────────────────────────────────────────────────
export function ReferencesSection({
  references, open, onToggle, patchReferee, addReferee, removeReferee,
}: {
  references:     StructuredCvReferee[];
  open:           boolean;
  onToggle:       () => void;
  patchReferee:   (i: number, next: Partial<StructuredCvReferee>) => void;
  addReferee:     () => void;
  removeReferee:  (i: number) => void;
}) {
  return (
    <Section
      id="references"
      icon={Users}
      title="References"
      meta={references.length === 0 ? "none" : `${references.length} referee${references.length === 1 ? "" : "s"}`}
      open={open}
      onToggle={onToggle}
    >
      {references.length === 0 ? (
        <EmptyState icon={Users} text="No referees on the CV — referees can stay on a separate sheet." />
      ) : references.map((r, i) => (
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
  );
}

// ── CUSTOM SECTION (create mode only) ────────────────────────────────────────
export function CustomSection({
  sect, open, onToggle, onClose,
  patchCustomField, addCustomField, removeCustomField,
}: {
  sect:              CustomCvSection;
  open:              boolean;
  onToggle:          () => void;
  onClose:           () => void;
  patchCustomField:  (sectId: string, fi: number, next: Partial<{ label: string; value: string }>) => void;
  addCustomField:    (sectId: string) => void;
  removeCustomField: (sectId: string, fi: number) => void;
}) {
  const filled = sect.fields.filter(f => f.value.trim() || f.label.trim()).length;
  return (
    <Section
      icon={AlignLeft}
      title={sect.title}
      meta={`${filled} field${filled === 1 ? "" : "s"}`}
      open={open}
      onToggle={onToggle}
      onClose={onClose}
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
  );
}
