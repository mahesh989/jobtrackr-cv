/**
 * ⚠️  DUMMY_DATA — REMOVE THIS ENTIRE FILE WHEN REAL DATA FLOWS
 *
 * This module supplies placeholder data for admin pages whose underlying
 * instrumentation is not yet wired (Stripe webhooks, cohort tracking, etc.).
 *
 * Pages importing this module:
 *   • /admin/revenue   — MRR trend, billing events log
 *   • /admin/retention — cohort retention grid, DAU/WAU/MAU
 *   • /admin/sourcing  — per-source availability badges
 *   • /admin/audit     — sample audit log rows
 *
 * How to remove per-section:
 *   Revenue trend     → replace with real Stripe webhook history from stripe_events
 *   Billing events    → replace with real rows from stripe_events table
 *   Cohort grid       → replace with real cohort query grouping users by signup month
 *   DAU/WAU/MAU       → replace with real distinct-user counts from user_events
 *   Source status     → replace with real last-run-per-source from run_logs
 *   Audit rows        → remove entirely — admin_audit_log will populate as admins act
 *
 * Search for "DUMMY_DATA" in page files to locate every usage site.
 */

// ── Revenue: MRR trend (last 12 months) ─────────────────────────────────────
// DUMMY_DATA: replace with Stripe invoice history once webhooks are wired.
export const DUMMY_MRR_TREND: Array<{ month: string; mrr: number; newMrr: number; churnedMrr: number }> = [
  { month: "Jul 25",  mrr:    0, newMrr:    0, churnedMrr: 0 },
  { month: "Aug 25",  mrr:    0, newMrr:    0, churnedMrr: 0 },
  { month: "Sep 25",  mrr:    0, newMrr:    0, churnedMrr: 0 },
  { month: "Oct 25",  mrr:    0, newMrr:    0, churnedMrr: 0 },
  { month: "Nov 25",  mrr:    0, newMrr:    0, churnedMrr: 0 },
  { month: "Dec 25",  mrr:    0, newMrr:    0, churnedMrr: 0 },
  { month: "Jan 26",  mrr:  500, newMrr:  500, churnedMrr: 0 },
  { month: "Feb 26",  mrr: 1498, newMrr:  998, churnedMrr: 0 },
  { month: "Mar 26",  mrr: 2497, newMrr: 1499, churnedMrr: 500 },
  { month: "Apr 26",  mrr: 3495, newMrr: 2496, churnedMrr: 1498 },
  { month: "May 26",  mrr: 4993, newMrr: 2496, churnedMrr: 998 },
  { month: "Jun 26",  mrr: 6490, newMrr: 2495, churnedMrr: 998 },
];

// ── Revenue: billing events feed ────────────────────────────────────────────
// DUMMY_DATA: replace with rows from stripe_events table once Stripe webhooks land.
export const DUMMY_BILLING_EVENTS: Array<{
  id: string; type: string; user: string; plan: string;
  amount: number; ts: string; status: "ok" | "failed";
}> = [
  { id: "evt_001", type: "subscription.created",    user: "alice@example.com",   plan: "monthly",  amount: 2499, ts: "2026-06-09T10:12:00Z", status: "ok" },
  { id: "evt_002", type: "payment.succeeded",        user: "alice@example.com",   plan: "monthly",  amount: 2499, ts: "2026-06-09T10:12:05Z", status: "ok" },
  { id: "evt_003", type: "subscription.created",    user: "bob@example.com",     plan: "weekly",   amount:  999, ts: "2026-06-08T15:44:00Z", status: "ok" },
  { id: "evt_004", type: "payment.failed",           user: "carol@example.com",   plan: "monthly",  amount: 2499, ts: "2026-06-07T09:01:00Z", status: "failed" },
  { id: "evt_005", type: "subscription.canceled",   user: "dave@example.com",    plan: "weekly",   amount:    0, ts: "2026-06-06T18:20:00Z", status: "ok" },
  { id: "evt_006", type: "subscription.updated",    user: "eve@example.com",     plan: "unlimited", amount: 4999, ts: "2026-06-05T11:00:00Z", status: "ok" },
  { id: "evt_007", type: "trial_will_end",          user: "frank@example.com",   plan: "trial",    amount:    0, ts: "2026-06-04T08:30:00Z", status: "ok" },
];

// ── Retention: cohort retention grid ────────────────────────────────────────
// DUMMY_DATA: replace with real cohort query once there are ≥3 months of users.
// Format: cohortMonth → [% retained at M+0, M+1, M+2, M+3, M+4, M+5]
export const DUMMY_COHORT: Array<{ label: string; users: number; retention: number[] }> = [
  { label: "Jan 26", users:  8, retention: [100, 87, 75, 62, 50, 50] },
  { label: "Feb 26", users: 14, retention: [100, 85, 71, 57, 50,  -1] },
  { label: "Mar 26", users: 22, retention: [100, 81, 68, 55,  -1, -1] },
  { label: "Apr 26", users: 31, retention: [100, 83, 70,  -1, -1, -1] },
  { label: "May 26", users: 28, retention: [100, 78,  -1, -1, -1, -1] },
  { label: "Jun 26", users: 19, retention: [100,  -1, -1, -1, -1, -1] },
];

// ── Retention: DAU / WAU / MAU ───────────────────────────────────────────────
// DUMMY_DATA: replace with real distinct-user counts from user_events table.
export const DUMMY_DAU_WAU_MAU = { dau: 4, wau: 18, mau: 47 };

// ── Sourcing: per-source last-seen status ────────────────────────────────────
// DUMMY_DATA: replace with a real query for max(started_at) per source from run_logs.
export const DUMMY_SOURCE_STATUS: Array<{ source: string; lastSeen: string; status: "ok" | "degraded" | "down" }> = [
  { source: "seek",      lastSeen: "2026-06-10T06:12:00Z", status: "ok" },
  { source: "adzuna",    lastSeen: "2026-06-10T06:14:00Z", status: "ok" },
  { source: "careerjet", lastSeen: "2026-06-10T04:50:00Z", status: "degraded" },
  { source: "jora",      lastSeen: "2026-05-18T09:00:00Z", status: "down" },
];

// ── Audit log: sample rows ───────────────────────────────────────────────────
// DUMMY_DATA: remove entirely once admin_audit_log table is being written to.
// The table exists (migration 055) but nothing writes to it yet. Add
// insert calls to admin actions (invite generation, role changes, etc.)
// to populate it with real data.
export const DUMMY_AUDIT_ROWS: Array<{
  id: string; admin: string; action: string;
  targetType: string; targetId: string; metadata: Record<string, unknown>; ts: string;
}> = [
  { id: "a1", admin: "founder@example.com", action: "invite.generate",   targetType: "invite", targetId: "BETA-001", metadata: {},                                ts: "2026-06-09T14:22:00Z" },
  { id: "a2", admin: "founder@example.com", action: "user.role_changed",  targetType: "user",   targetId: "user-abc", metadata: { from: "beta", to: "comp" },      ts: "2026-06-08T10:11:00Z" },
  { id: "a3", admin: "founder@example.com", action: "invite.revoke",      targetType: "invite", targetId: "BETA-002", metadata: {},                                ts: "2026-06-07T18:05:00Z" },
  { id: "a4", admin: "founder@example.com", action: "run.cancel",         targetType: "run",    targetId: "run-xyz",  metadata: { reason: "stuck >30min" },        ts: "2026-06-06T09:30:00Z" },
  { id: "a5", admin: "founder@example.com", action: "subscription.comp",  targetType: "user",   targetId: "user-def", metadata: { plan: "comp", days: 14 },        ts: "2026-06-05T16:44:00Z" },
];
