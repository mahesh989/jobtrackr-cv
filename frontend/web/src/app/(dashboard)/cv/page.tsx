import { createClient }       from "@/lib/supabase/server";
import { createAdminClient }  from "@/lib/supabase/admin";
import { redirect }           from "next/navigation";
import { LibraryClient, ProfileDetailsProvider, VerticalsSection } from "@/features/cv";
import { ensureSomeoneActive } from "@/lib/cv/ensureActive";
import { resolveSkillLabels, type RoleFamily } from "@/lib/cv/skillLabels";
import type { ContactDetails } from "@/lib/types";

export const metadata = { title: "CVs — JobTrackr" };

export default async function CvsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  await ensureSomeoneActive(admin, user.id);

  const [cvsExt, prefsRes] = await Promise.all([
    admin
      .from("cv_versions")
      .select("id, label, pdf_storage_path, is_active, categorised_skills, created_at, structured_cv_status, structured_cv")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    admin.from("user_preferences").select("contact_details").eq("user_id", user.id).maybeSingle(),
  ]);

  let cvs = cvsExt.data as Array<Record<string, unknown>> | null;
  if (cvsExt.error && /structured_cv_status|structured_cv|column/i.test(cvsExt.error.message)) {
    const fallback = await admin
      .from("cv_versions")
      .select("id, label, pdf_storage_path, is_active, categorised_skills, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    cvs = fallback.data as Array<Record<string, unknown>> | null;
  }

  const contactDetails = (prefsRes.data?.contact_details ?? {}) as ContactDetails;
  const roleFamilies   = ((contactDetails as { role_families?: RoleFamily[] }).role_families) ?? [];
  const skillLabels    = resolveSkillLabels(roleFamilies);

  const cvList = (cvs ?? []) as Array<{ id: string; is_active: boolean }>;
  const activeCv = cvList.find((c) => c.is_active) ?? cvList[0] ?? null;

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">CVs</h1>
          <p className="page-subtitle">
            Upload or build a CV from scratch, then set one active. The active CV is what the AI tailors for each job.
          </p>
        </div>

        <ProfileDetailsProvider initial={contactDetails} activeCvId={activeCv?.id ?? null}>
          <VerticalsSection />

          <div className="pt-2">
            <h2 className="text-title font-semibold text-text">Your CVs</h2>
            <p className="text-label text-text-3 mt-0.5 mb-3">
              Upload or build a CV from scratch, then set one active. The active CV is what the
              AI tailors for each job.
            </p>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            <LibraryClient initial={(cvs ?? []) as any} skillLabels={skillLabels} />
          </div>
        </ProfileDetailsProvider>
      </div>
    </div>
  );
}
