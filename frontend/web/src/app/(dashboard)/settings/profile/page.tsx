import { redirect } from "next/navigation";

/**
 * The former "My Details" page has been merged into the unified "My CV" page at
 * /cv. This route now just redirects there, preserving the email
 * OAuth result params (the Gmail/Outlook callbacks still land here).
 */
export default async function ProfileSettingsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  const connected = sp.email_connected;
  const error     = sp.email_error;
  if (typeof connected === "string") qs.set("email_connected", connected);
  if (typeof error === "string")     qs.set("email_error", error);
  const q = qs.toString();
  redirect(`/cv${q ? `?${q}` : ""}`);
}
