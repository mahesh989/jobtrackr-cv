import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import ComparisonClient from "./ComparisonClient";

export const metadata = {
  title: "Model Comparison — JobTrackr Beta",
};

export default async function ComparisonPage() {
  // ── Auth check ────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) {
    redirect("/dashboard");
  }

  // ── Load CV versions ───────────────────────────────────────────────────
  const admin = createAdminClient();
  const { data: cvVersions } = await admin
    .from("cv_versions")
    .select("id, label, is_active, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  // ── Load connected providers ───────────────────────────────────────────
  const { data: keys } = await admin
    .from("user_integrations")
    .select("provider, status, is_enabled")
    .eq("user_id", user.id)
    .eq("status", "valid")
    .eq("is_enabled", true);

  const connectedProviders = [...new Set(
    keys?.map((k) => (k as any).provider) || []
  )];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[20px] font-bold text-text">Model Comparison</h1>
        <p className="text-[14px] text-text-3 mt-1">Compare OpenAI GPT-4o vs Anthropic Claude Opus on the same CV+JD</p>
      </div>

      <ComparisonClient
        cvVersions={cvVersions ?? []}
        connectedProviders={connectedProviders}
      />
    </div>
  );
}
