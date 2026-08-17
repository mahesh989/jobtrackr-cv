/**
 * Roles with elevated (founder/admin-model) platform access. Mirrors
 * frontend/web's lib/constants.ts ADMIN_ROLES — kept in sync by hand, since
 * web and worker are separate packages with no shared workspace linking.
 *
 * Single source of truth within this package: billing.ts, apifyIntegration.ts,
 * and platformSources.ts previously each hand-rolled their own copy.
 */
export const ADMIN_ROLES = ["founder", "admin"] as const;
