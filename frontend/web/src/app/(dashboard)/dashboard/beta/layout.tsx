import { requireAdmin } from "@/lib/admin/guard";

/**
 * The /dashboard/beta/* routes are internal QA / experiment tooling (skills &
 * summary audits, source-eval, model comparison, redesign prototypes). They are
 * intentionally unlinked from the nav, but until now any logged-in user could
 * reach them by typing the URL — exposing AI internals and experiments.
 *
 * This layout gates the entire beta subtree behind the founder/admin role with
 * the same guard the /admin section uses. Non-admins are redirected to
 * /dashboard. One file protects all beta routes.
 */
export default async function BetaLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin(); // redirects non-founder/admin to /dashboard
  return <>{children}</>;
}
