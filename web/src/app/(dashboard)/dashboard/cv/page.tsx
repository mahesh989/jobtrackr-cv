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
    .select("id, label, pdf_storage_path, is_active, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <h1 className="text-[16px] font-semibold text-text">CV library</h1>
        <p className="text-[12px] text-text-3 mt-0.5">
          Upload your CVs as PDF or DOCX. Set one as active — that is the CV the
          analyser will tailor when you click <strong>Analyze</strong> on a job.
        </p>
      </div>

      <div className="px-6 py-6">
        <CvLibraryClient initial={cvs ?? []} />
      </div>
    </div>
  );
}
