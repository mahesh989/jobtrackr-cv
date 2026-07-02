// One-off warm-start: seed global_jobs from existing `jobs` rows so the bucket
// has cross-user history on day one (otherwise it warms organically over runs).
//
// Reuses upsertGlobalJobs() so location_cell (normaliseCity), matched_keywords
// merge, and jd_access derivation are identical to the live path. Old Adzuna
// rows are treated as snippet (adzunaFull=false) — they upgrade to full when an
// unlimited user re-scrapes them.
//
// Run manually (NOT wired to any schedule):
//   USE_GLOBAL_BUCKET=true npx tsx --env-file=.env src/scripts/backfillBucket.ts
// Requires migrations 066 + 067 applied. Idempotent (ON CONFLICT url_hash).

import { db } from "../db/client.js";
import { upsertGlobalJobs, bucketEnabled, BUCKET_RETENTION_DAYS } from "../pipeline/bucket.js";
import type { NormalisedJob } from "../pipeline/types.js";

async function main() {
  if (!bucketEnabled()) {
    console.error("Refusing to run: set USE_GLOBAL_BUCKET=true to enable bucket writes.");
    process.exit(1);
  }
  const floor = new Date(Date.now() - BUCKET_RETENTION_DAYS * 86_400_000).toISOString();

  // Page through recent jobs. Group by source so adzunaFull is set per batch
  // (always false here — old data has no reliable full-JD marker).
  const PAGE = 1000;
  let from = 0;
  let total = 0;
  for (;;) {
    const { data, error } = await db
      .from("jobs")
      .select("url, url_hash, title, company, location, description, source, source_tier, posted_at, expires_at, salary_min, salary_max, sponsorship_status, citizen_pr_only, keywords_matched")
      .gte("created_at", floor)
      .neq("dedup_status", "duplicate")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) { console.error("fetch error:", error.message); process.exit(1); }
    const rows = data ?? [];
    if (rows.length === 0) break;

    const mapped: NormalisedJob[] = rows.map((r: Record<string, unknown>) => ({
      url: String(r.url),
      url_hash: String(r.url_hash),
      content_hash: "",
      title: String(r.title ?? ""),
      company: String(r.company ?? ""),
      location: String(r.location ?? ""),
      description: (r.description as string) ?? "",
      source: String(r.source ?? ""),
      source_tier: Number(r.source_tier ?? 1),
      posted_at: (r.posted_at as string) ?? null,
      expires_at: (r.expires_at as string) ?? null,
      salary_min: (r.salary_min as number) ?? undefined,
      salary_max: (r.salary_max as number) ?? undefined,
      keywords_matched: (r.keywords_matched as string[]) ?? [],
      dedup_status: "original",
      duplicate_of: null,
      repost_of: null,
      sponsorship_status: (r.sponsorship_status as NormalisedJob["sponsorship_status"]) ?? "not_mentioned",
      citizen_pr_only: (r.citizen_pr_only as boolean | null) ?? null,
      visa_extracted_text: null,
      setting_category: (r.setting_category as NormalisedJob["setting_category"]) ?? null,
      setting_confidence: (r.setting_confidence as number | null) ?? null,
      setting_evidence: (r.setting_evidence as string | null) ?? null,
      distance_km: null,
      distance_method: null,
    }));

    await upsertGlobalJobs(mapped, { adzunaFull: false });
    total += mapped.length;
    console.log(`backfilled ${total} (page from ${from})`);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Done. Seeded bucket from ${total} job rows.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
