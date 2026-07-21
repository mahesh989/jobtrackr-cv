import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect }          from "next/navigation";
import { IntegrationCard } from "@/features/email/IntegrationCard";
import { NotificationsToggle }  from "@/features/cv/NotificationsToggle";

export const metadata = { title: "Account — JobTrackr" };

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

export default async function AccountSettingsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const connected = sp.email_connected ?? null;
  const errorKey  = sp.email_error     ?? null;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  const [emailRes, engagementRes] = await Promise.all([
    admin.from("email_integrations").select("provider, from_address").eq("user_id", user.id).maybeSingle(),
    admin.from("user_engagement").select("notify_new_jobs").eq("user_id", user.id).maybeSingle(),
  ]);

  const emailConnected = emailRes.data?.from_address
    ? { provider: emailRes.data.provider as "google" | "microsoft", from_address: emailRes.data.from_address as string }
    : null;

  // Row may not exist yet (user pre-dates the touch RPC) — default true.
  const notifyNewJobs = (engagementRes.data?.notify_new_jobs as boolean | undefined) ?? true;

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">Account</h1>
          <p className="page-subtitle">
            Connect your email and control what JobTrackr sends you.
          </p>
        </div>

        {/* Email OAuth result banner — shown once after the callback redirects here. */}
        {connected && (
          <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/10 px-4 py-3">
            <p className="text-body font-medium text-black dark:text-white">
              ✓ {connected === "google" ? "Gmail" : "Outlook"} connected successfully
            </p>
          </div>
        )}
        {errorKey && (
          <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-4 py-3">
            <p className="text-body font-medium text-red-800 dark:text-red-300">✗ Email connection failed</p>
            <p className="text-label text-red-700 dark:text-red-400 mt-0.5">{describeError(errorKey)}</p>
          </div>
        )}

        {/* Email account — per-user OAuth, separate from the profile overlay. */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
          <div>
            <h2 className="text-title font-semibold text-text">Email account</h2>
            <p className="text-label text-text-3 mt-0.5">
              Connect Gmail or Outlook to send application emails with your cover letter and
              tailored CV directly from the Applications page.
            </p>
          </div>
          <IntegrationCard
            connected={emailConnected}
            googleConfigured={!!process.env.GOOGLE_CLIENT_ID}
            microsoftConfigured={!!process.env.MICROSOFT_CLIENT_ID}
          />
        </section>

        {/* Notifications — per-user email preferences. */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
          <div>
            <h2 className="text-title font-semibold text-text">Notifications</h2>
            <p className="text-label text-text-3 mt-0.5">
              Control which emails JobTrackr sends you.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-body text-text font-medium">Email me when new jobs are found</p>
              <p className="text-label text-text-3 mt-0.5">
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
