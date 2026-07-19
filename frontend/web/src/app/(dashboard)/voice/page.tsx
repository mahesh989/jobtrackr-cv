import { createClient }       from "@/lib/supabase/server";
import { createAdminClient }  from "@/lib/supabase/admin";
import { redirect }           from "next/navigation";
import { VoiceCaptureClient } from "@/features/cv/voice/VoiceCaptureClient";
import { StoriesClient }      from "@/features/cv/voice/StoriesClient";
import type { StoredStory }   from "@/features/cv/voice/StoriesClient";

export const metadata = { title: "Writing voice — JobTrackr" };

export default async function VoicePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  // Writing voice profile — includes voice_sample_raw so the client can
  // render a view-and-edit panel. Was deliberately stripped in earlier
  // versions but it's the user's own writing, no reason to hide it.
  const { data: profile } = await admin
    .from("voice_profiles")
    .select("id, fingerprint, voice_sample_raw, voice_sample_trust_score, voice_sample_source, created_at, updated_at")
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
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-2xl mx-auto space-y-8">

        {/* Writing voice section — HOW you write */}
        <div className="space-y-4">
          <div>
            <h1 className="page-title text-text">Writing voice</h1>
            <p className="page-subtitle">
              A short sample of your writing style — sentence rhythm, word choices, level of formality.
              We use this to rewrite outgoing emails and the body of generated cover letters so they sound
              like you, not like a template.
            </p>
            <p className="page-subtitle mt-1 text-[12px] text-[var(--sidebar-text-dim)]">
              Note: this is about <span className="font-semibold">style</span>. Concrete achievements and
              metrics from your CV live in the <em>Stories</em> section below — different thing.
            </p>
          </div>
          <VoiceCaptureClient initialProfile={profile ?? null} />
        </div>

        <hr className="border-[var(--card-border)]" />

        {/* Story library section — WHAT you've done */}
        <div className="space-y-4">
          <div>
            <h2 className="page-title text-text" style={{ fontSize: "1.125rem" }}>Stories from your CV</h2>
            <p className="page-subtitle">
              Concrete achievements with metrics, extracted from your CV — used as the substance of cover
              letter body paragraphs. Different from your writing voice above: this is <span className="font-semibold">what</span> you&apos;ve done,
              that section is <span className="font-semibold">how</span> you write about it.
            </p>
          </div>
          <StoriesClient initialStories={initialStories} />
        </div>

      </div>
    </div>
  );
}
