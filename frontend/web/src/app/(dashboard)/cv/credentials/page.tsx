import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { ensureSomeoneActive } from "@/lib/cv/ensureActive";
import { suggestCredentialKeys } from "@/lib/cv/certSuggestions";
import { ProfileDetailsProvider, CredentialsSection, AutoSaveBadge } from "@/features/cv/profile";
import type { ContactDetails } from "@/lib/types";

export const metadata = { title: "Credentials — JobTrackr" };

export default async function CredentialsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  await ensureSomeoneActive(admin, user.id);

  const [cvsExt, prefsRes] = await Promise.all([
    admin
      .from("cv_versions")
      .select("id, is_active, structured_cv")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    admin.from("user_preferences").select("contact_details").eq("user_id", user.id).maybeSingle(),
  ]);

  const cvList = (cvsExt.data ?? []) as Array<{ id: string; is_active: boolean; structured_cv?: { certifications?: { name?: string }[] } | null }>;
  const activeCv = cvList.find((c) => c.is_active) ?? cvList[0] ?? null;

  const contactDetails = (prefsRes.data?.contact_details ?? {}) as ContactDetails;
  const suggestedCredentialKeys = suggestCredentialKeys(activeCv?.structured_cv?.certifications ?? []);

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">Credentials</h1>
          <p className="page-subtitle">
            Certifications, licences, and credentials detected on your CV.
          </p>
        </div>

        <ProfileDetailsProvider initial={contactDetails} activeCvId={activeCv?.id ?? null}>
          <CredentialsSection suggestedKeys={suggestedCredentialKeys} />
          <AutoSaveBadge />
        </ProfileDetailsProvider>
      </div>
    </div>
  );
}
