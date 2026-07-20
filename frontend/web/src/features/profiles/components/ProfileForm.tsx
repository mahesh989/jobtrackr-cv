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
import Link from "next/link";
import { Button, Input, Select, Textarea } from "@/components/ui";
import { createProfile, updateProfile } from "@/lib/actions";
import { LocationAutocomplete } from "@/features/profiles/components/LocationAutocomplete";
import { SETTING_CATEGORY_META } from "@/lib/settingCategories";

interface Props {
  mode: "create" | "edit";
  profileId?: string;
  /** Show the work-setting filter — only for healthcare/nursing CV users
   *  (My CV role_families includes "nursing"). Off for everyone else. */
  showWorkSetting?: boolean;
  defaults?: {
    name: string;
    keywords: string[];
    location: string;
    visa_filter_mode: string;
    working_rights?: string;
    setting_filter?: string[];
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

function SectionHeader({ step, title, subtitle }: { step: number; title: string; subtitle?: string }) {
  return (
    <div className="flex items-baseline gap-3 mb-3">
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--brand)] text-[var(--brand-fg)] text-[11px] font-semibold shrink-0">
        {step}
      </span>
      <div>
        <h3 className="text-[14px] font-semibold text-text leading-none">{title}</h3>
        {subtitle && <p className="text-[11px] text-text-2 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

export function ProfileForm({ mode, profileId, defaults, showWorkSetting = false }: Props) {
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
        <Input
          label="Profile name"
          name="name"
          required
          defaultValue={defaults?.name}
          placeholder="e.g. Data Analyst — Sydney"
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
            <Textarea
              label="Keywords (comma-separated)"
              name="keywords"
              required
              rows={2}
              defaultValue={defaults?.keywords.join(", ")}
              placeholder="Data Analyst, BI Analyst, Analytics Engineer"
              className="resize-none"
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
            <Input
              label="Your address (optional — used for distance display)"
              name="home_address"
              defaultValue={defaults?.home_address ?? ""}
              placeholder="e.g. 123 Pitt Street, Sydney NSW 2000"
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

          {/* Working rights lives in My CV (visa status) — the single source of
              truth. The eligibility matrix flags/drops per that setting; the
              old per-profile radio contradicted it and was removed. */}

          {/* Work setting (Migration 078) — only for healthcare/nursing CV users
              (My CV role_families includes "nursing"). Tick the settings you
              want; leave all unticked to show every setting. */}
          {showWorkSetting && (
            <>
              <div className="border-t border-border" />
              <div>
                <label className="block text-[12px] font-semibold text-text mb-1.5">
                  Work setting
                </label>
                <div className="flex flex-col gap-2">
                  {SETTING_CATEGORY_META.map((opt) => {
                    const checked = defaults?.setting_filter?.includes(opt.key) ?? false;
                    return (
                      <label key={opt.key} className="flex items-start gap-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          name="setting_filter"
                          value={opt.key}
                          defaultChecked={checked}
                          className="mt-0.5 w-4 h-4 accent-[var(--brand)] cursor-pointer shrink-0"
                        />
                        <span>
                          <span className="block text-[13px] font-medium text-text">{opt.label}</span>
                          <span className="block text-[11px] text-text-2 leading-snug">{opt.description}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-[11px] text-text-2 mt-1.5">
                  Leave all unticked to show jobs in every setting.
                </p>
              </div>
            </>
          )}

          <div className="border-t border-border" />

          {/* Title must include — unified (writes to must_include_phrases) */}
          <div>
            <Input
              label="Title must include any of (comma-separated)"
              name="must_include_phrases"
              defaultValue={defaults?.must_include_phrases?.join(", ")}
              placeholder="analyst, business analyst, data analyst"
            />
            <p className="text-[11px] text-text-2 mt-1">
              Leave empty to keep every title and rely on your search keywords above.
            </p>
          </div>

          {/* Exclude — title */}
          <div>
            <Input
              label="Title must NOT contain (comma-separated)"
              name="exclude_title_keywords"
              defaultValue={defaults?.exclude_title_keywords?.join(", ")}
              placeholder="senior, lead, principal"
            />
          </div>

          {/* Exclude — description */}
          <div>
            <Input
              label="Description must NOT contain (comma-separated)"
              name="adzuna_exclude_keywords"
              defaultValue={defaults?.adzuna_exclude_keywords}
              placeholder="unpaid, volunteer, internship"
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
            <Select
              label="Initial fetch window (first run only)"
              name="adzuna_max_days_old"
              defaultValue={defaults?.adzuna_max_days_old ?? 14}
            >
              <option value="1">Past 1 day</option>
              <option value="2">Past 2 days</option>
              <option value="3">Past 3 days</option>
              <option value="7">Past 7 days</option>
              <option value="14">Past 14 days (recommended)</option>
              <option value="21">Past 21 days</option>
              <option value="28">Past 28 days</option>
            </Select>
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
                {/* ponytail: inline input — Input's stacked label layout breaks inline sentence placement */}
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
        <Button
          variant="blue"
          type="submit"
          disabled={pending}
          className="py-2 px-5"
        >
          {pending ? "Saving…" : mode === "create" ? "Create profile" : "Save changes"}
        </Button>
        <Link
          href="/dashboard"
          className="inline-flex"
        >
          <Button className="py-2 px-5">
            Cancel
          </Button>
        </Link>
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
