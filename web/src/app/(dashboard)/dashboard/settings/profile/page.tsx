import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect }          from "next/navigation";
import { ProfileSettingsClient, type ContactDetails } from "@/components/cv/ProfileSettingsClient";

export const metadata = { title: "Profile — JobTrackr" };

export default async function ProfileSettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();
  const { data } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();

  const initial = (data?.contact_details as ContactDetails | null) ?? null;

  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">Profile</h1>
          <p className="page-subtitle">
            Contact details and portfolio projects used when tailoring your CV.
          </p>
        </div>
        <ProfileSettingsClient initial={initial} />
      </div>
    </div>
  );
}
