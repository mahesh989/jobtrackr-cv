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

type SourceId = "adzuna" | "seek" | "careerjet" | "greenhouse" | "lever";

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

  // Source toggles drive both the source checkboxes and the per-source
  // method blocks (nested under each row when on).
  const initialEnabled: Record<SourceId, boolean> = (() => {
    if (!defaults?.enabled_sources) {
      return { adzuna: true, seek: true, careerjet: true, greenhouse: true, lever: true };
    }
    const set = new Set(defaults.enabled_sources);
    return {
      adzuna:     set.has("adzuna"),
      seek:       set.has("seek"),
      careerjet:  set.has("careerjet"),
      greenhouse: set.has("greenhouse"),
      lever:      set.has("lever"),
    };
  })();
  const [sourcesOn, setSourcesOn] = useState<Record<SourceId, boolean>>(initialEnabled);

  const [sendMode, setSendMode] = useState<"never" | "after_review" | "auto">(
    (defaults?.auto_send_emails as "never" | "after_review" | "auto") ?? "never",
  );

  function toggleSource(id: SourceId) {
    setSourcesOn((s) => ({ ...s, [id]: !s[id] }));
  }

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

      {/* Pass-through hidden inputs for fields the new UI doesn't surface.
          Preserves existing DB values on edit; uses sensible defaults on create. */}
      {(defaults?.target_verticals ?? ["tech", "healthcare", "general"]).map((v) => (
        <input key={`tv-${v}`} type="hidden" name="target_verticals" value={v} />
      ))}
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
              Description must NOT contain <span className="font-normal text-text-2">(space or comma separated)</span>
            </label>
            <input
              name="adzuna_exclude_keywords"
              defaultValue={defaults?.adzuna_exclude_keywords}
              placeholder="unpaid volunteer internship"
              className="field"
            />
          </div>
        </div>
      </section>

      {/* ───── 4. Sources ───────────────────────────────────────────── */}
      <section>
        <SectionHeader
          step={4}
          title="Sources"
          subtitle="Which job boards to scan. Method settings live with each source."
        />
        <div className="rounded-md border border-border bg-[var(--surface-2)] divide-y divide-border">

          <SourceRow
            id="adzuna"
            label="Adzuna"
            tag="Aggregator"
            enabled={sourcesOn.adzuna}
            onToggle={() => toggleSource("adzuna")}
          >
            <RadioRow
              name="adzuna_method"
              defaultValue={defaults?.adzuna_method ?? "api"}
              options={[
                { value: "api",    label: "API",    desc: "Fast. JD truncated to ~600 chars." },
                { value: "direct", label: "Direct", desc: "Slower (+2–5 min). Full ~8k char JDs, better visa & smart-filter signal." },
              ]}
            />
          </SourceRow>

          <SourceRow
            id="seek"
            label="SEEK"
            tag="Aggregator"
            enabled={sourcesOn.seek}
            onToggle={() => toggleSource("seek")}
          >
            <RadioRow
              name="seek_method"
              defaultValue={defaults?.seek_method ?? "direct"}
              options={[
                { value: "direct", label: "Direct",      desc: "Free. Scrapes SEEK directly." },
                { value: "actor",  label: "Apify actor", desc: "~$0.42/run. More reliable depth via your Apify integration." },
              ]}
            />
          </SourceRow>

          <SourceRow id="careerjet"  label="Careerjet"  tag="Aggregator" enabled={sourcesOn.careerjet}  onToggle={() => toggleSource("careerjet")}  />
          <SourceRow id="greenhouse" label="Greenhouse" tag="ATS board"  enabled={sourcesOn.greenhouse} onToggle={() => toggleSource("greenhouse")} />
          <SourceRow id="lever"      label="Lever"      tag="ATS board"  enabled={sourcesOn.lever}      onToggle={() => toggleSource("lever")}      />
        </div>

        {/* Submit one enabled_sources entry per on-source. extractSourceFields
            reads formData.getAll("enabled_sources") and the on-set is exactly
            the contract createProfile/updateProfile expect. */}
        {(Object.keys(sourcesOn) as SourceId[]).map((id) =>
          sourcesOn[id] ? (
            <input key={`hs-${id}`} type="hidden" name="enabled_sources" value={id} />
          ) : null,
        )}
      </section>

      {/* ───── 5. Schedule ──────────────────────────────────────────── */}
      <section>
        <SectionHeader step={5} title="Schedule" />
        <div className="space-y-4 rounded-md border border-border bg-[var(--surface-2)] p-4">

          <div>
            <label className="block text-[12px] font-semibold text-text mb-1.5">
              Initial fetch window <span className="font-normal text-text-2">(first run only)</span>
              <Hint text="Only applies to the first run. Auto-runs after that fetch only what's new since the previous run (+1 day buffer)." />
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

      {/* ───── 6. Automation pipeline ───────────────────────────────── */}
      <section>
        <SectionHeader
          step={6}
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

function SourceRow({
  id, label, tag, enabled, onToggle, children,
}: {
  id: string;
  label: string;
  tag: string;
  enabled: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="p-3">
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={onToggle}
          className="w-4 h-4 accent-[var(--brand)] cursor-pointer"
          aria-label={`Toggle ${label}`}
          data-source={id}
        />
        <span className="text-[13px] font-medium text-text">{label}</span>
        <span className="text-[10px] uppercase tracking-wide text-text-3 font-semibold">{tag}</span>
      </label>
      {enabled && children && (
        <div className="mt-2 ml-7">
          {children}
        </div>
      )}
    </div>
  );
}

function RadioRow({
  name, defaultValue, options,
}: {
  name: string;
  defaultValue: string;
  options: { value: string; label: string; desc: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((opt) => (
        <label key={opt.value} className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name={name}
            value={opt.value}
            defaultChecked={defaultValue === opt.value}
            className="mt-0.5 w-3.5 h-3.5 accent-[var(--brand)] cursor-pointer shrink-0"
          />
          <span>
            <span className="text-[12px] font-medium text-text">{opt.label}</span>
            <span className="text-[11px] text-text-2"> — {opt.desc}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

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
