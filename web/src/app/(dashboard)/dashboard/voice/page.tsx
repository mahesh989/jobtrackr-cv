import { createClient }       from "@/lib/supabase/server";
import { createAdminClient }  from "@/lib/supabase/admin";
import { redirect }           from "next/navigation";
import { VoiceCaptureClient } from "@/components/cv/VoiceCaptureClient";
import { StoriesClient }      from "@/components/cv/StoriesClient";
import type { StoredStory }   from "@/components/cv/StoriesClient";

export const metadata = { title: "My Voice — JobTrackr" };

export default async function VoicePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  // Voice profile — deliberately exclude voice_sample_raw.
  const { data: profile } = await admin
    .from("voice_profiles")
    .select("id, fingerprint, voice_sample_trust_score, voice_sample_source, created_at, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  // Current story batch — two-query pattern (max extraction_timestamp first).
  const { data: tsRow } = await admin
    .from("stories")
    .select("extraction_timestamp")
    .eq("user_id", user.id)
    .order("extraction_timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  const initialStories: StoredStory[] = tsRow
    ? ((await admin
        .from("stories")
        .select("id, title, domain, year, one_line, detailed, numbers, tags, extraction_timestamp")
        .eq("user_id", user.id)
        .eq("extraction_timestamp", tsRow.extraction_timestamp)
        .order("created_at", { ascending: true })
      ).data ?? []) as StoredStory[]
    : [];

  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-2xl mx-auto space-y-8">

        {/* Voice capture section */}
        <div className="space-y-4">
          <div>
            <h1 className="page-title text-text">My Voice</h1>
            <p className="page-subtitle">
              Teach JobTrackr your writing style. Your voice fingerprint is used to make cover letters sound like you, not like AI.
            </p>
          </div>
          <VoiceCaptureClient initialProfile={profile ?? null} />
        </div>

        <hr className="border-[var(--card-border)]" />

        {/* Story library section */}
        <div className="space-y-4">
          <div>
            <h2 className="page-title text-text" style={{ fontSize: "1.125rem" }}>Your Stories</h2>
            <p className="page-subtitle">
              Achievement stories extracted from your CV — used to personalise cover letter body paragraphs.
              Each story can be tagged and expanded. Detailed paragraphs are 100–200 words, ready to use as-is.
            </p>
          </div>
          <StoriesClient initialStories={initialStories} />
        </div>

      </div>
    </div>
  );
}
