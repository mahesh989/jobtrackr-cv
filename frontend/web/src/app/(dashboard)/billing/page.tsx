import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { CheckCircle2, AlertTriangle, CreditCard, Receipt, ExternalLink } from "lucide-react";
import { getEntitlement, getUsageSummary } from "@/lib/billing/entitlements";
import { getBillingSnapshot, formatAmount, type InvoiceRow } from "@/lib/billing/details";
import { DENY_COPY, PUBLIC_PLANS, formatAud, type DenyReason, type PlanId } from "@/lib/billing/plans";
import { UsageMeter } from "@/features/billing/UsageMeter";
import { PlanCards } from "@/features/billing/PlanCards";
import { ManageButton } from "@/features/billing/ManageButton";
import { UpgradeOptions } from "@/features/billing/UpgradeOptions";

export const metadata = { title: "Billing — JobTrackr" };

// Status chip — all colors are theme tokens so the 6 themes (incl. dark)
// render it correctly.
const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  trialing:           { text: "Free trial",       cls: "bg-[var(--blue)]/10 text-[var(--blue)]" },
  active:             { text: "Active",           cls: "bg-[var(--green-light)] text-[var(--green)]" },
  past_due:           { text: "Payment overdue",  cls: "bg-[var(--amber-light)] text-[var(--amber)]" },
  canceled:           { text: "Canceled",         cls: "bg-surface-2 text-text-2" },
  unpaid:             { text: "Unpaid",           cls: "bg-[var(--red-light)] text-[var(--red)]" },
  incomplete:         { text: "Setup incomplete", cls: "bg-[var(--amber-light)] text-[var(--amber)]" },
  incomplete_expired: { text: "Setup expired",    cls: "bg-surface-2 text-text-2" },
  comp:               { text: "Complimentary",    cls: "bg-[var(--purple-light)] text-[var(--purple)]" },
  none:               { text: "No subscription",  cls: "bg-surface-2 text-text-2" },
};

// One-line explanation under the status — every read-only-causing status gets
// a specific reason + next action, not just a bare label.
const STATUS_DESCRIPTION: Partial<Record<string, string>> = {
  incomplete:         "Your card couldn't be confirmed when you set this up, so the subscription never activated. Finish payment via Manage subscription, or choose a plan again below.",
  incomplete_expired: "The checkout session expired before payment was confirmed. Choose a plan below to start again.",
  canceled:           "This subscription was canceled. Resubscribe below to create new CVs and cover letters.",
  unpaid:             "Your last payment failed and the subscription was paused. Update your card via Manage subscription, or choose a plan below.",
  past_due:           "Your last payment failed. Update your card via Manage subscription to keep this plan active.",
};

const PLAN_NAME: Record<string, string> = {
  trial: "Free trial", weekly: "Weekly", monthly: "Monthly",
  unlimited: "Unlimited", comp: "Complimentary",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
}

function planPrice(planId: string | null): { label: string } | null {
  const p = PUBLIC_PLANS.find((x) => x.id === planId);
  if (!p) return null;
  return { label: `${formatAud(p.priceCents)} / ${p.interval}` };
}

function cardBrand(brand: string): string {
  if (brand === "amex") return "Amex";
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

const INVOICE_STATUS: Record<string, { text: string; cls: string }> = {
  paid:          { text: "Paid",   cls: "bg-[var(--green-light)] text-[var(--green)]" },
  open:          { text: "Due",    cls: "bg-[var(--amber-light)] text-[var(--amber)]" },
  void:          { text: "Void",   cls: "bg-surface-2 text-text-2" },
  uncollectible: { text: "Failed", cls: "bg-[var(--red-light)] text-[var(--red)]" },
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; checkout?: string; upgraded?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { denied, checkout, upgraded } = await searchParams;
  const [ent, snapshot] = await Promise.all([
    getEntitlement(user.id),
    getBillingSnapshot(user.id),
  ]);
  const usage = await getUsageSummary(user.id, ent.periodStart);

  const status = STATUS_LABEL[ent.status] ?? STATUS_LABEL.none;
  const readOnly = ent.access === "read_only";
  const isComp = ent.status === "comp";
  const trialing = ent.status === "trialing";
  const deny = denied && (denied in DENY_COPY) ? DENY_COPY[denied as DenyReason] : null;

  // What the user is (or will be) paying. During the trial ent.planId is
  // "trial", so the real picked plan comes from the subscription row.
  const paidPlanId: PlanId | null = trialing ? snapshot.subscribedPlan : (ent.planId as PlanId);
  const price = planPrice(paidPlanId);

  const cancelling = snapshot.cancelAtPeriodEnd && !readOnly && ent.status !== "none";

  return (
    <div className="min-h-full px-4 sm:px-6 pt-6 pb-24">
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="page-title text-text">Billing</h1>
          <p className="page-subtitle">Your plan, usage and invoices.</p>
        </div>

        {/* Banners */}
        {checkout === "success" && (
          <Banner tone="green" icon={<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}>
            You&apos;re all set — your subscription is active. It may take a moment to reflect below.
          </Banner>
        )}
        {upgraded === "1" && (
          <Banner tone="green" icon={<CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}>
            Plan upgraded — your new plan is now active. It may take a moment to reflect below.
          </Banner>
        )}
        {deny && (
          <Banner tone="amber" icon={<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}>
            <p className="font-semibold">{deny.title}</p>
            <p>{deny.body}</p>
          </Banner>
        )}
        {ent.pastDue && (
          <Banner tone="amber" icon={<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}>
            Your last payment failed. Update your card to keep your subscription active.
          </Banner>
        )}

        {/* ── Current plan ─────────────────────────────────────────────── */}
        <section className="rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-text">
                  {PLAN_NAME[ent.planId] ?? ent.planId}
                </h2>
                <span className={"rounded-full px-2 py-0.5 text-caption font-semibold " + status.cls}>
                  {status.text}
                </span>
              </div>
              {/* The price — the single most important fact on a billing page. */}
              {!trialing && price && !readOnly && (
                <p className="mt-1 text-sm font-medium text-text">{price.label}</p>
              )}
              {trialing && (
                <p className="mt-1 text-sm text-text-2">
                  Free for now{price && paidPlanId ? (
                    <> — then <span className="font-medium text-text">{price.label}</span> ({PLAN_NAME[paidPlanId]}) from {fmtDate(ent.trialEnd)}</>
                  ) : null}
                </p>
              )}
            </div>
            {!isComp && ent.status !== "none" && <ManageButton />}
          </div>

          {STATUS_DESCRIPTION[ent.status] && (
            <p className="mt-3 text-xs text-text-2 leading-relaxed">{STATUS_DESCRIPTION[ent.status]}</p>
          )}

          {/* Cancel-at-period-end — the truth a canceled-but-active sub needs. */}
          {cancelling && (
            <div className="mt-3 rounded-lg border border-[var(--amber)]/30 bg-[var(--amber-light)] px-3 py-2.5 text-label text-[var(--amber)]">
              {trialing
                ? <>Your trial is set to end on <strong>{fmtDate(ent.trialEnd)}</strong> without converting — you won&apos;t be charged. Changed your mind? Resume in Manage subscription.</>
                : <>Your plan is set to cancel on <strong>{fmtDate(ent.periodEnd)}</strong>. You keep full access until then, and you can resume anytime in Manage subscription.</>}
            </div>
          )}

          {/* Key facts */}
          <dl className="mt-4 grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
            {trialing && ent.trialEnd && (
              <div>
                <dt className="text-text-2">Trial ends</dt>
                <dd className="mt-0.5 font-medium text-text">
                  {fmtDate(ent.trialEnd)}
                  <span className="ml-1 font-normal text-text-3">
                    ({daysUntil(ent.trialEnd)} {daysUntil(ent.trialEnd) === 1 ? "day" : "days"} left)
                  </span>
                </dd>
              </div>
            )}
            {!trialing && ent.periodEnd && (
              <div>
                <dt className="text-text-2">{readOnly ? "Access until" : cancelling ? "Ends on" : "Renews on"}</dt>
                <dd className="mt-0.5 font-medium text-text">{fmtDate(ent.periodEnd)}</dd>
              </div>
            )}
            {snapshot.card && (
              <div>
                <dt className="text-text-2">Payment method</dt>
                <dd className="mt-0.5 flex items-center gap-1.5 font-medium text-text">
                  <CreditCard className="h-3.5 w-3.5 text-text-3" />
                  {cardBrand(snapshot.card.brand)} •••• {snapshot.card.last4}
                  <span className="font-normal text-text-3">
                    · exp {String(snapshot.card.expMonth).padStart(2, "0")}/{snapshot.card.expYear % 100}
                  </span>
                </dd>
              </div>
            )}
          </dl>
        </section>

        {/* ── Usage ────────────────────────────────────────────────────── */}
        {!readOnly && !ent.unlimited && (
          <section className="rounded-xl border border-border bg-surface p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-text">Usage this period</h2>
              {ent.periodEnd && (
                <span className="text-caption text-text-3">Resets {fmtDate(ent.periodEnd)}</span>
              )}
            </div>
            <div className="mt-4 grid gap-x-6 gap-y-5 sm:grid-cols-2">
              <UsageMeter
                label="Tailored CVs"
                used={usage.cvUnique}
                limit={ent.limits.maxCvUnique}
                hint={ent.limits.maxCvTotal !== null && ent.limits.maxCvTotal !== ent.limits.maxCvUnique
                  ? `${usage.cvTotal} of ${ent.limits.maxCvTotal} total generations incl. re-runs`
                  : undefined}
              />
              <UsageMeter
                label="Cover letters"
                used={usage.letterUnique}
                limit={ent.limits.maxLetterUnique}
                hint={ent.limits.maxLetterTotal !== null && ent.limits.maxLetterTotal !== ent.limits.maxLetterUnique
                  ? `${usage.letterTotal} of ${ent.limits.maxLetterTotal} total generations incl. re-runs`
                  : undefined}
              />
              <UsageMeter label="Discovery runs" used={usage.runs} limit={ent.limits.maxRuns} />
              <UsageMeter label="Search profiles" used={usage.profiles} limit={ent.limits.maxProfiles} />
            </div>
          </section>
        )}

        {/* Unlimited plans still get their numbers — informational, no bars. */}
        {!readOnly && ent.unlimited && (
          <section className="rounded-xl border border-border bg-surface p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-text">Activity this period</h2>
              {ent.periodEnd && !isComp && (
                <span className="text-caption text-text-3">Since {fmtDate(ent.periodStart)}</span>
              )}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat value={usage.cvUnique} label="Tailored CVs" />
              <Stat value={usage.letterUnique} label="Cover letters" />
              <Stat value={usage.runs} label="Discovery runs" />
              <Stat value={usage.profiles} label="Search profiles" />
            </div>
            <p className="mt-3 text-caption text-text-3">
              Your plan has no usage caps — these are just your numbers.
            </p>
          </section>
        )}

        {/* ── Invoices ─────────────────────────────────────────────────── */}
        {snapshot.invoices.length > 0 && (
          <section className="rounded-xl border border-border bg-surface p-5">
            <div className="flex items-center gap-2">
              <Receipt className="h-4 w-4 text-text-3" />
              <h2 className="text-sm font-semibold text-text">Invoices</h2>
            </div>
            <ul className="mt-2 divide-y divide-[var(--border-muted)]">
              {snapshot.invoices.map((inv) => <InvoiceLine key={inv.id} inv={inv} />)}
            </ul>
            <p className="mt-3 text-caption text-text-3">
              Full history and receipts are available in Manage subscription.
            </p>
          </section>
        )}

        {/* ── Change plan — active subscribers below the top tier ─────── */}
        {(ent.status === "active" || ent.status === "past_due") && !cancelling && ent.planId !== "unlimited" && (
          <UpgradeOptions currentPlanId={ent.planId} />
        )}

        {/* ── Plan chooser — read-only, trialing, or no sub ────────────── */}
        {(readOnly || trialing || ent.status === "none") && (
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-text">
                {trialing
                  ? "Pick a plan for after your trial"
                  : ent.status === "incomplete" || ent.status === "incomplete_expired"
                  ? "Finish setting up your plan"
                  : readOnly
                  ? "Resubscribe"
                  : "Choose a plan"}
              </h2>
              <p className="text-xs text-text-2">
                {trialing
                  ? "Upgrade anytime — your card is charged automatically when your trial ends."
                  : ent.status === "incomplete" || ent.status === "incomplete_expired"
                  ? "Pick a plan below to start a fresh checkout — or use Manage subscription above if you'd rather finish the original one."
                  : readOnly
                  ? "Your account is read-only. Resubscribe to create new CVs and cover letters."
                  : "Choose a plan to get started."}
              </p>
            </div>
            <PlanCards showTrial={false} currentPlan={ent.planId} />
          </section>
        )}
      </div>
    </div>
  );
}

// ── Presentational bits (server-safe) ─────────────────────────────────────

function Banner({ tone, icon, children }: {
  tone: "green" | "amber";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const cls = tone === "green"
    ? "border-[var(--green)]/30 bg-[var(--green-light)] text-[var(--green)]"
    : "border-[var(--amber)]/30 bg-[var(--amber-light)] text-[var(--amber)]";
  return (
    <div className={"flex items-start gap-2 rounded-lg border px-4 py-3 text-sm " + cls}>
      {icon}
      <div>{children}</div>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="text-xl font-bold text-text tabular-nums">{value}</div>
      <div className="mt-0.5 text-caption text-text-2">{label}</div>
    </div>
  );
}

function InvoiceLine({ inv }: { inv: InvoiceRow }) {
  const st = INVOICE_STATUS[inv.status] ?? { text: inv.status, cls: "bg-surface-2 text-text-2" };
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="w-28 shrink-0 text-xs text-text">{fmtDate(inv.date)}</span>
      <span className="w-20 shrink-0 text-xs font-medium text-text tabular-nums">
        {formatAmount(inv.amountCents, inv.currency)}
      </span>
      <span className={"rounded-full px-2 py-0.5 text-caption font-semibold " + st.cls}>{st.text}</span>
      <span className="flex-1" />
      {inv.url && (
        <a
          href={inv.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-caption font-medium text-[var(--brand)] hover:underline"
        >
          View <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </li>
  );
}
