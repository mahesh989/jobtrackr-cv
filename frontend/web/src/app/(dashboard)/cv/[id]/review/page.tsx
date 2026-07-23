import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect, notFound } from "next/navigation";
import { ReviewClient } from "@/features/cv/library/ReviewClient";
import { STRUCTURED_CV_VERSION, type StructuredCv } from "@/lib/cv/backend";
import { structurizeAndPersist }   from "@/lib/cv/structurizeAndCategorise";
import { resolveSkillLabels, type RoleFamily } from "@/lib/cv/skillLabels";

export const metadata = { title: "Review CV — JobTrackr" };

export default async function CvReviewPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();
  const [{ data: cvData }, { data: prefs }] = await Promise.all([
    admin
      .from("cv_versions")
      .select("id, label, structured_cv, structured_cv_status, cv_text, pdf_storage_path")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle(),
    admin
      .from("user_preferences")
      .select("contact_details")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);
  let cv = cvData;

  if (!cv) notFound();

  const roleFamilies = ((prefs?.contact_details as { role_families?: RoleFamily[] } | null)?.role_families) ?? [];
  const skillLabels = resolveSkillLabels(roleFamilies);

  // If structurization never ran (legacy CV / failed upload), there's no
  // structured data to review — bounce to the library.
  if (!cv.structured_cv) {
    redirect("/cv");
  }

  // A "built in app" CV (pdf_storage_path = built://…) has no source text to
  // parse — it's hand-authored. Drive the builder (create mode) until it's
  // verified, and never run the AI re-structurize against it (that would clobber
  // the user's manual entries).
  const isBuilt = String(cv.pdf_storage_path ?? "").startsWith("built://");

  // Silent stale-version refresh. When the stored `_version` is below the
  // current parser logic, re-run structurize + categorise from the saved
  // `cv_text`. User sees a one-time ~3s delay on the first open after a
  // parser bump — no UI button, no confirmation needed (their edits are
  // safe because stale rows have not been hand-edited; the same field is
  // overwritten on every PATCH save).
  const storedVersion = (cv.structured_cv as { _version?: number })._version ?? 0;
  if (!isBuilt && storedVersion < STRUCTURED_CV_VERSION) {
    const r = await structurizeAndPersist(user.id, id);
    if (r.ok) {
      const refetched = await admin
        .from("cv_versions")
        .select("id, label, structured_cv, structured_cv_status, cv_text, pdf_storage_path")
        .eq("id", id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (refetched.data) cv = refetched.data;
    } else {
      // Non-fatal — fall through with the stale data. Logged for visibility.
      console.warn(`[cv review] stale-version refresh failed for ${id}:`, r.error);
    }
  }

  const mode = isBuilt && cv.structured_cv_status !== "verified" ? "create" : "review";

  return (
    <div className="max-w-4xl mx-auto p-6">
      <ReviewClient
        cvId={cv.id as string}
        label={(cv.label as string) ?? "Your CV"}
        initialStructuredCv={cv.structured_cv as unknown as StructuredCv}
        initialStatus={(cv.structured_cv_status as string | null) ?? "parsed"}
        mode={mode}
        skillLabels={skillLabels}
      />
    </div>
  );
}
