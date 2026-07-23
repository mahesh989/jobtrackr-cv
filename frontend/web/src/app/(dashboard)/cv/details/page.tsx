import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { ensureSomeoneActive } from "@/lib/cv/ensureActive";
import { ProfileDetailsProvider, ContactSection, AvailabilitySection, ProfileSaveBar } from "@/features/cv/profile";
import { VisaStatusSelect } from "@/features/cv/profile/VisaStatusSelect";
import { isUserVisaStatus } from "@/lib/eligibility";
import type { ContactDetails } from "@/lib/types";

export const metadata = { title: "Details — JobTrackr" };

export default async function DetailsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  await ensureSomeoneActive(admin, user.id);

  const [cvsExt, prefsRes] = await Promise.all([
    admin
      .from("cv_versions")
      .select("id, is_active")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    admin.from("user_preferences").select("contact_details").eq("user_id", user.id).maybeSingle(),
  ]);

  const cvs = (cvsExt.data ?? []) as Array<{ id: string; is_active: boolean }>;
  const activeCv = cvs.find((c) => c.is_active) ?? cvs[0] ?? null;

  const contactDetails = (prefsRes.data?.contact_details ?? {}) as ContactDetails;

  const rawVisaStatus = (prefsRes.data?.contact_details as { visa_status?: string } | null)?.visa_status;
  const userVisaStatus = isUserVisaStatus(rawVisaStatus) ? rawVisaStatus : null;

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">Details</h1>
          <p className="page-subtitle">
            Contact details, working rights, availability, and references used across all CVs.
          </p>
        </div>

        <ProfileDetailsProvider initial={contactDetails} activeCvId={activeCv?.id ?? null}>
          <ContactSection />

          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
            <div>
              <h2 className="text-title font-semibold text-text">Working rights</h2>
              <p className="text-label text-text-3 mt-0.5">
                Your visa situation in Australia. Jobs whose description rules you out
                (e.g. &ldquo;PR/citizens only&rdquo;, &ldquo;unrestricted working rights required&rdquo;)
                get flagged on the board and skipped by scheduled fetches.
              </p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-body text-text font-medium">My working rights</p>
              <VisaStatusSelect initial={userVisaStatus} />
            </div>
          </section>

          <AvailabilitySection />
          <ProfileSaveBar />
        </ProfileDetailsProvider>
      </div>
    </div>
  );
}
