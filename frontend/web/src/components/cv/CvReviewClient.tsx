"use client";

/**
 * CvReviewClient — post-upload review form.
 *
 * Forced step: every freshly-structurized CV is sent through here. Each
 * section is a collapsible card matching the rest of the dashboard theme
 * (var(--border), text-text, gh-btn). Sections start expanded EXCEPT
 * References, which starts collapsed.
 *
 * On any edit, a 10-second debounced autosave PATCHes the structured CV
 * back to /api/cv/:id/structured. That endpoint re-renders the canonical
 * markdown via cv-backend and persists both `structured_cv` and
 * `normalized_cv_text` — the latter is what the analysis pipeline reads
 * next time the user runs an analysis (see /api/jobs/[id]/analyze).
 *
 * "Save & use this CV" forces an immediate save with verified=true and
 * collapses every section to a summary header. The user stays on the
 * page (no redirect) so they can keep refining; clicking a header
 * re-expands the section.
 *
 * NOT an analysis step. The form purely rearranges the candidate's own
 * words into a consistent skeleton — no paraphrasing, no relevance
 * filtering. (The prompt enforces verbatim content; bullets and summary
 * sentences are copied character-for-character from the source CV.)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Plus, X } from "lucide-react";
import type {
  StructuredCv,
  StructuredCvContact,
  StructuredCvExperience,
  StructuredCvEducation,
  StructuredCvCertification,
  StructuredCvReferee,
} from "@/lib/cvBackend";

const AUTOSAVE_MS = 10_000;

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
type SectionKey = "contact" | "skills" | "summary" | "experience" | "education" | "certifications" | "references";

interface Props {
  cvId:                 string;
  label:                string;
  initialStructuredCv:  StructuredCv;
  initialStatus:        string;
}

export function CvReviewClient({ cvId, label, initialStructuredCv, initialStatus }: Props) {
  const [doc, setDoc] = useState<StructuredCv>(initialStructuredCv);
  const [status, setStatus] = useState<string>(initialStatus);
  const [save, setSave] = useState<SaveStatus>("idle");
  const [err, setErr]   = useState<string | null>(null);

  // Section open/closed state. Save & continue collapses everything; the
  // user can re-expand by clicking any header. References starts collapsed
  // by default (it's a secondary signal); everything else expanded.
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    contact:        true,
    skills:         true,
    summary:        true,
    experience:     true,
    education:      true,
    certifications: true,
    references:     false,
  });

  const toggle = (k: SectionKey) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const collapseAll = () =>
    setOpen({
      contact: false, skills: false, summary: false, experience: false,
      education: false, certifications: false, references: false,
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
    if (ok) collapseAll();
  }

  const liveGaps = useMemo(() => clientGaps(doc), [doc]);

  // — patching helpers (immutable) —
  const patchContact = (next: Partial<StructuredCvContact>) =>
    setDoc(d => ({ ...d, contact: { ...d.contact, ...next } }));
  const patchExperience = (i: number, next: Partial<StructuredCvExperience>) =>
    setDoc(d => ({ ...d, experience: d.experience.map((e, idx) => idx === i ? { ...e, ...next } : e) }));
  const patchEducation = (i: number, next: Partial<StructuredCvEducation>) =>
    setDoc(d => ({ ...d, education: d.education.map((e, idx) => idx === i ? { ...e, ...next } : e) }));
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-text-3">Required after upload — not analysis</p>
          <h1 className="text-[18px] font-semibold text-text mt-1">Review &amp; tidy your CV</h1>
          <p className="mt-1 text-[13px] text-text-2 leading-relaxed">
            We rearranged <strong className="text-text">{label}</strong> into a consistent format using only your own words. Edit anything that&apos;s wrong; nothing was paraphrased or shortened.
          </p>
        </div>
        <SaveBadge status={save} verified={status === "verified"} err={err} />
      </div>

      {/* Gap banner */}
      {liveGaps.length > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-300/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-[13px] text-amber-900 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{liveGaps.length} item{liveGaps.length === 1 ? "" : "s"} need your attention — you can fill them now or skip and analyse anyway.</span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-emerald-300/40 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2 text-[13px] text-emerald-900 dark:text-emerald-200">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>All set — nothing flagged.</span>
        </div>
      )}

      {/* CONTACT */}
      <Section title="Contact" open={open.contact} onToggle={() => toggle("contact")}>
        <Grid>
          <Field label="Name"     value={doc.contact.name}     onChange={v => patchContact({ name: v })} />
          <Field label="Email"    value={doc.contact.email}    onChange={v => patchContact({ email: v })} />
          <Field label="Phone"    value={doc.contact.phone}    onChange={v => patchContact({ phone: v })} />
          <Field label="Location" value={doc.contact.location} onChange={v => patchContact({ location: v })} />
        </Grid>
      </Section>

      {/* SKILLS — above summary per product call */}
      <Section title="Skills" subtitle="From your CV — remove junk or add your own" open={open.skills} onToggle={() => toggle("skills")}>
        <SkillsBucket label="Care skills"      bucket="domain_knowledge" items={doc.skills.domain_knowledge} onAdd={addSkill} onRemove={removeSkill} />
        <SkillsBucket label="Soft skills"      bucket="soft_skills"      items={doc.skills.soft_skills}      onAdd={addSkill} onRemove={removeSkill} />
        <SkillsBucket label="Tools & software" bucket="technical"    items={doc.skills.technical}        onAdd={addSkill} onRemove={removeSkill} />
      </Section>

      {/* SUMMARY */}
      <Section title="Profile summary" subtitle="Verbatim from your CV — edit if you'd like to refine" open={open.summary} onToggle={() => toggle("summary")}>
        <textarea
          rows={4}
          className="block w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
          value={doc.summary}
          onChange={e => setDoc(d => ({ ...d, summary: e.target.value }))}
          placeholder="A short paragraph describing your background."
        />
      </Section>

      {/* EXPERIENCE */}
      <Section title="Experience" subtitle="All roles & bullets kept verbatim — edit freely" open={open.experience} onToggle={() => toggle("experience")}>
        {doc.experience.length === 0 ? (
          <p className="text-[13px] text-text-3">No roles found.</p>
        ) : doc.experience.map((e, i) => (
          <div key={i} className={`${i > 0 ? "pt-4 mt-4 border-t border-[var(--border)]" : ""}`}>
            <Field label="Employer" value={e.employer} onChange={v => patchExperience(i, { employer: v })} bold />
            <Grid cols={3} mt>
              <Field label="Role"     value={e.role}     onChange={v => patchExperience(i, { role: v })} />
              <Field label="Location" value={e.location} onChange={v => patchExperience(i, { location: v })} />
              <DatesField
                start={e.start_date} end={e.end_date}
                onStart={v => patchExperience(i, { start_date: v })}
                onEnd={v => patchExperience(i, { end_date: v })}
              />
            </Grid>
            <div className="mt-3 space-y-1.5">
              <div className="text-xs text-text-3 mb-1">Bullets</div>
              {e.bullets.map((b, bi) => (
                <BulletRow
                  key={bi}
                  value={b}
                  onChange={v => setBullet(i, bi, v)}
                  onRemove={() => removeBullet(i, bi)}
                />
              ))}
              <button
                type="button"
                onClick={() => addBullet(i)}
                className="inline-flex items-center gap-1 text-xs text-text-2 hover:text-text mt-1"
              >
                <Plus className="h-3.5 w-3.5" /> Add bullet
              </button>
            </div>
          </div>
        ))}
      </Section>

      {/* EDUCATION */}
      <Section title="Education" open={open.education} onToggle={() => toggle("education")}>
        {doc.education.length === 0 ? (
          <p className="text-[13px] text-text-3">No education found.</p>
        ) : doc.education.map((e, i) => (
          <div key={i} className={`${i > 0 ? "pt-3 mt-3 border-t border-[var(--border)]" : ""}`}>
            {e._moved_from_certifications && (
              <span className="inline-block mb-2 px-2 py-0.5 text-[11px] rounded bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
                Moved here from certifications (care qualifications go in Education)
              </span>
            )}
            <Field label="Institution" value={e.institution} onChange={v => patchEducation(i, { institution: v })} bold />
            <Grid cols={3} mt>
              <Field label="Qualification" value={e.qualification} onChange={v => patchEducation(i, { qualification: v })} />
              <Field label="Location"      value={e.location}      onChange={v => patchEducation(i, { location: v })} />
              <DatesField
                start={e.start_date} end={e.end_date}
                onStart={v => patchEducation(i, { start_date: v })}
                onEnd={v => patchEducation(i, { end_date: v })}
              />
            </Grid>
            <label className="flex items-center gap-2 mt-2 text-xs text-text-2">
              <input
                type="checkbox"
                className="rounded border-[var(--border)]"
                checked={e.completed}
                onChange={ev => patchEducation(i, { completed: ev.target.checked })}
              />
              Completed
            </label>
          </div>
        ))}
      </Section>

      {/* CERTIFICATIONS — only shown if anything remained */}
      {doc.certifications.length > 0 && (
        <Section
          title="Certifications & licences"
          subtitle="Care VET qualifications have moved to Education automatically"
          open={open.certifications}
          onToggle={() => toggle("certifications")}
        >
          {doc.certifications.map((c, i) => (
            <div key={i} className={`${i > 0 ? "pt-3 mt-3 border-t border-[var(--border)]" : ""}`}>
              <Field label="Name" value={c.name} onChange={v => patchCert(i, { name: v })} bold />
              <Grid cols={3} mt>
                <Field label="Issuer" value={c.issuer}      onChange={v => patchCert(i, { issuer: v })} />
                <Field label="Code"   value={c.code}        onChange={v => patchCert(i, { code: v })} />
                <Field label="Issued" value={c.issued_date} onChange={v => patchCert(i, { issued_date: v })} />
              </Grid>
            </div>
          ))}
        </Section>
      )}

      {/* REFERENCES — collapsed by default */}
      <Section
        title="References"
        subtitle={doc.references.length === 0 ? "None listed on the CV" : `${doc.references.length} referee${doc.references.length === 1 ? "" : "s"}`}
        open={open.references}
        onToggle={() => toggle("references")}
      >
        {doc.references.length === 0 ? (
          <p className="text-[13px] text-text-3">No referees were on the CV. You can leave this empty — referees can stay on a separate sheet.</p>
        ) : doc.references.map((r, i) => (
          <div key={i} className={`${i > 0 ? "pt-3 mt-3 border-t border-[var(--border)]" : ""}`}>
            <Grid cols={2}>
              <Field label="Name"     value={r.name}      onChange={v => patchReferee(i, { name: v })} />
              <Field label="Email"    value={r.email}     onChange={v => patchReferee(i, { email: v })} />
              <Field label="Job title" value={r.job_title} onChange={v => patchReferee(i, { job_title: v })} />
              <Field label="Company"  value={r.company}   onChange={v => patchReferee(i, { company: v })} />
            </Grid>
          </div>
        ))}
      </Section>

      {/* Save bar */}
      <div className="sticky bottom-0 -mx-6 px-6 py-3 bg-[var(--surface)]/95 backdrop-blur border-t border-[var(--border)] flex items-center justify-between">
        <div className="text-xs text-text-3">Edits autosave every 10 seconds. This tidied CV is what the analysis pipeline uses.</div>
        <button
          type="button"
          onClick={saveAndCollapse}
          className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-medium text-[var(--brand-fg)] transition-shadow hover:opacity-90"
        >
          Save &amp; use this CV
        </button>
      </div>
    </div>
  );
}

// ─── sub-components ─────────────────────────────────────────────────────────

function Section({
  title, subtitle, open, onToggle, children,
}: {
  title: string;
  subtitle?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--surface-2)]/40 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          {open
            ? <ChevronDown className="h-4 w-4 text-text-3" aria-hidden="true" />
            : <ChevronRight className="h-4 w-4 text-text-3" aria-hidden="true" />}
          <span className="text-[14px] font-medium text-text">{title}</span>
          {subtitle && <span className="text-xs text-text-3 ml-1">{subtitle}</span>}
        </div>
      </button>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </section>
  );
}

function Grid({ cols = 2, mt, children }: { cols?: number; mt?: boolean; children: React.ReactNode }) {
  const className = `grid gap-3 ${mt ? "mt-3" : ""} grid-cols-1 sm:grid-cols-${cols}`;
  return <div className={className}>{children}</div>;
}

function Field({
  label, value, onChange, bold,
}: { label: string; value: string; onChange: (v: string) => void; bold?: boolean }) {
  return (
    <label className="block">
      <span className="text-xs text-text-3">{label}</span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`block w-full mt-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[13px] text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30 ${bold ? "font-medium text-[14px]" : ""}`}
      />
    </label>
  );
}

function DatesField({ start, end, onStart, onEnd }: { start: string; end: string; onStart: (v: string) => void; onEnd: (v: string) => void }) {
  const blank = !start && !end;
  return (
    <div>
      <span className="text-xs text-text-3">
        Dates {blank && <span className="text-amber-700 dark:text-amber-300">· missing</span>}
      </span>
      <div className="grid grid-cols-2 gap-2 mt-1">
        <input
          type="text"
          value={start}
          onChange={e => onStart(e.target.value)}
          placeholder="Start"
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[13px] text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
        />
        <input
          type="text"
          value={end}
          onChange={e => onEnd(e.target.value)}
          placeholder="End or Present"
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[13px] text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
        />
      </div>
    </div>
  );
}

function BulletRow({ value, onChange, onRemove }: { value: string; onChange: (v: string) => void; onRemove: () => void }) {
  // Display the bullet marker as a leading dot (one only), input holds the
  // text content. The renderer adds the markdown "- " on the way to the
  // canonical CV.
  return (
    <div className="flex items-start gap-2">
      <span className="mt-2 select-none text-text-3 leading-none" aria-hidden="true">•</span>
      <textarea
        rows={2}
        className="flex-1 min-h-[36px] rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[13px] text-text focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30 resize-y"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove bullet"
        className="mt-1 text-text-3 hover:text-text p-1"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SkillsBucket({
  label, bucket, items, onAdd, onRemove,
}: {
  label: string;
  bucket: "domain_knowledge" | "soft_skills" | "technical";
  items: string[];
  onAdd: (b: "domain_knowledge" | "soft_skills" | "technical", v: string) => void;
  onRemove: (b: "domain_knowledge" | "soft_skills" | "technical", v: string) => void;
}) {
  const [input, setInput] = useState("");
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-text-3">{label}</div>
      <div className="flex flex-wrap gap-1.5 items-center">
        {items.map(s => (
          <span key={s} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-[var(--surface-2)] border border-[var(--border)]">
            {s}
            <button
              type="button"
              onClick={() => onRemove(bucket, s)}
              aria-label={`Remove ${s}`}
              className="text-text-3 hover:text-text"
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
          className="text-xs h-6 w-28 rounded border border-[var(--border)] bg-[var(--surface)] px-2"
        />
      </div>
    </div>
  );
}

function SaveBadge({ status, verified, err }: { status: SaveStatus; verified: boolean; err: string | null }) {
  const map: Record<SaveStatus, { text: string; tone: string }> = {
    idle:   { text: verified ? "Verified" : "Saved",         tone: "text-text-3" },
    dirty:  { text: "Unsaved — autosaving in 10s",           tone: "text-amber-700 dark:text-amber-300" },
    saving: { text: "Saving…",                               tone: "text-text-3" },
    saved:  { text: verified ? "Verified ✓" : "Saved ✓",     tone: "text-emerald-700 dark:text-emerald-300" },
    error:  { text: err ?? "Save failed",                    tone: "text-red-600 dark:text-red-400" },
  };
  const m = map[status];
  return <span className={`text-xs ${m.tone}`}>{m.text}</span>;
}

// Lightweight client-side mirror of gap detection (the authoritative list is
// recomputed server-side on save).
function clientGaps(d: StructuredCv): string[] {
  const g: string[] = [];
  if (!d.contact?.email) g.push("contact email missing");
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
