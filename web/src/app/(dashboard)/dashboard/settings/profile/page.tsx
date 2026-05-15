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
    <div className="min-h-full px-6 py-6 flex flex-col">
      <div className="w-full max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-[16px] font-semibold text-text">Profile</h1>
          <p className="text-[12px] text-text-3 mt-0.5">
            Contact details and portfolio projects used when tailoring your CV.
          </p>
        </div>
        <ProfileSettingsClient initial={initial} />
      </div>
    </div>
  );
}
