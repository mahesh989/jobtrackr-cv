import { createClient }        from "@/lib/supabase/server";
import { createAdminClient }   from "@/lib/supabase/admin";
import { redirect }            from "next/navigation";
import { VoiceCaptureClient }  from "@/components/cv/VoiceCaptureClient";

export const metadata = { title: "My Voice — JobTrackr" };

export default async function VoicePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();
  // Deliberately exclude voice_sample_raw — it must never be returned after submission.
  const { data: profile } = await admin
    .from("voice_profiles")
    .select("id, fingerprint, voice_sample_trust_score, voice_sample_source, created_at, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">My Voice</h1>
          <p className="page-subtitle">
            Teach JobTrackr your writing style. Your voice fingerprint is used to make cover letters sound like you, not like AI.
          </p>
        </div>
        <VoiceCaptureClient initialProfile={profile ?? null} />
      </div>
    </div>
  );
}
