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
  };
}

export function ProfileForm({ mode, profileId, defaults }: Props) {
  const [pending, startTransition] = useTransition();

  const defaultIsActive = defaults?.is_active ?? false;
  const [runMode, setRunMode] = useState<"auto" | "manual">(defaultIsActive ? "auto" : "manual");

  const match = defaults?.schedule_cron?.match(/\*\/(\d+)/);
  const defaultDays = match ? match[1] : "2";

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
        <label className="block text-[12px] font-semibold text-[#1F2328] mb-1.5">Profile name</label>
        <input
          name="name" required
          defaultValue={defaults?.name}
          placeholder="e.g. Data Analyst — Sydney"
          className="field"
        />
      </div>

      {/* Keywords */}
      <div>
        <label className="block text-[12px] font-semibold text-[#1F2328] mb-1.5">
          Keywords <span className="font-normal text-[#656D76]">(comma-separated)</span>
        </label>
        <textarea
          name="keywords" required rows={3}
          defaultValue={defaults?.keywords.join(", ")}
          placeholder="Data Analyst, SQL Analyst, Power BI Analyst, Analytics Engineer"
          className="field resize-none"
        />
        <p className="text-[11px] text-[#656D76] mt-1.5">
          Each keyword is searched <strong>separately</strong> on Adzuna and all other sources — more keywords means broader coverage. Results are then filtered to only keep jobs matching at least one.
        </p>
      </div>

      {/* Location */}
      <div>
        <label className="block text-[12px] font-semibold text-[#1F2328] mb-1.5">Location</label>
        <input
          name="location"
          defaultValue={defaults?.location}
          placeholder="Sydney NSW"
          className="field"
        />
      </div>

      {/* Working rights */}
      <div>
        <label className="block text-[12px] font-semibold text-[#1F2328] mb-1.5">Your working rights</label>
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
                className="mt-0.5 w-4 h-4 accent-[#0969DA] cursor-pointer shrink-0"
              />
              <span>
                <span className="block text-[13px] font-medium text-[#1F2328] group-hover:text-[#0969DA] transition-colors">{opt.label}</span>
                <span className="block text-[11px] text-[#656D76] leading-relaxed mt-0.5">{opt.desc}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Target Verticals */}
      <div>
        <label className="block text-[12px] font-semibold text-[#1F2328] mb-2">
          Target verticals <span className="font-normal text-[#656D76]">(filters which sources are queried)</span>
        </label>
        <div className="flex flex-wrap gap-4">
          {["tech", "healthcare", "general"].map((v) => (
            <label key={v} className="flex items-center gap-2 text-[13px] text-[#1F2328] cursor-pointer capitalize font-medium">
              <input
                type="checkbox" name="target_verticals" value={v}
                defaultChecked={defaults?.target_verticals ? defaults.target_verticals.includes(v) : true}
                className="w-4 h-4 accent-[#0969DA] cursor-pointer"
              />
              {v}
            </label>
          ))}
        </div>
      </div>

      {/* Initial fetch window */}
      <div>
        <label className="block text-[12px] font-semibold text-[#1F2328] mb-1.5">
          Initial fetch window <span className="font-normal text-[#656D76]">(first run only)</span>
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
        <p className="text-[11px] text-[#656D76] mt-1.5">
          How far back to look on the <strong>first</strong> run. After that, each auto-run automatically fetches only jobs posted since the previous run — so there's no redundancy.
        </p>
      </div>

      {/* Automation mode */}
      <div className="bg-[#F6F8FA] border border-[#D0D7DE] rounded-md p-4 space-y-4">
        <div>
          <label className="block text-[12px] font-semibold text-[#1F2328] mb-2">Automation mode</label>
          <div className="flex flex-wrap gap-5">
            {[
              { value: "manual", label: "Manual run only" },
              { value: "auto",   label: "Auto-run enabled" },
            ].map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-[13px] text-[#1F2328] cursor-pointer font-medium">
                <input
                  type="radio" name="run_mode" value={opt.value}
                  checked={runMode === opt.value}
                  onChange={() => setRunMode(opt.value as "auto" | "manual")}
                  className="w-4 h-4 accent-[#0969DA] cursor-pointer"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        {runMode === "auto" && (
          <div className="pt-4 border-t border-[#D0D7DE]">
            <label className="block text-[12px] font-semibold text-[#1F2328] mb-2">Update frequency</label>
            <div className="flex items-center gap-3">
              <span className="text-[13px] text-[#656D76]">Run every</span>
              <input
                type="number" name="auto_days" min="1" max="30"
                defaultValue={defaultDays}
                className="field text-center w-20"
              />
              <span className="text-[13px] text-[#656D76]">days</span>
            </div>
            <p className="text-[11px] text-[#656D76] mt-1.5">The system automatically schedules the optimal time each day.</p>
          </div>
        )}
      </div>

      {/* Smart filters */}
      <details className="bg-[#F6F8FA] border border-[#D0D7DE] rounded-md group [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none text-[13px] font-semibold text-[#1F2328]">
          <span>Smart filters <span className="font-normal text-[#656D76]">(optional — applied to all sources after fetching)</span></span>
          <svg className="w-4 h-4 text-[#656D76] transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
          </svg>
        </summary>

        <div className="px-4 pb-4 pt-3 border-t border-[#D0D7DE] space-y-4">

          {/* How it works banner */}
          <div className="flex gap-2.5 p-3 bg-[#DDF4FF] border border-[#0969DA]/20 rounded text-[11px] text-[#1F2328]">
            <svg className="w-3.5 h-3.5 text-[#0969DA] mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <span>
              Sources fetch jobs broadly by keyword + location. These filters then run on <strong>every source</strong> to clean the results before anything is saved — no matter where the job came from.
            </span>
          </div>

          {/* Title must contain */}
          <div>
            <label className="block text-[12px] font-semibold text-[#1F2328] mb-1.5">
              Title must contain <span className="font-normal text-[#656D76]">(enforced across all sources)</span>
            </label>
            <input name="adzuna_title_keywords" defaultValue={defaults?.adzuna_title_keywords} placeholder="e.g. analyst" className="field" />
            <p className="text-[11px] text-[#656D76] mt-1">
              Any job whose title does <em>not</em> contain this word is dropped. Use it to enforce role type — e.g. <strong>"analyst"</strong> removes project managers, coordinators, and other roles that sneak in through broad keywords.
            </p>
          </div>

          {/* Exclude from title */}
          <div>
            <label className="block text-[12px] font-semibold text-[#1F2328] mb-1.5">
              Exclude from title <span className="font-normal text-[#656D76]">(comma-separated words or phrases)</span>
            </label>
            <input name="exclude_title_keywords" defaultValue={defaults?.exclude_title_keywords?.join(", ")} placeholder="e.g. senior, lead, principal, business analyst, head of" className="field" />
            <p className="text-[11px] text-[#656D76] mt-1">Any job whose title contains one of these is dropped. Great for filtering seniority levels or adjacent roles you don't want.</p>
          </div>

          {/* Exclude from description */}
          <div>
            <label className="block text-[12px] font-semibold text-[#1F2328] mb-1.5">
              Exclude from description <span className="font-normal text-[#656D76]">(space or comma separated)</span>
            </label>
            <input name="adzuna_exclude_keywords" defaultValue={defaults?.adzuna_exclude_keywords} placeholder="e.g. unpaid volunteer internship" className="field" />
            <p className="text-[11px] text-[#656D76] mt-1">Any job whose description contains one of these words is dropped.</p>
          </div>

          {/* Salary range */}
          <div>
            <label className="block text-[12px] font-semibold text-[#1F2328] mb-1.5">
              Salary range hint <span className="font-normal text-[#656D76]">(used where available)</span>
            </label>
            <div className="flex items-center gap-3">
              <input type="number" name="adzuna_salary_min" defaultValue={defaults?.adzuna_salary_min} placeholder="Min AU$" className="field" />
              <span className="text-[#9198A1] shrink-0">–</span>
              <input type="number" name="adzuna_salary_max" defaultValue={defaults?.adzuna_salary_max} placeholder="Max AU$" className="field" />
            </div>
            <p className="text-[11px] text-[#656D76] mt-1">Passed to sources that support salary filtering. Not all sources provide salary data.</p>
          </div>

          {/* Auto-window note */}
          <div className="flex items-start gap-2 p-3 bg-[#F6F8FA] border border-[#D0D7DE] rounded text-[11px] text-[#656D76]">
            <svg className="w-3.5 h-3.5 text-[#9198A1] mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <span>
              <strong className="text-[#1F2328]">Subsequent runs are auto-windowed.</strong>{" "}
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
