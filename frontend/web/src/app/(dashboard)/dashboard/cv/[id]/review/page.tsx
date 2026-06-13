import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect, notFound } from "next/navigation";
import { CvReviewClient }    from "@/components/cv/CvReviewClient";
import type { StructuredCv } from "@/lib/cvBackend";

export const metadata = { title: "Review CV — JobTrackr" };

export default async function CvReviewPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();
  const { data: cv } = await admin
    .from("cv_versions")
    .select("id, label, structured_cv, structured_cv_status, cv_text")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!cv) notFound();

  // If structurization never ran (legacy CV / failed upload), there's no
  // structured data to review — bounce to the library.
  if (!cv.structured_cv) {
    redirect("/dashboard/cv");
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <CvReviewClient
        cvId={cv.id as string}
        label={(cv.label as string) ?? "Your CV"}
        initialStructuredCv={cv.structured_cv as unknown as StructuredCv}
        initialStatus={(cv.structured_cv_status as string | null) ?? "parsed"}
      />
    </div>
  );
}
