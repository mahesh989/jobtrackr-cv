"use client";

/**
 * Beta preview of the redesigned ProfileForm. Pure UI — does NOT submit
 * to the server. Lives at /dashboard/beta/profile-form so the team can
 * click through the new layout before we replace the production form.
 *
 * Redesign goals (vs ProfileForm.tsx):
 *   1. One unified "title-must-include" field (rescue toggle inline) —
 *      retires the confusing trio of keywords / title-must-contain /
 *      smart-filter must-include / strict-role-match.
 *   2. Per-source method settings nested under each source toggle.
 *   3. Working rights collapsed to 2 options (PR/Citizen + "show all"
 *      were functionally identical).
 *   4. Single "Automation pipeline" panel rendered as a Scrape → Tailor
 *      → Send funnel.
 *   5. Long helper text moved behind (?) tooltips.
 */

import { useState } from "react";

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

export function ProfileFormBetaClient() {
  // ---- state (preview-only; nothing is submitted) ------------------------
  const [name, setName] = useState("Data Analyst — Sydney");
  const [keywords, setKeywords] = useState("Data Analyst, BI Analyst, Analytics Engineer");
  const [location, setLocation] = useState("Sydney NSW");
  const [salaryMin, setSalaryMin] = useState("");
  const [salaryMax, setSalaryMax] = useState("");

  const [visa, setVisa] = useState<"any" | "needs_sponsorship">("any");
  const [titleMustInclude, setTitleMustInclude] = useState("analyst");
  const [titleRescue, setTitleRescue] = useState(true);
  const [excludeTitle, setExcludeTitle] = useState("senior, lead, principal");
  const [excludeDesc, setExcludeDesc] = useState("");

  const [sources, setSources] = useState<Record<SourceId, boolean>>({
    adzuna: true, seek: true, careerjet: true, greenhouse: true, lever: true,
  });
  const [adzunaMethod, setAdzunaMethod] = useState<"api" | "direct">("api");
  const [seekMethod, setSeekMethod] = useState<"direct" | "actor">("direct");

  const [initialWindow, setInitialWindow] = useState("14");
  const [scrapeMode, setScrapeMode] = useState<"manual" | "auto">("manual");
  const [autoDays, setAutoDays] = useState("2");

  const [tailorMode, setTailorMode] = useState<"off" | "auto">("off");
  const [sendMode, setSendMode] = useState<"never" | "after_review" | "auto">("never");

  function toggleSource(id: SourceId) {
    setSources((s) => ({ ...s, [id]: !s[id] }));
  }

  // Stage chip helpers for the automation funnel
  const tailorActive = tailorMode === "auto";
  const sendActive = sendMode !== "never";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    alert("Preview-only form — nothing was saved.\n\nThis page is a UX preview of the redesigned profile editor. The real save action will be wired up once the design is approved.");
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">

      {/* Beta banner */}
      <div className="mb-5 flex items-start gap-3 p-3 rounded-md border border-[var(--brand)]/30 bg-[#DDF4FF] text-[12px] text-text">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-[var(--brand)] text-white text-[10px] font-bold shrink-0">β</span>
        <div>
          <p className="font-semibold">ProfileForm redesign — preview only</p>
          <p className="text-text-2 mt-0.5 leading-relaxed">
            Pure UI mock. Nothing you change here is saved. Clicking <em>Save</em> only shows a confirmation. Once we approve this layout it&apos;ll replace the editor at <code className="text-[11px]">/dashboard/profiles/[id]</code>.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">

        {/* ───── 1. Identity ──────────────────────────────────────────── */}
        <section>
          <SectionHeader step={1} title="Identity" />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Profile name"
            className="field"
            required
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
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                rows={2}
                className="field resize-none"
                placeholder="Data Analyst, BI Analyst, Analytics Engineer"
              />
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-text mb-1.5">Location</label>
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="field"
                placeholder="Sydney NSW"
              />
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-text mb-1.5">
                Salary range (optional)
                <Hint text="Passed to sources that support salary filtering. Not all sources provide salary data." />
              </label>
              <div className="flex items-center gap-3">
                <input type="number" value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} placeholder="Min AU$" className="field" />
                <span className="text-text-3 shrink-0">–</span>
                <input type="number" value={salaryMax} onChange={(e) => setSalaryMax(e.target.value)} placeholder="Max AU$" className="field" />
              </div>
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

            {/* Working rights — collapsed to 2 options */}
            <div>
              <label className="block text-[12px] font-semibold text-text mb-2">Working rights</label>
              <div className="flex flex-col gap-2">
                {[
                  { value: "any", label: "I can apply anywhere", desc: "Show all jobs. Visa status shown as a label per job." },
                  { value: "needs_sponsorship", label: "I need visa sponsorship", desc: 'Drop jobs that say "no sponsorship" or "citizens/PR only". Unmentioned jobs kept — most employers will sponsor.' },
                ].map((opt) => (
                  <label key={opt.value} className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="radio"
                      name="visa"
                      checked={visa === opt.value}
                      onChange={() => setVisa(opt.value as "any" | "needs_sponsorship")}
                      className="mt-0.5 w-4 h-4 accent-[var(--brand)] cursor-pointer shrink-0"
                    />
                    <span>
                      <span className="block text-[13px] font-medium text-text">{opt.label}</span>
                      <span className="block text-[11px] text-text-2 leading-snug">{opt.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="border-t border-border" />

            {/* Title must include — unified */}
            <div>
              <label className="block text-[12px] font-semibold text-text mb-1.5">
                Title must include any of <span className="font-normal text-text-2">(comma-separated)</span>
                <Hint text="Keeps a job only if its title contains at least one of these. Replaces the old 'Title must contain' + 'Smart filter must include' pair." />
              </label>
              <input
                value={titleMustInclude}
                onChange={(e) => setTitleMustInclude(e.target.value)}
                placeholder="analyst, business analyst, data analyst"
                className="field"
              />
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={titleRescue}
                  onChange={(e) => setTitleRescue(e.target.checked)}
                  className="w-3.5 h-3.5 accent-[var(--brand)] cursor-pointer"
                />
                <span className="text-[11px] text-text-2">
                  Also check the first 500 chars of the description (rescues titles like &quot;Business Analyst (Data &amp; Reporting)&quot;).
                </span>
              </label>
            </div>

            {/* Exclude — title */}
            <div>
              <label className="block text-[12px] font-semibold text-text mb-1.5">
                Title must NOT contain <span className="font-normal text-text-2">(comma-separated)</span>
              </label>
              <input
                value={excludeTitle}
                onChange={(e) => setExcludeTitle(e.target.value)}
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
                value={excludeDesc}
                onChange={(e) => setExcludeDesc(e.target.value)}
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

            {/* Adzuna */}
            <SourceRow
              id="adzuna"
              label="Adzuna"
              tag="Aggregator"
              enabled={sources.adzuna}
              onToggle={() => toggleSource("adzuna")}
            >
              <RadioRow
                value={adzunaMethod}
                onChange={(v) => setAdzunaMethod(v as "api" | "direct")}
                options={[
                  { value: "api",    label: "API",    desc: "Fast. JD truncated to ~600 chars." },
                  { value: "direct", label: "Direct", desc: "Slower (+2–5 min). Full ~8k char JDs, better visa & smart-filter signal." },
                ]}
                name="adzuna_method"
              />
            </SourceRow>

            {/* SEEK */}
            <SourceRow
              id="seek"
              label="SEEK"
              tag="Aggregator"
              enabled={sources.seek}
              onToggle={() => toggleSource("seek")}
            >
              <RadioRow
                value={seekMethod}
                onChange={(v) => setSeekMethod(v as "direct" | "actor")}
                options={[
                  { value: "direct", label: "Direct",      desc: "Free. Scrapes SEEK directly." },
                  { value: "actor",  label: "Apify actor", desc: "~$0.42/run. More reliable depth via your Apify integration." },
                ]}
                name="seek_method"
              />
            </SourceRow>

            <SourceRow id="careerjet"  label="Careerjet"  tag="Aggregator" enabled={sources.careerjet}  onToggle={() => toggleSource("careerjet")}  />
            <SourceRow id="greenhouse" label="Greenhouse" tag="ATS board"  enabled={sources.greenhouse} onToggle={() => toggleSource("greenhouse")} />
            <SourceRow id="lever"      label="Lever"      tag="ATS board"  enabled={sources.lever}      onToggle={() => toggleSource("lever")}      />
          </div>
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
              <select value={initialWindow} onChange={(e) => setInitialWindow(e.target.value)} className="field">
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
                      checked={scrapeMode === opt.value}
                      onChange={() => setScrapeMode(opt.value as "manual" | "auto")}
                      className="w-4 h-4 accent-[var(--brand)] cursor-pointer"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
              {scrapeMode === "auto" && (
                <div className="flex items-center gap-3 mt-3">
                  <span className="text-[12px] text-text-2">Every</span>
                  <input
                    type="number"
                    min="1"
                    max="30"
                    value={autoDays}
                    onChange={(e) => setAutoDays(e.target.value)}
                    className="field text-center w-20"
                  />
                  <span className="text-[12px] text-text-2">days</span>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ───── 6. Automation pipeline — funnel ──────────────────────── */}
        <section>
          <SectionHeader
            step={6}
            title="Automation pipeline"
            subtitle="What happens after a scrape: tailor a CV → send the application."
          />

          {/* Funnel chips */}
          <div className="flex items-stretch gap-2 mb-4 text-[11px]">
            <FunnelChip label="Scrape" status="always" detail={scrapeMode === "auto" ? `every ${autoDays}d` : "manual"} />
            <FunnelArrow />
            <FunnelChip label="Tailor" status={tailorActive ? "on" : "off"} detail={tailorActive ? "ATS ≥ 60" : "off"} />
            <FunnelArrow />
            <FunnelChip label="Send"   status={sendActive   ? "on" : "off"} detail={sendMode === "auto" ? "no review" : sendMode === "after_review" ? "after verify" : "off"} />
          </div>

          <div className="space-y-4 rounded-md border border-border bg-[var(--surface-2)] p-4">

            {/* Tailor stage */}
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
                      checked={tailorMode === opt.value}
                      onChange={() => setTailorMode(opt.value as "off" | "auto")}
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
                  ATS gates are global: <strong>60</strong> to tailor · <strong>70</strong> to auto-write a cover letter.{" "}
                  <a href="/dashboard/settings" className="text-[var(--brand)] underline">Edit in Settings</a>.
                </p>
              )}
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
          <button type="submit" className="gh-btn gh-btn-blue text-[13px] py-2 px-5">
            Save changes (preview)
          </button>
          <a href="/dashboard/profiles" className="gh-btn text-[13px] py-2 px-5">
            Back
          </a>
        </div>
      </form>
    </div>
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
  value, onChange, options, name,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; desc: string }[];
  name: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((opt) => (
        <label key={opt.value} className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name={name}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
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
