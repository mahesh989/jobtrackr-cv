/**
 * Filename-safe slug (non-alphanumeric → underscore). For display/DB-key
 * slugs that must match backend/api/app/services/company/slug.py, use the
 * local makeCompanySlug in app/api/jobs/[id]/cover-letter/route.ts instead —
 * that one lowercases and collapses runs, this one doesn't.
 */
export function filenameSlug(name: string | null | undefined, fallback = "company"): string {
  return (name ?? fallback).replace(/[^a-zA-Z0-9]/g, "_");
}
