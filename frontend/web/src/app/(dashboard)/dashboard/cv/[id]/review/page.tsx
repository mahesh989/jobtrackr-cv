import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect, notFound } from "next/navigation";
import { CvReviewClient }    from "@/components/cv/CvReviewClient";
import { STRUCTURED_CV_VERSION, type StructuredCv } from "@/lib/cvBackend";
import { structurizeAndPersist }   from "@/lib/cv/structurizeAndCategorise";

export const metadata = { title: "Review CV — JobTrackr" };

export default async function CvReviewPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();
  let { data: cv } = await admin
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

  // Silent stale-version refresh. When the stored `_version` is below the
  // current parser logic, re-run structurize + categorise from the saved
  // `cv_text`. User sees a one-time ~3s delay on the first open after a
  // parser bump — no UI button, no confirmation needed (their edits are
  // safe because stale rows have not been hand-edited; the same field is
  // overwritten on every PATCH save).
  const storedVersion = (cv.structured_cv as { _version?: number })._version ?? 0;
  if (storedVersion < STRUCTURED_CV_VERSION) {
    const r = await structurizeAndPersist(user.id, id);
    if (r.ok) {
      const refetched = await admin
        .from("cv_versions")
        .select("id, label, structured_cv, structured_cv_status, cv_text")
        .eq("id", id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (refetched.data) cv = refetched.data;
    } else {
      // Non-fatal — fall through with the stale data. Logged for visibility.
      console.warn(`[cv review] stale-version refresh failed for ${id}:`, r.error);
    }
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
