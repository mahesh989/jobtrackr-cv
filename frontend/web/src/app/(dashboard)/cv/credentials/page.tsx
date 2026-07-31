import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { ensureSomeoneActive } from "@/lib/cv/ensureActive";
import { ProfileDetailsProvider, CredentialsSection, AutoSaveBadge } from "@/features/cv/profile";
import type { ContactDetails } from "@/lib/types";

export const metadata = { title: "Credentials — JobTrackr" };

/**
 * Maps structured_cv.certifications entries to Credentials checklist keys,
 * so the Credentials tab can suggest ("detected on your CV") which boxes to
 * tick. Suggestion only — never auto-ticks or auto-saves. Deliberately dumb
 * substring/regex matching; false negatives are fine (user just ticks
 * manually), false positives should stay rare given the specific patterns.
 */
const CREDENTIAL_PATTERNS: Record<string, RegExp> = {
  first_aid:               /first aid|HLTAID011|HLTAID003/i,
  cpr:                      /\bcpr\b|HLTAID009/i,
  police_check:             /police check|national police/i,
  ndis_screening:           /ndis/i,
  wwcc:                     /working with children|wwcc/i,
  flu_vaccination:          /influenza|flu vacc/i,
  covid_vaccination:        /covid/i,
  medication_competency:    /medication competenc|medication administration cert/i,
  white_card:               /white card/i,
};

function suggestCredentialKeys(certs: { name?: string }[]): string[] {
  const found = new Set<string>();
  for (const cert of certs ?? []) {
    const name = cert?.name ?? "";
    if (!name) continue;
    for (const [key, pattern] of Object.entries(CREDENTIAL_PATTERNS)) {
      if (pattern.test(name)) found.add(key);
    }
  }
  return [...found];
}

export default async function CredentialsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const admin = createAdminClient();

  await ensureSomeoneActive(admin, user.id);

  const [cvsExt, prefsRes] = await Promise.all([
    admin
      .from("cv_versions")
      .select("id, is_active, structured_cv")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    admin.from("user_preferences").select("contact_details").eq("user_id", user.id).maybeSingle(),
  ]);

  const cvList = (cvsExt.data ?? []) as Array<{ id: string; is_active: boolean; structured_cv?: { certifications?: { name?: string }[] } | null }>;
  const activeCv = cvList.find((c) => c.is_active) ?? cvList[0] ?? null;

  const contactDetails = (prefsRes.data?.contact_details ?? {}) as ContactDetails;
  const suggestedCredentialKeys = suggestCredentialKeys(activeCv?.structured_cv?.certifications ?? []);

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="page-title text-text">Credentials</h1>
          <p className="page-subtitle">
            Certifications, licences, and credentials detected on your CV.
          </p>
        </div>

        <ProfileDetailsProvider initial={contactDetails} activeCvId={activeCv?.id ?? null}>
          <CredentialsSection suggestedKeys={suggestedCredentialKeys} />
          <AutoSaveBadge />
        </ProfileDetailsProvider>
      </div>
    </div>
  );
}
