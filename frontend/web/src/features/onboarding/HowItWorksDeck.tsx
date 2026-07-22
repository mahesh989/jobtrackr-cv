/**
 * HowItWorksDeck — the educational "How it works" swipe deck.
 *
 * Five cards (Key terms · Running a profile · How analysis runs · How to apply ·
 * How a job is tracked) rendered in a SwipeDeck. Shared by the instructions
 * "How it works" tab and the dashboard "Ready to scan" empty state, so the
 * empty dashboard teaches the pipeline instead of sitting blank.
 */

import { SwipeDeck } from "./SwipeDeck";
import { MIN_INITIAL_ATS, MIN_FINAL_ATS } from "@/lib/atsThresholds";

const TERMS: Array<{ term: string; def: string }> = [
  { term: "JD", def: "Job description." },
  { term: "Full JD / Rich JD", def: "A complete description was fetched — enough to analyse. (Two names for the same thing.)" },
  { term: "Thin JD", def: "The description is too short to analyse reliably. Paste the full JD to continue." },
  { term: "ATS", def: "Applicant Tracking System — the software employers use to screen CVs." },
  { term: "ATS score / match score", def: "A 0–100 estimate of how well a CV matches the job's keywords and requirements." },
  { term: "Initial gate", def: `Starting ATS threshold (${MIN_INITIAL_ATS}). Below it, a run stops before tailoring to save AI cost.` },
  { term: "Final gate", def: `Post-tailoring ATS threshold (${MIN_FINAL_ATS}). At or above this, a cover letter is auto-generated.` },
  { term: "Below initial / Below final", def: "Scored under the initial / final gate threshold." },
  { term: "ATS lift", def: "Points gained from your original CV to the tailored CV." },
  { term: "Tailored CV", def: "Your CV rewritten by the AI for one specific job (markdown + PDF)." },
  { term: "Saved / Duplicates / Filtered out", def: "Sourcing outcomes: Saved = new jobs added; Duplicates = already in your feed (by URL or near-identical text); Filtered out = dropped by keyword/smart-filter rules." },
  { term: "Has email", def: "A hiring contact email was found for the job — enables Send email." },
];

function FlowBox({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "gate" | "end" }) {
  const cls =
    tone === "gate"
      ? "border-[var(--amber)]/40 bg-[var(--amber-light)] text-[var(--amber)]"
      : tone === "end"
      ? "border-[var(--green)]/40 bg-[var(--green-light)] text-[var(--green)]"
      : "border-border bg-[var(--surface-2)] text-text";
  return (
    <div className={`rounded-md border px-3 py-2 text-label font-medium text-center ${cls}`}>
      {children}
    </div>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center py-1 text-text-3">
      {label && <span className="text-micro mb-0.5">{label}</span>}
      <span className="text-title leading-none">↓</span>
    </div>
  );
}

export function HowItWorksDeck() {
  // Story first, vocabulary last: the journey cards (run → analyse → apply →
  // track) introduce every concept in context; the glossary is a reference to
  // close on, not a prerequisite to wade through.
  const cards = [
    {
      id: "discovery",
      title: "Running a profile",
      body: (
        <>
          <p className="text-label text-text-2 mb-3 text-center">What happens in one run of your profile:</p>
          <div className="max-w-sm mx-auto">
            <FlowBox>Fetch — every enabled source for your keywords + location</FlowBox>
            <Arrow />
            <FlowBox>De-duplicate — drop same-URL, cross-profile &amp; near-identical jobs</FlowBox>
            <Arrow />
            <FlowBox>Filter — remove keyword mismatches &amp; smart-filter hits</FlowBox>
            <Arrow />
            <FlowBox>Enrich — fetch full JDs where possible (SEEK, Careerjet)</FlowBox>
            <Arrow />
            <FlowBox tone="end">Save &amp; score — survivors land in your feed, AI-scored (~1–2 min)</FlowBox>
          </div>
          <p className="text-caption text-text-3 mt-3 text-center">If scheduled, this repeats automatically.</p>
        </>
      ),
    },
    {
      id: "analysis",
      title: "How analysis runs",
      body: (
        <>
          <p className="text-label text-text-2 mb-3 text-center">
            Per job, when you click <span className="font-medium text-text">Analyze</span>:
          </p>
          <div className="max-w-sm mx-auto">
            <FlowBox>Analyse job description</FlowBox>
            <Arrow />
            <FlowBox>Match CV to JD</FlowBox>
            <Arrow />
            <FlowBox>ATS scoring (initial score)</FlowBox>
            <Arrow />
            <FlowBox tone="gate">Initial gate (≥ {MIN_INITIAL_ATS}?) — below can stop here</FlowBox>
            <Arrow label="passes" />
            <FlowBox>Build recommendations</FlowBox>
            <Arrow />
            <FlowBox>Classify keyword feasibility</FlowBox>
            <Arrow />
            <FlowBox>Generate AI advice</FlowBox>
            <Arrow />
            <FlowBox>Create tailored CV → re-score (ATS lift)</FlowBox>
            <Arrow />
            <FlowBox tone="gate">Final gate (≥ {MIN_FINAL_ATS}?)</FlowBox>
            <Arrow />
            <FlowBox tone="end">Generate cover letter (always your choice)</FlowBox>
          </div>
        </>
      ),
    },
    {
      id: "applying",
      title: "How to apply (email vs non-email)",
      body: (
        <>
          <p className="text-label text-text-2 mb-2">
            When a cover letter is ready, the job appears in your <span className="font-medium text-text">Applications</span> pool:
          </p>
          <ul className="space-y-1.5 text-label text-text-2 list-disc pl-5">
            <li>
              <span className="font-medium text-text">Application pool</span> — all jobs waiting for you to act. Expand any card to preview and edit the tailored CV, cover letter, and email message inline.
            </li>
            <li>
              <span className="font-medium text-text">Ready to send:</span>
              <ul className="mt-1 space-y-1 list-[circle] pl-5">
                <li><span className="font-medium text-text">Email jobs</span> (contact found) → <span className="font-medium text-text">Send email</span> dispatches via your connected Gmail/Outlook.</li>
                <li><span className="font-medium text-text">No-email jobs</span> → <span className="font-medium text-text">Copy email</span> (paste into your own client) + <span className="font-medium text-text">Apply now</span> (opens the job link).</li>
              </ul>
            </li>
            <li><span className="font-medium text-text">Mark applied</span> → moves to the <span className="font-medium text-text">Sent</span> tab. You can move it back to the pool if needed.</li>
          </ul>
          <p className="text-label text-text-3 mt-2">Nothing leaves your account until you press Send or Apply.</p>
        </>
      ),
    },
    {
      id: "tracking",
      title: "How a job is tracked",
      body: (
        <>
          <p className="text-label text-text-2 mb-3">
            Each job carries one <span className="font-medium text-text">state</span> badge showing where it is:
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-caption">
            {["Discovered", "Analysing", "Below initial / final", "Ready to apply / send", "Applied", "Archived"].map((s, idx, arr) => (
              <span key={s} className="flex items-center gap-1.5">
                <span className="px-2 py-0.5 rounded-full border border-border bg-[var(--surface-2)] text-text-2">{s}</span>
                {idx < arr.length - 1 && <span className="text-text-3">→</span>}
              </span>
            ))}
          </div>
          <p className="text-label text-text-2 mt-3">
            You can <span className="font-medium text-text">Mark applied</span> or <span className="font-medium text-text">Dismiss</span> a job at any time. The dashboard funnel rolls these states up so you always see where your pipeline stands.
          </p>
        </>
      ),
    },
    {
      id: "terms",
      title: "Key terms",
      body: (
        <dl className="divide-y divide-border">
          {TERMS.map((t) => (
            <div key={t.term} className="py-2.5 first:pt-0 sm:flex sm:gap-4">
              <dt className="text-body font-semibold text-text sm:w-48 sm:shrink-0">{t.term}</dt>
              <dd className="text-label text-text-2 leading-relaxed mt-0.5 sm:mt-0">{t.def}</dd>
            </div>
          ))}
        </dl>
      ),
    },
  ];

  return <SwipeDeck cards={cards} />;
}
