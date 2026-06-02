import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";
import { getEntitlement, getUsageSummary } from "@/lib/billing/entitlements";
import { DENY_COPY, type DenyReason } from "@/lib/billing/plans";
import { UsageMeter } from "@/components/billing/UsageMeter";
import { PlanCards } from "@/components/billing/PlanCards";
import { ManageSubscriptionButton } from "@/components/billing/ManageSubscriptionButton";

export const metadata = { title: "Billing — JobTrackr" };

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  trialing:           { text: "Free trial",        cls: "bg-blue/10 text-blue" },
  active:             { text: "Active",             cls: "bg-green-100 text-green-700" },
  past_due:           { text: "Payment overdue",    cls: "bg-amber-100 text-amber-700" },
  canceled:           { text: "Canceled",           cls: "bg-surface-2 text-text-2" },
  unpaid:             { text: "Unpaid",             cls: "bg-red-100 text-red-700" },
  incomplete:         { text: "Incomplete",         cls: "bg-surface-2 text-text-2" },
  incomplete_expired: { text: "Expired",            cls: "bg-surface-2 text-text-2" },
  comp:               { text: "Complimentary",      cls: "bg-purple-100 text-purple-700" },
  none:               { text: "No subscription",    cls: "bg-surface-2 text-text-2" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; checkout?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { denied, checkout } = await searchParams;
  const ent = await getEntitlement(user.id);
  const usage = await getUsageSummary(user.id, ent.periodStart);

  const status = STATUS_LABEL[ent.status] ?? STATUS_LABEL.none;
  const readOnly = ent.access === "read_only";
  const isComp = ent.status === "comp";
  const deny = denied && (denied in DENY_COPY) ? DENY_COPY[denied as DenyReason] : null;

  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="page-title text-text">Billing &amp; usage</h1>
          <p className="page-subtitle">Your plan, current-period usage, and payment settings.</p>
        </div>

        {/* Banners */}
        {checkout === "success" && (
          <div className="flex items-start gap-2 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-800">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>You&apos;re all set — your subscription is active. It may take a moment to reflect below.</span>
          </div>
        )}
        {deny && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">{deny.title}</p>
              <p>{deny.body}</p>
            </div>
          </div>
        )}
        {ent.pastDue && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Your last payment failed. Update your card to keep your subscription active.</span>
          </div>
        )}

        {/* Current plan card */}
        <div className="rounded-xl border border-border bg-surface p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-[var(--brand)]" />
              <span className="text-lg font-semibold capitalize text-text">{ent.planId}</span>
              <span className={"rounded-full px-2 py-0.5 text-[11px] font-semibold " + status.cls}>{status.text}</span>
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
            {ent.status === "trialing" && ent.trialEnd && (
              <div>
                <dt className="text-text-2">Trial ends</dt>
                <dd className="font-medium text-text">{fmtDate(ent.trialEnd)}</dd>
              </div>
            )}
            {ent.periodEnd && (
              <div>
                <dt className="text-text-2">{readOnly ? "Access until" : "Renews / resets"}</dt>
                <dd className="font-medium text-text">{fmtDate(ent.periodEnd)}</dd>
              </div>
            )}
          </dl>

          <div className="mt-5 flex flex-wrap gap-2">
            {!isComp && ent.status !== "none" && <ManageSubscriptionButton />}
          </div>
        </div>

        {/* Usage meters */}
        {!ent.unlimited && (
          <div className="rounded-xl border border-border bg-surface p-5">
            <h2 className="text-sm font-semibold text-text">This period</h2>
            <p className="mt-0.5 text-xs text-text-2">
              Tailored CVs and cover letters are separate buckets. &quot;Total&quot; includes re-analyses and regenerations.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <UsageMeter label="Tailored CVs (unique jobs)" used={usage.cvUnique} limit={ent.limits.maxCvUnique} />
              <UsageMeter label="Tailored CVs (total)" used={usage.cvTotal} limit={ent.limits.maxCvTotal} />
              <UsageMeter label="Cover letters (unique jobs)" used={usage.letterUnique} limit={ent.limits.maxLetterUnique} />
              <UsageMeter label="Cover letters (total)" used={usage.letterTotal} limit={ent.limits.maxLetterTotal} />
              <UsageMeter label="Discovery runs" used={usage.runs} limit={ent.limits.maxRuns} />
              <UsageMeter label="Search profiles" used={usage.profiles} limit={ent.limits.maxProfiles} />
            </div>
          </div>
        )}

        {ent.unlimited && (
          <div className="rounded-xl border border-border bg-surface p-5 text-sm text-text-2">
            You have unlimited access — no usage caps on this plan.
          </div>
        )}

        {/* Plan chooser — shown when read-only, trialing, or no sub. */}
        {(readOnly || ent.status === "trialing" || ent.status === "none") && (
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-text">
                {readOnly ? "Resubscribe" : ent.status === "trialing" ? "Pick a plan for after your trial" : "Choose a plan"}
              </h2>
              <p className="text-xs text-text-2">
                {readOnly
                  ? "Your account is read-only. Resubscribe to create new CVs and cover letters."
                  : "Upgrade anytime — your card is charged automatically when your trial ends."}
              </p>
            </div>
            <PlanCards showTrial={ent.status !== "trialing"} currentPlan={ent.planId} />
          </div>
        )}
      </div>
    </div>
  );
}
