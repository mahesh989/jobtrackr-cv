import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";
import { getEntitlement, getUsageSummary } from "@/lib/billing/entitlements";
import { DENY_COPY, type DenyReason } from "@/lib/billing/plans";
import { UsageMeter } from "@/features/billing/UsageMeter";
import { PlanCards } from "@/features/billing/PlanCards";
import { ManageButton } from "@/features/billing/ManageButton";
import { UpgradeOptions } from "@/features/billing/UpgradeOptions";

export const metadata = { title: "Billing — JobTrackr" };

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  trialing:           { text: "Free trial",        cls: "bg-blue/10 text-blue" },
  active:             { text: "Active",             cls: "bg-green-100 text-green-700" },
  past_due:           { text: "Payment overdue",    cls: "bg-amber-100 text-amber-700" },
  canceled:           { text: "Canceled",           cls: "bg-surface-2 text-text-2" },
  unpaid:             { text: "Unpaid",             cls: "bg-red-100 text-red-700" },
  incomplete:         { text: "Setup incomplete",   cls: "bg-amber-100 text-amber-700" },
  incomplete_expired: { text: "Setup expired",      cls: "bg-surface-2 text-text-2" },
  comp:               { text: "Complimentary",      cls: "bg-purple-100 text-purple-700" },
  none:               { text: "No subscription",    cls: "bg-surface-2 text-text-2" },
};

// One-line explanation under the status badge — every read-only-causing
// status gets a specific reason + next action, not just a bare label.
const STATUS_DESCRIPTION: Partial<Record<string, string>> = {
  incomplete:         "Your card couldn't be confirmed when you set this up, so the subscription never activated. Finish payment via Manage subscription, or choose a plan again below.",
  incomplete_expired: "The checkout session expired before payment was confirmed. Choose a plan below to start again.",
  canceled:           "This subscription was canceled. Resubscribe below to create new CVs and cover letters.",
  unpaid:             "Your last payment failed and the subscription was paused. Update your card via Manage subscription, or choose a plan below.",
  past_due:           "Your last payment failed. Update your card via Manage subscription to keep this plan active.",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; checkout?: string; upgraded?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { denied, checkout, upgraded } = await searchParams;
  const ent = await getEntitlement(user.id);
  const usage = await getUsageSummary(user.id, ent.periodStart);

  const status = STATUS_LABEL[ent.status] ?? STATUS_LABEL.none;
  const readOnly = ent.access === "read_only";
  const isComp = ent.status === "comp";
  const deny = denied && (denied in DENY_COPY) ? DENY_COPY[denied as DenyReason] : null;

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
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
        {upgraded === "1" && (
          <div className="flex items-start gap-2 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-800">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Plan upgraded — your new plan is now active. It may take a moment to reflect below.</span>
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

          {STATUS_DESCRIPTION[ent.status] && (
            <p className="mt-2.5 text-xs text-text-2 leading-relaxed">{STATUS_DESCRIPTION[ent.status]}</p>
          )}

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

          {!isComp && ent.status !== "none" && (
            <div className="mt-5">
              <div className="flex flex-wrap gap-2">
                <ManageButton />
              </div>
              <p className="mt-1.5 text-[11px] text-text-3">
                Opens Stripe&apos;s secure billing portal — update your card, switch plans, view past invoices, or cancel.
              </p>
            </div>
          )}
        </div>

        {/* Upgrade options — active/past_due subscribers not on highest tier */}
        {(ent.status === "active" || ent.status === "past_due") && ent.planId !== "unlimited" && (
          <UpgradeOptions currentPlanId={ent.planId} />
        )}

        {/* Usage meters — skip entirely for read-only accounts. The readOnly()
            helper sets limits to UNLIMITED (all null) as a matter of not
            enforcing caps that no longer matter, but rendering that here
            would show "0 ∞" — implying unlimited access on an account that
            actually has zero write access. There's nothing meaningful to
            show until a plan is (re)activated. */}
        {!ent.unlimited && !readOnly && (
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
                {ent.status === "trialing"
                  ? "Pick a plan for after your trial"
                  : ent.status === "incomplete" || ent.status === "incomplete_expired"
                  ? "Finish setting up your plan"
                  : readOnly
                  ? "Resubscribe"
                  : "Choose a plan"}
              </h2>
              <p className="text-xs text-text-2">
                {ent.status === "trialing"
                  ? "Upgrade anytime — your card is charged automatically when your trial ends."
                  : ent.status === "incomplete" || ent.status === "incomplete_expired"
                  ? "Pick a plan below to start a fresh checkout — or use Manage subscription above if you'd rather finish the original one."
                  : readOnly
                  ? "Your account is read-only. Resubscribe to create new CVs and cover letters."
                  : "Choose a plan to get started."}
              </p>
            </div>
            {/* showTrial=false so buttons read "Choose this plan" instead of
                repeating "Start free trial" on every card — the headline
                above already explains the trial/upgrade context. */}
            <PlanCards showTrial={false} currentPlan={ent.planId} />
          </div>
        )}
      </div>
    </div>
  );
}
