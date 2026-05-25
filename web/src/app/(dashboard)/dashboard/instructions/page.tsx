/**
 * /dashboard/instructions — the in-app guide.
 *
 *   Left column   Get set up   — the SetupGuide stepped cards (with live ✓).
 *   Right column  Key terms    — glossary of the app's vocabulary.
 *                 How it works — discovery run, analysis flow, applying, tracking.
 *
 * Server-rendered. Reachable any time from the sidebar; also what new users
 * see on the dashboard until their first run produces data. `?step=N` opens
 * the setup guide on a specific card (used by the SetupReturnBar round-trip).
 */

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { SetupGuide, SETUP_STEP_COUNT } from "@/components/onboarding/SetupGuide";
import { getSetupStatus } from "@/lib/setupStatus";
import { MIN_INITIAL_ATS, MIN_FINAL_ATS } from "@/lib/atsThresholds";

export const metadata = { title: "Instructions — JobTrackr" };

const TERMS: Array<{ term: string; def: string }> = [
  { term: "Search profile", def: "Your saved job radar — keywords + location + schedule. Each run scans sources for matches." },
  { term: "Run / pipeline", def: "One execution of discovery for a profile: scrape → de-duplicate → filter → save." },
  { term: "Source", def: "Where jobs come from — five active Australian sources: SEEK, Adzuna, Careerjet, Greenhouse and Lever." },
  { term: "JD", def: "Job description." },
  { term: "Full JD / Rich JD", def: "A complete description was fetched — enough to analyse. (Two names for the same thing.)" },
  { term: "Thin JD", def: "The description is too short to analyse reliably. Paste the full JD to continue." },
  { term: "Unclassified", def: "JD quality not yet determined." },
  { term: "Role match / mismatch", def: "Whether the job title fits your profile's keywords." },
  { term: "ATS", def: "Applicant Tracking System — the software employers use to screen CVs." },
  { term: "ATS score / match score", def: "A 0–100 estimate of how well a CV matches the job's keywords and requirements." },
  { term: "Initial gate", def: `Starting ATS threshold (${MIN_INITIAL_ATS}). Below it, a run stops before tailoring to save AI cost.` },
  { term: "Final gate", def: `Post-tailoring ATS threshold (${MIN_FINAL_ATS}). At or above this, a cover letter is auto-generated.` },
  { term: "Below initial / Below final", def: "Scored under the initial / final gate threshold." },
  { term: "ATS lift", def: "Points gained from your original CV to the tailored CV." },
  { term: "Tailored CV", def: "Your CV rewritten by the AI for one specific job (markdown + PDF)." },
  { term: "Cover letter", def: "An AI-drafted letter for a job, written in your writing voice." },
  { term: "BYOK", def: "Bring Your Own Key — you supply your own AI provider API key." },
  { term: "Saved / Duplicates / Filtered out", def: "Sourcing outcomes: Saved = new jobs added; Duplicates = already in your feed (by URL or near-identical text); Filtered out = dropped by keyword/smart-filter rules." },
  { term: "Has email", def: "A hiring contact email was found for the job — enables Send email." },
  { term: "Auto-scheduled", def: "The profile runs automatically on its schedule." },
];

function FlowBox({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "gate" | "end" }) {
  const cls =
    tone === "gate"
      ? "border-[var(--amber)]/40 bg-[var(--amber-light)] text-[var(--amber)]"
      : tone === "end"
      ? "border-[var(--green)]/40 bg-[var(--green-light)] text-[var(--green)]"
      : "border-border bg-[var(--surface-2)] text-text";
  return (
    <div className={`rounded-md border px-3 py-2 text-[12px] font-medium text-center ${cls}`}>
      {children}
    </div>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center py-1 text-text-3">
      {label && <span className="text-[10px] mb-0.5">{label}</span>}
      <span className="text-[14px] leading-none">↓</span>
    </div>
  );
}

export default async function InstructionsPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profileRows } = await supabase
    .from("search_profiles").select("id");
  const ids = ((profileRows ?? []) as Array<{ id: string }>).map((p) => p.id);

  const status = await getSetupStatus(user.id, ids);

  // ?step=N (1-based) re-opens the setup guide on a specific card.
  const sp = await searchParams;
  const stepNum = Number(sp?.step);
  const initialStep = Number.isFinite(stepNum)
    ? Math.min(Math.max(stepNum - 1, 0), SETUP_STEP_COUNT - 1)
    : 0;

  return (
    <div className="min-h-full">
      {/* Header */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <span className="text-text-2">Instructions</span>
        </div>
        <h1 className="text-[16px] font-semibold text-text">Instructions</h1>
        <p className="text-[12px] text-text-2 mt-0.5">
          Get set up, learn the vocabulary, and see how the pipeline works end to end.
        </p>
      </div>

      <div className="px-6 py-6 max-w-6xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)] gap-8 lg:gap-10 items-start">
          {/* Left — Get set up (sticky so it stays in view beside the long glossary) */}
          <section className="anim-in lg:sticky lg:top-6">
            <h2 className="text-[14px] font-semibold text-text mb-1">Get set up</h2>
            <p className="text-[12px] text-text-2 mb-4">
              Step through the cards below. A green check means that step is already done.
            </p>
            <SetupGuide status={status} initialStep={initialStep} returnTo="/dashboard/instructions" />
          </section>

          {/* Right — Key terms + How it works */}
          <div className="min-w-0 space-y-10">
            {/* Key terms */}
            <section className="anim-in">
              <h2 className="text-[14px] font-semibold text-text mb-3">Key terms</h2>
              <dl className="bg-surface border border-border rounded-md divide-y divide-border">
                {TERMS.map((t) => (
                  <div key={t.term} className="px-4 py-3 sm:flex sm:gap-4">
                    <dt className="text-[13px] font-semibold text-text sm:w-52 sm:shrink-0">{t.term}</dt>
                    <dd className="text-[12px] text-text-2 leading-relaxed mt-0.5 sm:mt-0">{t.def}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {/* How it works */}
            <section className="anim-in space-y-6">
              <h2 className="text-[14px] font-semibold text-text">How it works</h2>

              {/* discovery run */}
              <div className="bg-surface border border-border rounded-md p-4">
                <h3 className="text-[13px] font-semibold text-text mb-2">What happens when you run a profile</h3>
                <ol className="space-y-1.5 text-[12px] text-text-2 list-decimal pl-5">
                  <li><span className="font-medium text-text">Fetch</span> — pulls listings from every enabled source for your keywords + location.</li>
                  <li><span className="font-medium text-text">De-duplicate</span> — drops jobs already in your feed (same URL, across profiles, near-identical text).</li>
                  <li><span className="font-medium text-text">Filter</span> — removes jobs that don&apos;t match your keywords or hit smart-filter rules.</li>
                  <li><span className="font-medium text-text">Enrich</span> — fetches full descriptions where possible (e.g. SEEK, Careerjet).</li>
                  <li><span className="font-medium text-text">Save &amp; score</span> — survivors land in your feed, AI-scored. First results in ~1–2 min. If scheduled, this repeats automatically.</li>
                </ol>
              </div>

              {/* analysis flow */}
              <div className="bg-surface border border-border rounded-md p-4">
                <h3 className="text-[13px] font-semibold text-text mb-1">How analysis runs</h3>
                <p className="text-[12px] text-text-2 mb-3">
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
              </div>

              {/* applying */}
              <div className="bg-surface border border-border rounded-md p-4">
                <h3 className="text-[13px] font-semibold text-text mb-2">How to apply (email vs non-email)</h3>
                <p className="text-[12px] text-text-2 mb-2">
                  When a cover letter is ready, the job enters your <span className="font-medium text-text">Applications</span> outbox:
                </p>
                <ul className="space-y-1.5 text-[12px] text-text-2 list-disc pl-5">
                  <li><span className="font-medium text-text">Pool</span> → queue it for review.</li>
                  <li><span className="font-medium text-text">Review</span> → preview and edit the letter (and email subject/body), then approve.</li>
                  <li>
                    <span className="font-medium text-text">Ready to apply:</span>
                    <ul className="mt-1 space-y-1 list-[circle] pl-5">
                      <li><span className="font-medium text-text">Email jobs</span> (contact found) → <span className="font-medium text-text">Send email</span> dispatches via your connected Gmail/Outlook.</li>
                      <li><span className="font-medium text-text">No-email jobs</span> → <span className="font-medium text-text">Copy email</span> (paste into your own client) + <span className="font-medium text-text">Apply now</span> (opens the job link).</li>
                    </ul>
                  </li>
                  <li><span className="font-medium text-text">Mark applied</span> → moves to <span className="font-medium text-text">Sent</span>.</li>
                </ul>
                <p className="text-[12px] text-text-3 mt-2">Nothing leaves your account until you press Send or Apply.</p>
              </div>

              {/* tracking */}
              <div className="bg-surface border border-border rounded-md p-4">
                <h3 className="text-[13px] font-semibold text-text mb-2">How a job is tracked</h3>
                <p className="text-[12px] text-text-2 mb-3">
                  Each job carries one <span className="font-medium text-text">state</span> badge showing where it is:
                </p>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  {["Discovered", "Analysing", "Below initial / final", "Ready to apply / send", "Applied", "Archived"].map((s, idx, arr) => (
                    <span key={s} className="flex items-center gap-1.5">
                      <span className="px-2 py-0.5 rounded-full border border-border bg-[var(--surface-2)] text-text-2">{s}</span>
                      {idx < arr.length - 1 && <span className="text-text-3">→</span>}
                    </span>
                  ))}
                </div>
                <p className="text-[12px] text-text-2 mt-3">
                  You can <span className="font-medium text-text">Mark applied</span> or <span className="font-medium text-text">Dismiss</span> a job at any time. The dashboard funnel and{" "}
                  <Link href="/dashboard/analytics" className="text-[var(--brand)] hover:underline">Analytics</Link> roll these states up.
                </p>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
