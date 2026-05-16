import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect }          from "next/navigation";
import { CvLibraryClient }   from "@/components/cv/CvLibraryClient";

export const metadata = { title: "CV library — JobTrackr" };

export default async function CvPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();
  const { data: cvs } = await admin
    .from("cv_versions")
    .select("id, label, pdf_storage_path, is_active, categorised_skills, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">My CVs</h1>
          <p className="page-subtitle">
            Upload and manage your CV versions. Set one as active for analyses.
          </p>
        </div>
        <CvLibraryClient initial={cvs ?? []} />
      </div>
    </div>
  );
}
