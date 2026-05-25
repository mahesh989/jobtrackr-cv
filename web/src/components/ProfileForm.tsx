"use client";

import { useTransition, useState } from "react";
import { createProfile, updateProfile } from "@/lib/actions";

interface Props {
  mode: "create" | "edit";
  profileId?: string;
  defaults?: {
    name: string;
    keywords: string[];
    location: string;
    visa_filter_mode: string;
    working_rights?: string;
    schedule_cron: string;
    is_active: boolean;
    target_verticals?: string[];
    adzuna_title_keywords?: string;
    adzuna_exclude_keywords?: string;
    adzuna_salary_min?: number;
    adzuna_salary_max?: number;
    adzuna_contract_type?: string;
    adzuna_hours?: string;
    adzuna_distance_km?: number;
    adzuna_max_days_old?: number;
    exclude_title_keywords?: string[];
    // Per-profile source selection (Migration 041)
    enabled_sources?: string[] | null;
    seek_method?: string;
    // Phase A automation config (defaults match Migration 031 column defaults)
    automation_enabled?:       boolean;
    // min_initial_ats / min_final_ats removed in migration 041 — global now.
    role_match_strict?:        boolean;
    auto_send_emails?:         string;
  };
}

export function ProfileForm({ mode, profileId, defaults }: Props) {
  const [pending, startTransition] = useTransition();

  const defaultIsActive = defaults?.is_active ?? false;
  const [runMode, setRunMode] = useState<"auto" | "manual">(defaultIsActive ? "auto" : "manual");

  const match = defaults?.schedule_cron?.match(/\*\/(\d+)/);
  const defaultDays = match ? match[1] : "2";

  // Pipeline automation — gate the dependent fields behind the on/off
  // toggle so the form clearly signals "off does nothing".
  const [automationOn, setAutomationOn] = useState<boolean>(defaults?.automation_enabled ?? false);

  // Track whether SEEK is selected — the SEEK fetch method block only
  // makes sense when SEEK is actually enabled.
  const defaultSeekOn = defaults?.enabled_sources
    ? defaults.enabled_sources.includes("seek")
    : true; // null = all sources on
  const [seekEnabled, setSeekEnabled] = useState<boolean>(defaultSeekOn);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      if (mode === "create") await createProfile(fd);
      else await updateProfile(profileId!, fd);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">

      {/* Name */}
      <div>
        <label className="block text-[12px] font-semibold text-text mb-1.5">Profile name</label>
        <input
          name="name" required
          defaultValue={defaults?.name}
          placeholder="e.g. Data Analyst — Sydney"
          className="field"
        />
      </div>

      {/* Keywords */}
      <div>
        <label className="block text-[12px] font-semibold text-text mb-1.5">
          Keywords <span className="font-normal text-text-2">(comma-separated)</span>
        </label>
        <textarea
          name="keywords" required rows={3}
          defaultValue={defaults?.keywords.join(", ")}
          placeholder="Data Analyst, SQL Analyst, Power BI Analyst, Analytics Engineer"
          className="field resize-none"
        />
        <p className="text-[11px] text-text-2 mt-1.5">
          Each keyword is searched <strong>separately</strong> on Adzuna and all other sources — more keywords means broader coverage. Results are then filtered to only keep jobs matching at least one.
        </p>
      </div>

      {/* Location */}
      <div>
        <label className="block text-[12px] font-semibold text-text mb-1.5">Location</label>
        <input
          name="location"
          defaultValue={defaults?.location}
          placeholder="Sydney NSW"
          className="field"
        />
      </div>

      {/* Working rights */}
      <div>
        <label className="block text-[12px] font-semibold text-text mb-1.5">Your working rights</label>
        <div className="flex flex-col gap-2.5">
          {[
            {
              value: "any",
              label: "Show everything",
              desc: "No filtering. Visa status shown as a label on each job.",
            },
            {
              value: "pr_citizen",
              label: "I have PR or Citizenship",
              desc: "Show all jobs — you can apply anywhere. Visa labels still shown for awareness.",
            },
            {
              value: "needs_sponsorship",
              label: "I need visa sponsorship",
              desc: "Jobs that explicitly say \"no sponsorship\" or \"citizens/PR only\" are excluded. Unmentioned jobs are kept — many employers will sponsor even if they don't say so.",
            },
          ].map((opt) => (
            <label key={opt.value} className="flex items-start gap-2.5 cursor-pointer group">
              <input
                type="radio" name="working_rights" value={opt.value}
                defaultChecked={(defaults?.working_rights ?? "any") === opt.value}
                className="mt-0.5 w-4 h-4 accent-[var(--brand)] cursor-pointer shrink-0"
              />
              <span>
                <span className="block text-[13px] font-medium text-text group-hover:text-[var(--brand)] transition-colors">{opt.label}</span>
                <span className="block text-[11px] text-text-2 leading-relaxed mt-0.5">{opt.desc}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Target Verticals */}
      <div>
        <label className="block text-[12px] font-semibold text-text mb-2">
          Target verticals <span className="font-normal text-text-2">(filters which sources are queried)</span>
        </label>
        <div className="flex flex-wrap gap-4">
          {["tech", "healthcare", "general"].map((v) => (
            <label key={v} className="flex items-center gap-2 text-[13px] text-text cursor-pointer capitalize font-medium">
              <input
                type="checkbox" name="target_verticals" value={v}
                defaultChecked={defaults?.target_verticals ? defaults.target_verticals.includes(v) : true}
                className="w-4 h-4 accent-[var(--brand)] cursor-pointer"
              />
              {v}
            </label>
          ))}
        </div>
      </div>

      {/* Sources */}
      <div>
        <label className="block text-[12px] font-semibold text-text mb-1.5">
          Sources <span className="font-normal text-text-2">(which job boards to scan)</span>
        </label>
        <div className="space-y-3 rounded-md border border-border bg-[var(--surface-2)] p-3">
          {[
            { group: "Aggregators", items: [
              { id: "adzuna",    label: "Adzuna" },
              { id: "seek",      label: "SEEK" },
              { id: "careerjet", label: "Careerjet" },
            ] },
            { group: "ATS boards", items: [
              { id: "greenhouse", label: "Greenhouse" },
              { id: "lever",      label: "Lever" },
            ] },
          ].map((grp) => (
            <div key={grp.group}>
              <p className="text-[10px] font-semibold text-text-3 uppercase tracking-wide mb-1.5">{grp.group}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {grp.items.map((s) => {
                  const enabledSet = defaults?.enabled_sources ? new Set(defaults.enabled_sources) : null;
                  const on = enabledSet ? enabledSet.has(s.id) : true; // null = all on
                  return (
                    <label key={s.id} className="flex items-center gap-2 text-[13px] text-text cursor-pointer font-medium">
                      <input
                        type="checkbox" name="enabled_sources" value={s.id}
                        defaultChecked={on}
                        onChange={s.id === "seek" ? (e) => setSeekEnabled(e.target.checked) : undefined}
                        className="w-4 h-4 accent-[var(--brand)] cursor-pointer"
                      />
                      {s.label}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}

          {/* SEEK fetch method — only shown when SEEK is enabled */}
          {seekEnabled && (
            <div className="pt-1 border-t border-border">
              <p className="text-[10px] font-semibold text-text-3 uppercase tracking-wide mb-1.5">SEEK fetch method</p>
              <div className="flex flex-col gap-1.5">
                {[
                  { value: "direct", label: "Direct (free)", desc: "Scrapes SEEK directly — no cost." },
                  { value: "actor",  label: "Apify actor (~$0.42/run)", desc: "Uses your Apify integration — more reliable depth, costs per run." },
                ].map((opt) => (
                  <label key={opt.value} className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio" name="seek_method" value={opt.value}
                      defaultChecked={(defaults?.seek_method ?? "direct") === opt.value}
                      className="mt-0.5 w-4 h-4 accent-[var(--brand)] cursor-pointer shrink-0"
                    />
                    <span>
                      <span className="block text-[12px] font-medium text-text">{opt.label}</span>
                      <span className="block text-[11px] text-text-2 leading-snug">{opt.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Initial fetch window */}
      <div>
        <label className="block text-[12px] font-semibold text-text mb-1.5">
          Initial fetch window <span className="font-normal text-text-2">(first run only)</span>
        </label>
        <select
          name="adzuna_max_days_old"
          defaultValue={defaults?.adzuna_max_days_old ?? 14}
          className="field"
        >
          <option value="1">Past 1 day</option>
          <option value="2">Past 2 days</option>
          <option value="3">Past 3 days</option>
          <option value="7">Past 7 days</option>
          <option value="14">Past 14 days (recommended)</option>
          <option value="21">Past 21 days</option>
          <option value="28">Past 28 days</option>
        </select>
        <p className="text-[11px] text-text-2 mt-1.5">
          How far back to look on the <strong>first</strong> run. After that, each auto-run automatically fetches only jobs posted since the previous run — so there's no redundancy.
        </p>
      </div>

      {/* Automation mode */}
      <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md p-4 space-y-4">
        <div>
          <label className="block text-[12px] font-semibold text-text mb-2">Automation mode</label>
          <div className="flex flex-wrap gap-5">
            {[
              { value: "manual", label: "Manual run only" },
              { value: "auto",   label: "Auto-run enabled" },
            ].map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-[13px] text-text cursor-pointer font-medium">
                <input
                  type="radio" name="run_mode" value={opt.value}
                  checked={runMode === opt.value}
                  onChange={() => setRunMode(opt.value as "auto" | "manual")}
                  className="w-4 h-4 accent-[var(--brand)] cursor-pointer"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        {runMode === "auto" && (
          <div className="pt-4 border-t border-[var(--border)]">
            <label className="block text-[12px] font-semibold text-text mb-2">Update frequency</label>
            <div className="flex items-center gap-3">
              <span className="text-[13px] text-text-2">Run every</span>
              <input
                type="number" name="auto_days" min="1" max="30"
                defaultValue={defaultDays}
                className="field text-center w-20"
              />
              <span className="text-[13px] text-text-2">days</span>
            </div>
            <p className="text-[11px] text-text-2 mt-1.5">The system automatically schedules the optimal time each day.</p>
          </div>
        )}
      </div>

      {/* Pipeline automation — gate-based auto-tailoring and auto-sending.
          Distinct from "Automation mode" above, which controls scrape
          SCHEDULING. This section controls what happens to the jobs after
          they're scraped: which ones get tailored CVs, which get cover
          letters, and how emails are sent. */}
      <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md p-4 space-y-4">
        <div>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              name="automation_enabled"
              checked={automationOn}
              onChange={(e) => setAutomationOn(e.target.checked)}
              className="mt-1 w-4 h-4 accent-[var(--brand)] cursor-pointer shrink-0"
            />
            <div className="min-w-0">
              <span className="block text-[13px] font-semibold text-text">Pipeline automation</span>
              <span className="block text-[11px] text-text-2 leading-relaxed mt-0.5">
                Auto-generate tailored CVs and cover letters after scraping. Each gate below decides whether to spend an AI call — saves cost on low-match jobs. <strong>Off</strong> means the pipeline only runs when you click Analyze manually.
              </span>
            </div>
          </label>
        </div>

        {automationOn && (
          <div className="pt-4 border-t border-[var(--border)] space-y-4">

            {/* ATS thresholds are global since migration 041 (initial 60,
                final 70). The per-profile inputs were removed to keep the
                rule predictable across the whole app — set in lib/atsThresholds. */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
              <p className="text-[12px] font-semibold text-text mb-1">ATS gates</p>
              <p className="text-[11px] text-text-2 leading-relaxed">
                Initial gate <strong>60</strong> — runs below this score stop before tailoring (saves ~3 AI calls).<br/>
                Final gate <strong>70</strong> — tailored CVs at or above this auto-trigger cover letter generation.<br/>
                <span className="text-text-3">These thresholds are global; the per-profile sliders were retired in May 2026.</span>
              </p>
            </div>

            {/* Strict role match */}
            <div>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox" name="role_match_strict"
                  defaultChecked={defaults?.role_match_strict ?? false}
                  className="mt-0.5 w-4 h-4 accent-[var(--brand)] cursor-pointer shrink-0"
                />
                <div className="min-w-0">
                  <span className="block text-[12px] font-semibold text-text">Strict role match</span>
                  <span className="block text-[11px] text-text-2 leading-relaxed mt-0.5">
                    Drop jobs whose title doesn&apos;t contain any of your keywords — before any AI call. Catches obvious mismatches (Software Engineer in a Data Analyst feed). Off by default; risks dropping titles that use synonyms.
                  </span>
                </div>
              </label>
            </div>

            {/* Email sending mode */}
            <div>
              <label className="block text-[12px] font-semibold text-text mb-2">Email sending mode</label>
              <div className="flex flex-col gap-2">
                {[
                  { value: "never",         label: "Never auto-send",          desc: "Cover letters and email drafts are generated; you click Send manually." },
                  { value: "after_review",  label: "Auto-send after I verify", desc: "Drafts wait in the outbox until you click Verify, then send automatically." },
                  { value: "auto",          label: "Auto-send without review", desc: "Drafts go straight to send without any review step. Use with caution." },
                ].map((opt) => (
                  <label key={opt.value} className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="radio" name="auto_send_emails" value={opt.value}
                      defaultChecked={(defaults?.auto_send_emails ?? "never") === opt.value}
                      className="mt-0.5 w-4 h-4 accent-[var(--brand)] cursor-pointer shrink-0"
                    />
                    <span>
                      <span className="block text-[12px] font-medium text-text">{opt.label}</span>
                      <span className="block text-[11px] text-text-2 leading-relaxed mt-0.5">{opt.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

          </div>
        )}

        {/* When the toggle is OFF we still submit the hidden fields so
            edits don't clobber existing values. min_initial_ats / min_final_ats
            were dropped from search_profiles in migration 041 — they're global
            constants now (see lib/atsThresholds). */}
        {!automationOn && (
          <>
            <input type="hidden" name="auto_send_emails" value={defaults?.auto_send_emails ?? "never"} />
            {(defaults?.role_match_strict ?? false) && (
              <input type="hidden" name="role_match_strict" value="on" />
            )}
          </>
        )}
      </div>

      {/* Smart filters */}
      <details className="bg-[var(--surface-2)] border border-[var(--border)] rounded-md group [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none text-[13px] font-semibold text-text">
          <span>Smart filters <span className="font-normal text-text-2">(optional — applied to all sources after fetching)</span></span>
          <svg className="w-4 h-4 text-text-2 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
          </svg>
        </summary>

        <div className="px-4 pb-4 pt-3 border-t border-[var(--border)] space-y-4">

          {/* How it works banner */}
          <div className="flex gap-2.5 p-3 bg-[#DDF4FF] border border-[var(--brand)]/20 rounded text-[11px] text-text">
            <svg className="w-3.5 h-3.5 text-[var(--brand)] mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <span>
              Sources fetch jobs broadly by keyword + location. These filters then run on <strong>every source</strong> to clean the results before anything is saved — no matter where the job came from.
            </span>
          </div>

          {/* Title must contain */}
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">
              Title must contain <span className="font-normal text-text-2">(enforced across all sources)</span>
            </label>
            <input name="adzuna_title_keywords" defaultValue={defaults?.adzuna_title_keywords} placeholder="e.g. analyst" className="field" />
            <p className="text-[11px] text-text-2 mt-1">
              Any job whose title does <em>not</em> contain this word is dropped. Use it to enforce role type — e.g. <strong>"analyst"</strong> removes project managers, coordinators, and other roles that sneak in through broad keywords.
            </p>
          </div>

          {/* Exclude from title */}
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">
              Exclude from title <span className="font-normal text-text-2">(comma-separated words or phrases)</span>
            </label>
            <input name="exclude_title_keywords" defaultValue={defaults?.exclude_title_keywords?.join(", ")} placeholder="e.g. senior, lead, principal, business analyst, head of" className="field" />
            <p className="text-[11px] text-text-2 mt-1">Any job whose title contains one of these is dropped. Great for filtering seniority levels or adjacent roles you don't want.</p>
          </div>

          {/* Exclude from description */}
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">
              Exclude from description <span className="font-normal text-text-2">(space or comma separated)</span>
            </label>
            <input name="adzuna_exclude_keywords" defaultValue={defaults?.adzuna_exclude_keywords} placeholder="e.g. unpaid volunteer internship" className="field" />
            <p className="text-[11px] text-text-2 mt-1">Any job whose description contains one of these words is dropped.</p>
          </div>

          {/* Salary range */}
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">
              Salary range hint <span className="font-normal text-text-2">(used where available)</span>
            </label>
            <div className="flex items-center gap-3">
              <input type="number" name="adzuna_salary_min" defaultValue={defaults?.adzuna_salary_min} placeholder="Min AU$" className="field" />
              <span className="text-text-3 shrink-0">–</span>
              <input type="number" name="adzuna_salary_max" defaultValue={defaults?.adzuna_salary_max} placeholder="Max AU$" className="field" />
            </div>
            <p className="text-[11px] text-text-2 mt-1">Passed to sources that support salary filtering. Not all sources provide salary data.</p>
          </div>

          {/* Auto-window note */}
          <div className="flex items-start gap-2 p-3 bg-[var(--surface-2)] border border-[var(--border)] rounded text-[11px] text-text-2">
            <svg className="w-3.5 h-3.5 text-text-3 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <span>
              <strong className="text-text">Subsequent runs are auto-windowed.</strong>{" "}
              After the first run, each auto-run fetches only jobs posted since the previous successful run (+ 1 day buffer). The initial fetch window above controls only the cold-start.
            </span>
          </div>
        </div>
      </details>

      {/* Submit */}
      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="gh-btn gh-btn-blue text-[13px] py-2 px-5"
        >
          {pending ? "Saving…" : mode === "create" ? "Create profile" : "Save changes"}
        </button>
        <a href="/dashboard" className="gh-btn text-[13px] py-2 px-5">
          Cancel
        </a>
      </div>
    </form>
  );
}
