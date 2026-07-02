import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ProfileForm } from "@/components/ProfileForm";

export default async function NewProfilePage() {
  // Work-setting filter is only relevant to healthcare/nursing users — gate the
  // ProfileForm section on the user's My CV role family (contact_details).
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  let showWorkSetting = false;
  if (user) {
    const { data: prefRow } = await supabase
      .from("user_preferences")
      .select("contact_details")
      .eq("user_id", user.id)
      .maybeSingle();
    const roleFamilies =
      ((prefRow?.contact_details as { role_families?: string[] } | null)?.role_families) ?? [];
    showWorkSetting = roleFamilies.includes("nursing");
  }

  return (
    <div className="min-h-full">
      {/* Page header */}
      <div className="border-b border-border bg-surface px-4 sm:px-6 py-4">
        <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
          <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <Link href="/dashboard/profiles" className="hover:text-text transition-colors">Job Searches</Link>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
          </svg>
          <span className="text-text-2">New profile</span>
        </div>
        <h1 className="text-[16px] font-semibold text-text">New search profile</h1>
      </div>

      <div className="px-6 py-5">
        <div className="flex gap-6 items-start">
          {/* Form */}
          <div className="flex-1 min-w-0 max-w-2xl bg-surface border border-border rounded-md p-5 anim-in">
            <ProfileForm mode="create" showWorkSetting={showWorkSetting} />
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
                  <p className="text-text-2 leading-relaxed">Under Adzuna refinements, "Title must contain" narrows results to a word that <em>must appear</em> in the job title — great for enforcing role type.</p>
                </div>
                <div className="border-t border-border pt-3">
                  <p className="font-semibold text-text mb-0.5">Initial window vs. auto-run</p>
                  <p className="text-text-2 leading-relaxed">Set a wider initial window (28 days) for a rich first batch. Auto-runs then fetch only what's new since the last run — no duplicates.</p>
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
