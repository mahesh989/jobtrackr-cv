/**
 * Founder-only beta screen for A/B/C/D testing of tailored-CV writers + ATS scorers.
 *
 * Server component: gates on founder/admin role, loads the user's CV versions
 * and connected AI providers, hands off to the client for the interactive
 * paste-JD-and-run flow. Results go to the isolated eval_runs table —
 * production analysis_runs / job records are untouched by this screen.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient }      from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import BetaClient, { type BetaCvVersion } from "./BetaClient";

export const dynamic = "force-dynamic";

export default async function BetaPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: me } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (!me || !["founder", "admin"].includes(me.role as string)) redirect("/dashboard");

  const admin = createAdminClient();

  const { data: cvRows } = await admin
    .from("cv_versions")
    .select("id, label, is_active, created_at")
    .eq("user_id", user.id)
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: false });

  const cvVersions: BetaCvVersion[] = (cvRows ?? []).map((r) => ({
    id:         r.id as string,
    label:      (r.label as string) ?? "(untitled)",
    is_active:  Boolean(r.is_active),
    created_at: r.created_at as string,
  }));

  const { data: keys } = await admin
    .from("user_integrations")
    .select("provider")
    .eq("user_id", user.id)
    .eq("status", "valid")
    .eq("is_enabled", true);

  const connectedProviders = ((keys ?? []) as Array<{ provider: string }>).map((k) => k.provider);

  return (
    <div className="min-h-full">
      <div className="border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] text-text-3 mb-1">
              <Link href="/dashboard" className="hover:text-text transition-colors">Dashboard</Link>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
              <span className="text-text-2">Beta · A/B/C/D</span>
            </div>
            <h1 className="text-[16px] font-semibold text-text">Beta — Tailored-CV variant comparison</h1>
            <p className="text-[12px] text-text-2 mt-1 max-w-2xl">
              Paste a JD, pick a CV, run the selected writers in parallel. Results write to the
              isolated <code className="font-mono text-[11px]">eval_runs</code> table — production
              analysis is unaffected. Copy each column into another agent for independent rating.
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="text-[11px] text-text-3">Other tools:</span>
          <Link href="/dashboard/beta/model-comparison" className="text-[11px] text-blue-500 hover:underline">
            Model Comparison (OpenAI vs Anthropic)
          </Link>
          <Link href="/dashboard/beta/skills-audit" className="text-[11px] text-blue-500 hover:underline">
            Skills Audit
          </Link>
          <Link href="/dashboard/beta/summary-audit" className="text-[11px] text-blue-500 hover:underline">
            Summary Audit
          </Link>
        </div>
      </div>

      <div className="px-6 py-5">
        <BetaClient
          cvVersions={cvVersions}
          connectedProviders={connectedProviders}
        />
      </div>
    </div>
  );
}
