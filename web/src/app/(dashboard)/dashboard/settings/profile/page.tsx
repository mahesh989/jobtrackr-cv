import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect }          from "next/navigation";
import { ProfileSettingsClient, type ContactDetails } from "@/components/cv/ProfileSettingsClient";
import { EmailIntegrationCard } from "@/components/email/EmailIntegrationCard";

export const metadata = { title: "My Details — JobTrackr" };

interface PageProps {
  searchParams: Promise<{
    email_connected?: "google" | "outlook";
    email_error?:     string;
  }>;
}

const OAUTH_ERROR_LABELS: Record<string, string> = {
  invalid_state:           "Security check failed — please try again.",
  no_code:                 "Google didn't return an authorization code.",
  token_exchange_failed:   "Couldn't exchange the code for a token.",
  missing_tokens:          "OAuth completed but no refresh token was returned. Try again from the Connect button.",
  access_denied:           "You declined the consent screen.",
};

function describeError(key: string): string {
  if (key.startsWith("save_failed:")) return `Token save failed — ${key.slice("save_failed:".length)}`;
  return OAUTH_ERROR_LABELS[key] ?? `Error: ${key}`;
}

export default async function ProfileSettingsPage({ searchParams }: PageProps) {
  const sp        = await searchParams;
  const connected = sp.email_connected ?? null;
  const errorKey  = sp.email_error     ?? null;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  // Contact details (existing — drives CV personalisation) + email integration
  // status fetched together; they're independent so run them in parallel.
  const [{ data: prefs }, { data: emailRow }] = await Promise.all([
    admin.from("user_preferences")
      .select("contact_details")
      .eq("user_id", user.id)
      .maybeSingle(),
    admin.from("email_integrations")
      .select("provider, from_address")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  const initial = (prefs?.contact_details as ContactDetails | null) ?? null;

  // Email account — per-user OAuth integration, used by the Applications page
  // to send tailored CV + cover letter as an actual email. Lives here (not on
  // /integrations) because users see this page; /integrations is founder-only.
  const emailConnected = emailRow?.from_address
    ? { provider: emailRow.provider as "google" | "microsoft", from_address: emailRow.from_address as string }
    : null;

  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <h1 className="page-title text-text">My Details</h1>
          <p className="page-subtitle">
            Your contact details, credentials, and portfolio projects — used when tailoring your CV.
          </p>
        </div>

        <ProfileSettingsClient initial={initial} />

        {/* OAuth result banner — shown for one page-load after the callback
            redirects here. Same UX as the old Integrations page so the
            connect/disconnect flow feels familiar after the move. */}
        {connected && (
          <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/10 px-4 py-3">
            <p className="text-[13px] font-medium text-black dark:text-white">
              ✓ {connected === "google" ? "Gmail" : "Outlook"} connected successfully
            </p>
            <p className="text-[12px] text-black dark:text-white mt-0.5">
              You can now send application emails from the Applications page.
            </p>
          </div>
        )}
        {errorKey && (
          <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-4 py-3">
            <p className="text-[13px] font-medium text-red-800 dark:text-red-300">
              ✗ Email connection failed
            </p>
            <p className="text-[12px] text-red-700 dark:text-red-400 mt-0.5">
              {describeError(errorKey)}
            </p>
          </div>
        )}

        <section>
          <h2 className="text-[13px] font-semibold text-text mb-1">Email account</h2>
          <p className="text-[12px] text-text-3 mb-3">
            Connect Gmail or Outlook to send application emails with your cover letter
            and tailored CV directly from the Applications page.
          </p>
          <EmailIntegrationCard
            connected={emailConnected}
            googleConfigured={!!process.env.GOOGLE_CLIENT_ID}
            microsoftConfigured={!!process.env.MICROSOFT_CLIENT_ID}
          />
        </section>
      </div>
    </div>
  );
}
