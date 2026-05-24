import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ProfileForm } from "@/components/ProfileForm";
import { DeleteProfileButton } from "@/components/DeleteProfileButton";
import { CopyProfileButton } from "@/components/CopyProfileButton";

export default async function EditProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data } = await supabase
    .from("search_profiles")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!data) redirect("/dashboard");
  const profile = data as {
    id: string; name: string; keywords: string[]; location: string;
    visa_filter_mode: string; working_rights: string; schedule_cron: string; is_active: boolean;
    target_verticals: string[];
    adzuna_title_keywords?: string;
    adzuna_exclude_keywords?: string;
    adzuna_salary_min?: number;
    adzuna_salary_max?: number;
    adzuna_contract_type?: string;
    adzuna_hours?: string;
    adzuna_distance_km?: number;
    adzuna_max_days_old?: number;
    exclude_title_keywords?: string[];
    enabled_sources?:          string[] | null;
    seek_method?:              string;
    automation_enabled?:       boolean;
    role_match_strict?:        boolean;
    auto_send_emails?:         string;
    daily_application_limit?:  number;
  };

  return (
    <div className="min-h-full">
      {/* Page header */}
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
              <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <Link href={`/dashboard/profiles/${id}/jobs`} className="hover:text-text transition-colors truncate max-w-[180px]">
                {profile.name}
              </Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <span className="text-text-2">Edit</span>
            </div>
            <h1 className="text-[16px] font-semibold text-text">Edit profile</h1>
          </div>
          <div className="flex items-center gap-2">
            <CopyProfileButton profileId={id} />
            <DeleteProfileButton profileId={id} profileName={profile.name} />
          </div>
        </div>
      </div>

      <div className="px-6 py-5">
        <div className="flex gap-6 items-start">
          {/* Form */}
          <div className="flex-1 min-w-0 max-w-2xl bg-surface border border-border rounded-md p-5 anim-in">
            <ProfileForm
              mode="edit"
              profileId={profile.id}
              defaults={{
                name: profile.name,
                keywords: profile.keywords,
                location: profile.location,
                visa_filter_mode: profile.visa_filter_mode,
                working_rights: profile.working_rights ?? "any",
                schedule_cron: profile.schedule_cron,
                is_active: profile.is_active,
                target_verticals: profile.target_verticals ?? [],
                adzuna_title_keywords: profile.adzuna_title_keywords,
                adzuna_exclude_keywords: profile.adzuna_exclude_keywords,
                adzuna_salary_min: profile.adzuna_salary_min,
                adzuna_salary_max: profile.adzuna_salary_max,
                adzuna_contract_type: profile.adzuna_contract_type,
                adzuna_hours: profile.adzuna_hours,
                adzuna_distance_km: profile.adzuna_distance_km,
                adzuna_max_days_old: profile.adzuna_max_days_old,
                exclude_title_keywords: profile.exclude_title_keywords,
                enabled_sources:         profile.enabled_sources,
                seek_method:             profile.seek_method,
                automation_enabled:      profile.automation_enabled,
                role_match_strict:       profile.role_match_strict,
                auto_send_emails:        profile.auto_send_emails,
                daily_application_limit: profile.daily_application_limit,
              }}
            />
          </div>

          {/* Tips panel */}
          <div className="w-72 shrink-0 hidden lg:block anim-in anim-delay-1">
            <div className="bg-surface border border-border rounded-md p-4 space-y-4 text-[12px]">
              <p className="text-[11px] font-semibold text-text-2 uppercase tracking-wider">Tips</p>

              <div className="space-y-3">
                <div>
                  <p className="font-semibold text-text mb-0.5">More keywords = more results</p>
                  <p className="text-text-2 leading-relaxed">Each keyword triggers a separate search. Add variations: <em>Data Analyst, Reporting Analyst, BI Analyst</em>.</p>
                </div>
                <div className="border-t border-border pt-3">
                  <p className="font-semibold text-text mb-0.5">Use the title filter wisely</p>
                  <p className="text-text-2 leading-relaxed">Under Adzuna refinements, "Title must contain" narrows to a word that <em>must appear</em> in the job title — great for enforcing role type.</p>
                </div>
                <div className="border-t border-border pt-3">
                  <p className="font-semibold text-text mb-0.5">Initial window vs. auto-run</p>
                  <p className="text-text-2 leading-relaxed">The initial fetch window only applies to the first run. Auto-runs fetch only what's new since the last run — no duplicates.</p>
                </div>
                <div className="border-t border-border pt-3">
                  <p className="font-semibold text-text mb-0.5">Exclude noise upfront</p>
                  <p className="text-text-2 leading-relaxed">Add seniority words to "Exclude from title" — e.g. <em>senior, lead, principal</em> — so you only see roles at the right level.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
