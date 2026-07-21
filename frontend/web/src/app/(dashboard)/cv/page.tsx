import { createClient }       from "@/lib/supabase/server";
import { createAdminClient }  from "@/lib/supabase/admin";
import { redirect }           from "next/navigation";
import { LibraryClient }    from "@/features/cv/library/LibraryClient";
import { ensureSomeoneActive } from "@/lib/cv/ensureActive";
import { resolveSkillLabels, type RoleFamily } from "@/lib/cv/skillLabels";
import { suggestCredentialKeys } from "@/lib/cv/certSuggestions";
import {
  ProfileDetailsProvider, ContactSection, VerticalsSection,
  CredentialsSection, AvailabilitySection, ReferencesSubSection, SaveBar,
} from "@/features/cv/profile/DetailsClient";
import { ProfileTabs } from "@/features/cv/analysis/ProfileTabs";
import { VisaStatusSelect } from "@/features/cv/VisaStatusSelect";
import { isUserVisaStatus } from "@/lib/eligibility";
import type { ContactDetails } from "@/lib/types";

export const metadata = { title: "Profile — JobTrackr" };

interface PageProps {
  searchParams: Promise<{ tab?: string }>;
}

export default async function CvPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const defaultTab =
    sp.tab === "details" ? "details" :
    sp.tab === "credentials" ? "credentials" :
    "cvs";

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  // Heal the "no active CV" state before reading the list.
  await ensureSomeoneActive(admin, user.id);

  // CVs + profile overlay, in parallel.
  const [cvsExt, prefsRes] = await Promise.all([
    admin
      .from("cv_versions")
      .select("id, label, pdf_storage_path, is_active, categorised_skills, created_at, structured_cv_status, structured_cv")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    admin.from("user_preferences").select("contact_details").eq("user_id", user.id).maybeSingle(),
  ]);

  // Legacy fallback when migrations 058/059 aren't applied yet.
  let cvs = cvsExt.data as Array<Record<string, unknown>> | null;
  if (cvsExt.error && /structured_cv_status|structured_cv|column/i.test(cvsExt.error.message)) {
    const fallback = await admin
      .from("cv_versions")
      .select("id, label, pdf_storage_path, is_active, categorised_skills, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    cvs = fallback.data as Array<Record<string, unknown>> | null;
  }

  const contactDetails = (prefsRes.data?.contact_details ?? {}) as ContactDetails;
  const roleFamilies   = ((contactDetails as { role_families?: RoleFamily[] }).role_families) ?? [];
  const skillLabels    = resolveSkillLabels(roleFamilies);

  const cvList   = (cvs ?? []) as Array<{ id: string; is_active: boolean; structured_cv?: { certifications?: { name?: string }[] } | null }>;
  const activeCv = cvList.find((c) => c.is_active) ?? cvList[0] ?? null;

  // Credentials tab "detected on your CV" hints — already have structured_cv
  // in memory from the query above, no extra fetch needed.
  const suggestedCredentialKeys = suggestCredentialKeys(activeCv?.structured_cv?.certifications ?? []);

  const rawVisaStatus = (prefsRes.data?.contact_details as { visa_status?: string } | null)?.visa_status;
  const userVisaStatus = isUserVisaStatus(rawVisaStatus) ? rawVisaStatus : null;

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">Profile</h1>
          <p className="page-subtitle">
            Your CVs plus the contact details, credentials, projects and references used to tailor them.
          </p>
        </div>

        <ProfileDetailsProvider initial={contactDetails} activeCvId={activeCv?.id ?? null}>
          <ProfileTabs
            defaultTab={defaultTab}
            cvs={
              <>
                <VerticalsSection />

                {/* The CV library sits between the profile overlay sections (per the
                    chosen layout). It does not consume the profile context. */}
                <div className="pt-2">
                  <h2 className="text-title font-semibold text-text">Your CVs</h2>
                  <p className="text-label text-text-3 mt-0.5 mb-3">
                    Upload or build a CV from scratch, then set one active. The active CV is what the
                    AI tailors for each job.
                  </p>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  <LibraryClient initial={(cvs ?? []) as any} skillLabels={skillLabels} />
                </div>
              </>
            }
            details={
              <>
                <ContactSection />

                {/* Working rights — user-level visa status (contact_details.visa_status,
                    same "applies to all CVs" home as role_families). Drives the
                    eligibility badge on job cards and the pipeline's fetch filter. */}
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
                <ReferencesSubSection />
              </>
            }
            credentials={<CredentialsSection suggestedKeys={suggestedCredentialKeys} />}
          />
          <SaveBar />
        </ProfileDetailsProvider>
      </div>
    </div>
  );
}
