import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect }          from "next/navigation";
import { CvLibraryClient }   from "@/components/cv/CvLibraryClient";
import { ReferencesSection, type ReferencesData, type Referee } from "@/components/cv/ReferencesSection";

export const metadata = { title: "CV library — JobTrackr" };

export default async function CvPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  // Try the full select first; fall back to legacy (without structured_cv_status
  // / structured_cv) when migration 058 hasn't been applied yet so the page
  // still renders. Eager-loading structured_cv lets the inline review form
  // open instantly without a round-trip — typical CV JSON is small.
  const cvsExt = await admin
    .from("cv_versions")
    .select("id, label, pdf_storage_path, is_active, categorised_skills, extracted_references, created_at, structured_cv_status, structured_cv")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  let cvs = cvsExt.data as Array<Record<string, unknown>> | null;
  if (cvsExt.error && /structured_cv_status|structured_cv|column/i.test(cvsExt.error.message)) {
    const fallback = await admin
      .from("cv_versions")
      .select("id, label, pdf_storage_path, is_active, categorised_skills, extracted_references, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    cvs = fallback.data as Array<Record<string, unknown>> | null;
  }
  const { data: prefs } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();

  const contactDetails = (prefs?.contact_details ?? {}) as Record<string, unknown>;
  const referencesData = (contactDetails.references ?? null) as ReferencesData | null;

  // Find the active CV — that's the one the extract button works against.
  // Falls back to the most recent CV if no active flag is set.
  type CvWithRefs = {
    id:                   string;
    is_active:            boolean;
    extracted_references: Referee[] | null;
  };
  const cvList = (cvs ?? []) as Array<CvWithRefs & Record<string, unknown>>;
  const activeCv = cvList.find((c) => c.is_active) ?? cvList[0] ?? null;

  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-10">
        <div>
          <h1 className="page-title text-text">My CVs</h1>
          <p className="page-subtitle">
            Upload and manage your CV versions. Set one as active for analyses.
          </p>
        </div>

        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <CvLibraryClient initial={(cvs ?? []) as any} />

        <details className="group rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:shadow-sm hover:border-[var(--border)] transition-all overflow-hidden">
          <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-4 hover:bg-[var(--surface-2)]/30 transition-colors">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-text">References</span>
                <span className="text-[11px] text-text-3 px-1.5 py-0.5 rounded-full bg-[var(--surface-2)]/60">
                  Profile setting
                </span>
              </div>
              <p className="mt-1 text-[12px] text-text-3">
                Manage who employers can contact and how they appear on your CV.
              </p>
            </div>
            <span
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--brand)]/40 bg-[var(--brand)]/10 px-3 py-1.5 text-[12px] font-medium text-[var(--brand)]"
              aria-hidden="true"
            >
              <svg className="h-3.5 w-3.5 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
              <span className="group-open:hidden">Expand</span>
              <span className="hidden group-open:inline">Collapse</span>
            </span>
          </summary>
          <div className="border-t border-[var(--border)] bg-[var(--surface-2)]/20 px-4 py-5 sm:px-6">
            <ReferencesSection
              initial={referencesData}
              contactDetails={contactDetails}
              activeCvId={activeCv?.id ?? null}
              extractedReferences={activeCv?.extracted_references ?? null}
            />
          </div>
        </details>
      </div>
    </div>
  );
}
