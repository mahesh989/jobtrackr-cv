/**
 * Shallow URL update — changes the query string via the native History API so
 * Next's `useSearchParams` updates client-side WITHOUT a server round-trip
 * (the documented App Router pattern for client-side filter/sort). Components
 * reading useSearchParams re-render instantly; the RSC server component is NOT
 * re-fetched.
 *
 * Used by the dashboard board's view filters (stage / triage / ATS / sort /
 * keywords / visa) so filtering feels instant. Dataset-narrowing filters
 * (location / time / source / dismissed) keep using the real router because
 * they change which jobs are fetched server-side.
 */
export function shallowSetParams(pathname: string, params: URLSearchParams): void {
  if (typeof window === "undefined") return;
  const qs = params.toString();
  window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
}
