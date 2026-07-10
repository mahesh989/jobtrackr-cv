import { createClient }       from "@/lib/supabase/server";
import { createAdminClient }  from "@/lib/supabase/admin";
import { redirect }           from "next/navigation";
import { CvLibraryClient }    from "@/components/cv/CvLibraryClient";
import { ensureSomeoneActive } from "@/lib/cv/ensureActive";
import { resolveSkillLabels, type RoleFamily } from "@/lib/cv/skillLabels";
import {
  ProfileDetailsProvider, ContactSection, VerticalsSection,
  CredentialsSection, AvailabilitySection, ReferencesSubSection, ProfileSaveBar,
} from "@/components/cv/ProfileDetailsClient";
import { EmailIntegrationCard } from "@/components/email/EmailIntegrationCard";
import { NotificationsToggle } from "@/components/NotificationsToggle";
import type { ContactDetails } from "@/components/cv/ProfileSettingsClient";

export const metadata = { title: "My CV — JobTrackr" };

interface PageProps {
  searchParams: Promise<{
    email_connected?: "google" | "outlook";
    email_error?:     string;
  }>;
}

const OAUTH_ERROR_LABELS: Record<string, string> = {
  invalid_state:         "Security check failed — please try again.",
  no_code:               "Google didn't return an authorization code.",
  token_exchange_failed: "Couldn't exchange the code for a token.",
  missing_tokens:        "OAuth completed but no refresh token was returned. Try again from the Connect button.",
  access_denied:         "You declined the consent screen.",
};
function describeError(key: string): string {
  if (key.startsWith("save_failed:")) return `Token save failed — ${key.slice("save_failed:".length)}`;
  return OAUTH_ERROR_LABELS[key] ?? `Error: ${key}`;
}

export default async function CvPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const connected = sp.email_connected ?? null;
  const errorKey  = sp.email_error     ?? null;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  // Heal the "no active CV" state before reading the list.
  await ensureSomeoneActive(admin, user.id);

  // CVs + profile overlay + email integration, all in parallel.
  const [cvsExt, prefsRes, emailRes, engagementRes] = await Promise.all([
    admin
      .from("cv_versions")
      .select("id, label, pdf_storage_path, is_active, categorised_skills, created_at, structured_cv_status, structured_cv")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    admin.from("user_preferences").select("contact_details").eq("user_id", user.id).maybeSingle(),
    admin.from("email_integrations").select("provider, from_address").eq("user_id", user.id).maybeSingle(),
    admin.from("user_engagement").select("notify_new_jobs").eq("user_id", user.id).maybeSingle(),
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

  const cvList   = (cvs ?? []) as Array<{ id: string; is_active: boolean }>;
  const activeCv = cvList.find((c) => c.is_active) ?? cvList[0] ?? null;

  const emailConnected = emailRes.data?.from_address
    ? { provider: emailRes.data.provider as "google" | "microsoft", from_address: emailRes.data.from_address as string }
    : null;

  // Row may not exist yet (user pre-dates the touch RPC) — default true.
  const notifyNewJobs = (engagementRes.data?.notify_new_jobs as boolean | undefined) ?? true;

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">My CV</h1>
          <p className="page-subtitle">
            Your CVs plus the contact details, credentials, projects and references used to tailor them.
          </p>
        </div>

        {/* Email OAuth result banner — shown once after the callback redirects here. */}
        {connected && (
          <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/10 px-4 py-3">
            <p className="text-[13px] font-medium text-black dark:text-white">
              ✓ {connected === "google" ? "Gmail" : "Outlook"} connected successfully
            </p>
          </div>
        )}
        {errorKey && (
          <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-4 py-3">
            <p className="text-[13px] font-medium text-red-800 dark:text-red-300">✗ Email connection failed</p>
            <p className="text-[12px] text-red-700 dark:text-red-400 mt-0.5">{describeError(errorKey)}</p>
          </div>
        )}

        <ProfileDetailsProvider initial={contactDetails} activeCvId={activeCv?.id ?? null}>
          <VerticalsSection />
          <ContactSection />

          {/* The CV library sits between the profile overlay sections (per the
              chosen layout). It does not consume the profile context. */}
          <div className="pt-2">
            <h2 className="text-[14.5px] font-semibold text-text">Your CVs</h2>
            <p className="text-[12px] text-text-3 mt-0.5 mb-3">
              Upload or build a CV from scratch, then set one active. The active CV is what the
              AI tailors for each job.
            </p>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            <CvLibraryClient initial={(cvs ?? []) as any} skillLabels={skillLabels} />
          </div>

          <CredentialsSection />
          <AvailabilitySection />
          <ReferencesSubSection />
          <ProfileSaveBar />
        </ProfileDetailsProvider>

        {/* Email account — per-user OAuth, separate from the profile overlay. */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
          <div>
            <h2 className="text-[14.5px] font-semibold text-text">Email account</h2>
            <p className="text-[12px] text-text-3 mt-0.5">
              Connect Gmail or Outlook to send application emails with your cover letter and
              tailored CV directly from the Applications page.
            </p>
          </div>
          <EmailIntegrationCard
            connected={emailConnected}
            googleConfigured={!!process.env.GOOGLE_CLIENT_ID}
            microsoftConfigured={!!process.env.MICROSOFT_CLIENT_ID}
          />
        </section>

        {/* Notifications — per-user email preferences. */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
          <div>
            <h2 className="text-[14.5px] font-semibold text-text">Notifications</h2>
            <p className="text-[12px] text-text-3 mt-0.5">
              Control which emails JobTrackr sends you.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] text-text font-medium">Email me when new jobs are found</p>
              <p className="text-[12px] text-text-3 mt-0.5">
                One email per scheduled run that saves new jobs. You can unsubscribe from any email too.
              </p>
            </div>
            <NotificationsToggle initial={notifyNewJobs} />
          </div>
        </section>
      </div>
    </div>
  );
}
