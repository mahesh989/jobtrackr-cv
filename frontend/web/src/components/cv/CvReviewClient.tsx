"use client";

/**
 * CvReviewClient — the post-upload review form.
 *
 * Forced step: every freshly-structurized CV is sent through here. The form
 * is fully editable inline (contact, summary, skills chips, experience with
 * inline bullets, education, certifications, references). On any change, a
 * 10-second debounced autosave PATCHes /api/cv/:id/structured which:
 *   1. re-renders canonical markdown via cv-backend,
 *   2. persists both `structured_cv` and `normalized_cv_text`.
 *
 * "Save & continue" forces an immediate save with verified=true and bounces
 * the user back to the CV library.
 *
 * NOT an analysis step. We never filter roles, drop bullets, or score
 * vertical alignment here — purely rearranging the user's CV into a
 * consistent shape so the pipeline sees the same skeleton for every user.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  StructuredCv,
  StructuredCvContact,
  StructuredCvExperience,
  StructuredCvEducation,
  StructuredCvCertification,
} from "@/lib/cvBackend";

const AUTOSAVE_MS = 10_000;

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

interface Props {
  cvId:                 string;
  label:                string;
  initialStructuredCv:  StructuredCv;
  initialStatus:        string;
}

export function CvReviewClient({ cvId, label, initialStructuredCv, initialStatus }: Props) {
  const router = useRouter();
  const [doc, setDoc]   = useState<StructuredCv>(initialStructuredCv);
  const [status, setStatus] = useState<string>(initialStatus);
  const [save, setSave] = useState<SaveStatus>("idle");
  const [err, setErr]   = useState<string | null>(null);

  // Debounced autosave: 10s after the last change. A pending timer is cleared
  // on every edit so saves only fire once the user pauses.
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

  // Schedule a debounced autosave whenever `doc` changes (skip initial mount).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    setSave("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { persist(doc, false); }, AUTOSAVE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [doc, persist]);

  // "Save & continue" — flush any pending debounce + mark verified.
  async function saveAndExit() {
    if (timer.current) clearTimeout(timer.current);
    const ok = await persist(doc, true);
    if (ok) router.push("/dashboard/cv");
  }

  // Derived: counts gaps that still apply after edits. We re-derive client-
  // side using the same lightweight rules the backend uses — it's only a
  // hint; the authoritative gap list is recomputed server-side on save.
  const liveGaps = useMemo(() => clientGaps(doc), [doc]);

  // — patching helpers (immutable updates) —
  const patchContact = (next: Partial<StructuredCvContact>) =>
    setDoc(d => ({ ...d, contact: { ...d.contact, ...next } }));
  const patchExperience = (i: number, next: Partial<StructuredCvExperience>) =>
    setDoc(d => ({ ...d, experience: d.experience.map((e, idx) => idx === i ? { ...e, ...next } : e) }));
  const patchEducation = (i: number, next: Partial<StructuredCvEducation>) =>
    setDoc(d => ({ ...d, education: d.education.map((e, idx) => idx === i ? { ...e, ...next } : e) }));
  const patchCert = (i: number, next: Partial<StructuredCvCertification>) =>
    setDoc(d => ({ ...d, certifications: d.certifications.map((c, idx) => idx === i ? { ...c, ...next } : c) }));

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
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs uppercase tracking-wide text-text-2">Required after upload · not analysis</div>
          <h1 className="text-xl font-medium mt-1">Review &amp; tidy your CV</h1>
          <p className="text-sm text-text-2 mt-1">
            We rearranged <span className="font-medium">{label}</span> into a consistent format.
            Edit anything that&apos;s wrong, then save. This tidied CV is what the pipeline uses.
          </p>
        </div>
        <SaveBadge status={save} verified={status === "verified"} err={err} />
      </header>

      {liveGaps.length > 0 ? (
        <div className="rounded-md border border-amber-300/60 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          {liveGaps.length} item{liveGaps.length === 1 ? "" : "s"} need your attention — you can fill them now or skip and analyse anyway.
        </div>
      ) : (
        <div className="rounded-md border border-emerald-300/60 bg-emerald-50/70 dark:bg-emerald-950/30 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-200">
          All set — nothing flagged.
        </div>
      )}

      {/* CONTACT */}
      <Card title="Contact">
        <Grid>
          <Field label="Name"     value={doc.contact.name}     onChange={v => patchContact({ name: v })} />
          <Field label="Email"    value={doc.contact.email}    onChange={v => patchContact({ email: v })} />
          <Field label="Phone"    value={doc.contact.phone}    onChange={v => patchContact({ phone: v })} />
          <Field label="Location" value={doc.contact.location} onChange={v => patchContact({ location: v })} />
        </Grid>
      </Card>

      {/* SKILLS (above Summary per product decision) */}
      <Card title="Skills" sub="From your CV — remove junk or add your own">
        <SkillsBucket label="Care skills"      bucket="domain_knowledge" items={doc.skills.domain_knowledge} onAdd={addSkill} onRemove={removeSkill} />
        <SkillsBucket label="Soft skills"      bucket="soft_skills"      items={doc.skills.soft_skills}      onAdd={addSkill} onRemove={removeSkill} />
        <SkillsBucket label="Tools & software" bucket="technical"        items={doc.skills.technical}        onAdd={addSkill} onRemove={removeSkill} />
      </Card>

      {/* SUMMARY */}
      <Card title="Profile summary">
        <textarea
          rows={4}
          className="w-full"
          value={doc.summary}
          onChange={e => setDoc(d => ({ ...d, summary: e.target.value }))}
          placeholder="A short paragraph describing your background."
        />
      </Card>

      {/* EXPERIENCE */}
      <Card title="Experience" sub="All roles &amp; bullets kept — edit freely">
        {doc.experience.length === 0 ? (
          <p className="text-sm text-text-2">No roles found.</p>
        ) : doc.experience.map((e, i) => (
          <div key={i} className={`pb-4 ${i < doc.experience.length - 1 ? "border-b border-border mb-4" : ""}`}>
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
              {e.bullets.map((b, bi) => (
                <div key={bi} className="flex gap-2 items-start">
                  <span className="text-text-2 mt-2">•</span>
                  <textarea
                    rows={2}
                    className="flex-1 min-h-[40px]"
                    value={b}
                    onChange={ev => setBullet(i, bi, ev.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => removeBullet(i, bi)}
                    className="text-text-2 hover:text-text-1 text-xs"
                    aria-label="Remove bullet"
                  >×</button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => addBullet(i)}
                className="text-xs px-2 py-1 mt-1"
              >+ Add bullet</button>
            </div>
          </div>
        ))}
      </Card>

      {/* EDUCATION */}
      <Card title="Education">
        {doc.education.length === 0 ? (
          <p className="text-sm text-text-2">No education found.</p>
        ) : doc.education.map((e, i) => (
          <div key={i} className={`pb-3 ${i < doc.education.length - 1 ? "border-b border-border mb-3" : ""}`}>
            {e._moved_from_certifications && (
              <div className="text-[11px] inline-block mb-1 px-2 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
                Moved here from certifications (care qualifications go in Education)
              </div>
            )}
            <Field label="Institution"   value={e.institution}   onChange={v => patchEducation(i, { institution: v })} bold />
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
                checked={e.completed}
                onChange={ev => patchEducation(i, { completed: ev.target.checked })}
              />
              Completed
            </label>
          </div>
        ))}
      </Card>

      {/* CERTIFICATIONS — only shown if anything remained after Cert IV moved out */}
      {doc.certifications.length > 0 && (
        <Card title="Certifications &amp; licences" sub="Care VET qualifications have moved to Education automatically">
          {doc.certifications.map((c, i) => (
            <div key={i} className={`pb-3 ${i < doc.certifications.length - 1 ? "border-b border-border mb-3" : ""}`}>
              <Field label="Name" value={c.name} onChange={v => patchCert(i, { name: v })} bold />
              <Grid cols={3} mt>
                <Field label="Issuer"      value={c.issuer}      onChange={v => patchCert(i, { issuer: v })} />
                <Field label="Code"        value={c.code}        onChange={v => patchCert(i, { code: v })} />
                <Field label="Issued"      value={c.issued_date} onChange={v => patchCert(i, { issued_date: v })} />
              </Grid>
            </div>
          ))}
        </Card>
      )}

      {/* SAVE BAR */}
      <div className="sticky bottom-0 mt-6 -mx-6 px-6 py-3 bg-surface/95 backdrop-blur border-t border-border flex items-center justify-between">
        <div className="text-xs text-text-2">Edits autosave every 10 seconds.</div>
        <button
          type="button"
          onClick={saveAndExit}
          className="px-4 py-2 text-sm"
        >
          Save &amp; use this CV
        </button>
      </div>
    </div>
  );
}

// ─── tiny sub-components ─────────────────────────────────────────────────────

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        {sub && <p className="text-xs text-text-2 mt-0.5">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

function Grid({ cols = 2, mt, children }: { cols?: number; mt?: boolean; children: React.ReactNode }) {
  const className = `grid gap-2 ${mt ? "mt-2" : ""} grid-cols-1 sm:grid-cols-${cols}`;
  return <div className={className}>{children}</div>;
}

function Field({ label, value, onChange, bold }: { label: string; value: string; onChange: (v: string) => void; bold?: boolean }) {
  return (
    <label className="block text-xs text-text-2">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`block w-full mt-1 ${bold ? "font-medium text-sm" : ""}`}
      />
    </label>
  );
}

function DatesField({ start, end, onStart, onEnd }: { start: string; end: string; onStart: (v: string) => void; onEnd: (v: string) => void }) {
  const blank = !start && !end;
  return (
    <div>
      <span className="block text-xs text-text-2">Dates {blank && <span className="text-amber-700 dark:text-amber-300">· missing</span>}</span>
      <div className="flex gap-1 mt-1">
        <input
          type="text"
          value={start}
          onChange={e => onStart(e.target.value)}
          placeholder="Start (e.g. Jan 2024)"
          className="w-1/2"
        />
        <input
          type="text"
          value={end}
          onChange={e => onEnd(e.target.value)}
          placeholder="End or Present"
          className="w-1/2"
        />
      </div>
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
      <div className="text-xs text-text-2">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map(s => (
          <span key={s} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-surface-2">
            {s}
            <button
              type="button"
              onClick={() => onRemove(bucket, s)}
              aria-label={`Remove ${s}`}
              className="text-text-2 hover:text-text-1"
            >×</button>
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); onAdd(bucket, input); setInput(""); }
            }}
            placeholder="add…"
            className="text-xs h-7 w-28"
          />
        </span>
      </div>
    </div>
  );
}

function SaveBadge({ status, verified, err }: { status: SaveStatus; verified: boolean; err: string | null }) {
  const map: Record<SaveStatus, { text: string; tone: string }> = {
    idle:   { text: verified ? "Verified" : "Saved", tone: "text-text-2" },
    dirty:  { text: "Unsaved — autosaving in 10s",   tone: "text-amber-700 dark:text-amber-300" },
    saving: { text: "Saving…",                       tone: "text-text-2" },
    saved:  { text: verified ? "Verified" : "Saved", tone: "text-emerald-700 dark:text-emerald-300" },
    error:  { text: err ?? "Save failed",            tone: "text-red-700 dark:text-red-300" },
  };
  const m = map[status];
  return <span className={`text-xs ${m.tone}`}>{m.text}</span>;
}

// ─── client-side mirror of gap detection (UI hint only) ──────────────────────
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
