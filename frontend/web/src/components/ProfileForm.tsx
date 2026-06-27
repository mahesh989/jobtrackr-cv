"use client";

/**
 * ProfileForm — search-profile editor.
 *
 * 2026-05-27 redesign: six numbered sections (Identity / Search / Filters /
 * Sources / Schedule / Automation pipeline). The submit contract is unchanged
 * — the same FormData field names flow into createProfile/updateProfile so
 * the server action keeps working as-is.
 *
 * Fields the new UI no longer surfaces but the schema still has — target
 * verticals, role_match_strict, adzuna_title_keywords — are passed through
 * as hidden inputs at their existing values so an edit doesn't clobber
 * them. Salary range was dropped on user request.
 *
 * The "Title must include any of" field writes to `must_include_phrases`
 * (the more flexible CSV field) and forces `adzuna_title_keywords` to ""
 * to retire the single-word duplicate filter.
 */

import { useTransition, useState } from "react";
import { ChevronDown } from "lucide-react";
import { createProfile, updateProfile } from "@/lib/actions";
import { LocationAutocomplete } from "@/components/LocationAutocomplete";

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
    must_include_phrases?: string[];
    enabled_sources?: string[] | null;
    seek_method?: string;
    adzuna_method?: string;
    automation_enabled?: boolean;
    role_match_strict?: boolean;
    auto_send_emails?: string;
    home_address?: string | null;
  };
}


function Hint({ text }: { text: string }) {
  return (
    <span
      title={text}
      className="inline-flex items-center justify-center w-3.5 h-3.5 ml-1 rounded-full border border-border text-[9px] font-bold text-text-2 cursor-help align-middle"
    >
      ?
    </span>
  );
}

function SectionHeader({ step, title, subtitle }: { step: number; title: string; subtitle?: string }) {
  return (
    <div className="flex items-baseline gap-3 mb-3">
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--brand)] text-white text-[11px] font-semibold shrink-0">
        {step}
      </span>
      <div>
        <h3 className="text-[14px] font-semibold text-text leading-none">{title}</h3>
        {subtitle && <p className="text-[11px] text-text-2 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

export function ProfileForm({ mode, profileId, defaults }: Props) {
  const [pending, startTransition] = useTransition();

  const defaultIsActive = defaults?.is_active ?? false;
  const [runMode, setRunMode] = useState<"auto" | "manual">(defaultIsActive ? "auto" : "manual");

  const cronMatch = defaults?.schedule_cron?.match(/\*\/(\d+)/);
  const defaultDays = cronMatch ? cronMatch[1] : "2";

  const [automationOn, setAutomationOn] = useState<boolean>(defaults?.automation_enabled ?? false);
  const tailorMode: "off" | "auto" = automationOn ? "auto" : "off";

  // Job-source selection + per-source method moved to Admin → Integrations
  // (platform_sources, migration 063). It's now a global admin setting applied
  // to every user's runs, so the profile form no longer carries it.

  const [sendMode, setSendMode] = useState<"never" | "after_review" | "auto">(
    (defaults?.auto_send_emails as "never" | "after_review" | "auto") ?? "never",
  );

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      if (mode === "create") await createProfile(fd);
      else await updateProfile(profileId!, fd);
    });
  }

  const sendActive = sendMode !== "never";
  const sendDetail = sendMode === "auto" ? "no review" : sendMode === "after_review" ? "after verify" : "off";

  return (
    <form onSubmit={handleSubmit} className="space-y-6">

      {/* The unified "Title must include" field below writes to
          must_include_phrases instead — retire the single-word filter. */}
      <input type="hidden" name="adzuna_title_keywords" value="" />
      {/* Strict role-match was merged into the unified title filter conceptually;
          keep submitting the previous value so behavior doesn't silently change. */}
      {(defaults?.role_match_strict ?? false) && (
        <input type="hidden" name="role_match_strict" value="on" />
      )}
      {/* Salary fields intentionally absent → extractAdzunaFields sets them to null. */}

      {/* ───── 1. Identity ──────────────────────────────────────────── */}
      <section>
        <SectionHeader step={1} title="Identity" />
        <input
          name="name"
          required
          defaultValue={defaults?.name}
          placeholder="e.g. Data Analyst — Sydney"
          className="field"
        />
      </section>

      {/* Role type is NOT set per search profile — it's the user's one global
          choice in My CV ("What roles are you applying for?"), which applies to
          all CVs and drives the tailoring pipeline. The old per-profile dropdown
          was removed; routing reads contact_details.role_families. */}

      {/* ───── 2. Search ────────────────────────────────────────────── */}
      <section>
        <SectionHeader
          step={2}
          title="Search"
          subtitle="What you're looking for. Each keyword fires a separate search across enabled sources."
        />
        <div className="space-y-3">
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">
              Keywords <span className="font-normal text-text-2">(comma-separated)</span>
              <Hint text="Each keyword is searched separately on every enabled source. More keywords = broader coverage. Results are then filtered (see Section 3)." />
            </label>
            <textarea
              name="keywords"
              required
              rows={2}
              defaultValue={defaults?.keywords.join(", ")}
              placeholder="Data Analyst, BI Analyst, Analytics Engineer"
              className="field resize-none"
            />
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">Location</label>
            <LocationAutocomplete
              name="location"
              defaultValue={defaults?.location}
              placeholder="Sydney NSW"
            />
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">
              Your address <span className="font-normal text-text-2">(optional — used for distance display)</span>
              <Hint text="When set, each job shows driving distance from here to the listing's suburb. Free public geocoding (Nominatim) + routing (OSRM). Leave empty to hide distance." />
            </label>
            <input
              name="home_address"
              defaultValue={defaults?.home_address ?? ""}
              placeholder="e.g. 123 Pitt Street, Sydney NSW 2000"
              className="field"
            />
          </div>
        </div>
      </section>

      {/* ───── 3. Filters ───────────────────────────────────────────── */}
      <section>
        <SectionHeader
          step={3}
          title="Filters"
          subtitle="Applied to every source after fetching, before anything is saved."
        />
        <div className="space-y-4 rounded-md border border-border bg-[var(--surface-2)] p-4">

          {/* Working rights — 2 options. Legacy 'pr_citizen' folds into 'any'
              since they were functionally identical (both show all jobs). */}
          <div>
            <label className="block text-[12px] font-semibold text-text mb-2">Working rights</label>
            <div className="flex flex-col gap-2">
              {[
                { value: "any",                label: "I can apply anywhere",   desc: "Show all jobs. Visa status shown as a label per job." },
                { value: "needs_sponsorship",  label: "I need visa sponsorship", desc: 'Drop jobs that say "no sponsorship" or "citizens/PR only". Unmentioned jobs kept — most employers will sponsor.' },
              ].map((opt) => {
                const current = defaults?.working_rights ?? "any";
                const checked = opt.value === "needs_sponsorship"
                  ? current === "needs_sponsorship"
                  : current !== "needs_sponsorship"; // 'any' OR legacy 'pr_citizen'
                return (
                  <label key={opt.value} className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="radio"
                      name="working_rights"
                      value={opt.value}
                      defaultChecked={checked}
                      className="mt-0.5 w-4 h-4 accent-[var(--brand)] cursor-pointer shrink-0"
                    />
                    <span>
                      <span className="block text-[13px] font-medium text-text">{opt.label}</span>
                      <span className="block text-[11px] text-text-2 leading-snug">{opt.desc}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="border-t border-border" />

          {/* Title must include — unified (writes to must_include_phrases) */}
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">
              Title must include any of <span className="font-normal text-text-2">(comma-separated)</span>
              <Hint text="Keeps a job only if its title contains at least one of these. Also runs a rescue check on the first 500 chars of the description so legit variants like 'Business Analyst (Data & Reporting)' aren't dropped." />
            </label>
            <input
              name="must_include_phrases"
              defaultValue={defaults?.must_include_phrases?.join(", ")}
              placeholder="analyst, business analyst, data analyst"
              className="field"
            />
            <p className="text-[11px] text-text-2 mt-1">
              Leave empty to keep every title and rely on your search keywords above.
            </p>
          </div>

          {/* Exclude — title */}
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">
              Title must NOT contain <span className="font-normal text-text-2">(comma-separated)</span>
              <Hint text="Drops any job whose title contains one of these. Great for stripping seniority levels (senior, lead, principal) or adjacent roles." />
            </label>
            <input
              name="exclude_title_keywords"
              defaultValue={defaults?.exclude_title_keywords?.join(", ")}
              placeholder="senior, lead, principal"
              className="field"
            />
          </div>

          {/* Exclude — description */}
          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">
              Description must NOT contain <span className="font-normal text-text-2">(comma-separated)</span>
            </label>
            <input
              name="adzuna_exclude_keywords"
              defaultValue={defaults?.adzuna_exclude_keywords}
              placeholder="unpaid, volunteer, internship"
              className="field"
            />
          </div>
        </div>
      </section>

      {/* Sources moved to Admin → Integrations (global, all users). See migration 063. */}

      {/* ───── 4. Schedule ──────────────────────────────────────────── */}
      <section>
        <SectionHeader step={4} title="Schedule" />
        <div className="space-y-4 rounded-md border border-border bg-[var(--surface-2)] p-4">

          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">
              Initial fetch window <span className="font-normal text-text-2">(first run only)</span>
              <Hint text="Only applies to the first run. Auto-runs after that fetch only what's new since the previous run (+1 day buffer)." />
            </label>
            <div className="select-chevron-wrap">
              <select
                name="adzuna_max_days_old"
                defaultValue={defaults?.adzuna_max_days_old ?? 14}
                className="field select-chevron"
              >
                <option value="1">Past 1 day</option>
                <option value="2">Past 2 days</option>
                <option value="3">Past 3 days</option>
                <option value="7">Past 7 days</option>
                <option value="14">Past 14 days (recommended)</option>
                <option value="21">Past 21 days</option>
                <option value="28">Past 28 days</option>
              </select>
              <ChevronDown className="h-4 w-4 text-text-2" />
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-semibold text-text mb-2">Mode</label>
            <div className="flex flex-wrap gap-5">
              {[
                { value: "manual", label: "Manual run only" },
                { value: "auto",   label: "Auto-run" },
              ].map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 text-[13px] font-medium cursor-pointer">
                  <input
                    type="radio"
                    name="run_mode"
                    value={opt.value}
                    checked={runMode === opt.value}
                    onChange={() => setRunMode(opt.value as "manual" | "auto")}
                    className="w-4 h-4 accent-[var(--brand)] cursor-pointer"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
            {runMode === "auto" && (
              <div className="flex items-center gap-3 mt-3">
                <span className="text-[12px] text-text-2">Every</span>
                <input
                  type="number"
                  name="auto_days"
                  min="1"
                  max="30"
                  defaultValue={defaultDays}
                  className="field text-center w-20"
                />
                <span className="text-[12px] text-text-2">days</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ───── 5. Automation pipeline ───────────────────────────────── */}
      <section>
        <SectionHeader
          step={5}
          title="Automation pipeline"
          subtitle="What happens after a scrape: tailor a CV → send the application."
        />

        <div className="flex items-stretch gap-2 mb-4 text-[11px]">
          <FunnelChip label="Scrape" status="always" detail={runMode === "auto" ? `every ${defaultDays}d` : "manual"} />
          <FunnelArrow />
          <FunnelChip label="Tailor" status={tailorMode === "auto" ? "on" : "off"} detail={tailorMode === "auto" ? "ATS ≥ 60" : "off"} />
          <FunnelArrow />
          <FunnelChip label="Send"   status={sendActive ? "on" : "off"} detail={sendDetail} />
        </div>

        <div className="space-y-4 rounded-md border border-border bg-[var(--surface-2)] p-4">

          {/* Tailor stage — directly maps to automation_enabled */}
          <div>
            <p className="text-[12px] font-semibold text-text mb-2">Tailor — auto-generate tailored CV + cover letter</p>
            <div className="flex flex-col gap-1.5">
              {[
                { value: "off",  label: "Off",  desc: "Only runs when you click Analyze manually." },
                { value: "auto", label: "Auto", desc: "Runs after every scrape. Uses global ATS gates 60 (tailor) / 70 (cover letter)." },
              ].map((opt) => (
                <label key={opt.value} className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="radio"
                    name="_tailor_mode_ui"
                    checked={tailorMode === opt.value}
                    onChange={() => setAutomationOn(opt.value === "auto")}
                    className="mt-0.5 w-4 h-4 accent-[var(--brand)] cursor-pointer shrink-0"
                  />
                  <span>
                    <span className="block text-[12px] font-medium text-text">{opt.label}</span>
                    <span className="block text-[11px] text-text-2 leading-snug">{opt.desc}</span>
                  </span>
                </label>
              ))}
            </div>
            {tailorMode === "auto" && (
              <p className="mt-2 text-[11px] text-text-2 leading-relaxed">
                ATS gates are global: <strong>60</strong> to tailor · <strong>70</strong> to auto-write a cover letter.
              </p>
            )}
            {/* The real field — extractAutomationFields checks for "on" */}
            {automationOn && <input type="hidden" name="automation_enabled" value="on" />}
          </div>

          <div className="border-t border-border" />

          {/* Send stage */}
          <div>
            <p className="text-[12px] font-semibold text-text mb-2">Send</p>
            <div className="flex flex-col gap-1.5">
              {[
                { value: "never",        label: "Never auto-send",          desc: "Drafts generated; you click Send manually." },
                { value: "after_review", label: "Auto-send after I verify", desc: "Drafts wait in the outbox until you click Verify." },
                { value: "auto",         label: "Auto-send without review", desc: "Drafts go straight to send. Use with caution." },
              ].map((opt) => (
                <label key={opt.value} className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="radio"
                    name="auto_send_emails"
                    value={opt.value}
                    checked={sendMode === opt.value}
                    onChange={() => setSendMode(opt.value as "never" | "after_review" | "auto")}
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
        </div>
      </section>

      {/* ───── Submit ───────────────────────────────────────────────── */}
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

// ─── helpers ───────────────────────────────────────────────────────────

function FunnelChip({ label, status, detail }: { label: string; status: "always" | "on" | "off"; detail: string }) {
  const isOff = status === "off";
  return (
    <div
      className={`flex-1 rounded-md border px-3 py-2 ${
        isOff
          ? "border-border bg-[var(--surface-2)] text-text-3"
          : "border-[var(--brand)]/40 bg-[#DDF4FF] text-text"
      }`}
    >
      <p className="text-[12px] font-semibold leading-none">{label}</p>
      <p className="text-[10px] mt-1 leading-none">{detail}</p>
    </div>
  );
}

function FunnelArrow() {
  return (
    <div className="flex items-center text-text-3 text-[14px]">→</div>
  );
}
