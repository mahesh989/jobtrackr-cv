// Stage 11 — Active link validation
// HEAD requests on top-N jobs ranked by AI score.
// Marks is_dead_link=true for 4xx/5xx or timeout.
// Only checks top 50 to cap outbound requests per run.
import { db } from "../db/client.js";

const TOP_N          = 50;
const TIMEOUT_MS     = 5_000;
const CONCURRENCY    = 10; // parallel HEAD requests

type JobRow = { id: string; url: string; source: string };

async function checkLink(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET", // Some bot protections block HEAD
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
    });
    // Cloudflare might return 403, if so we assume it's alive but protected
    if (res.status === 403 || res.status === 401) return true;
    return res.ok; // true = alive
  } catch {
    return false; // timeout or network error = treat as dead
  }
}

async function runWithConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  limit: number
): Promise<void> {
  let i = 0;
  async function next(): Promise<void> {
    if (i >= items.length) return;
    const item = items[i++];
    await fn(item);
    await next();
  }
  await Promise.all(Array.from({ length: limit }, next));
}

export async function validateLinks(profileId: string): Promise<{ checked: number; deadFound: number }> {
  // Fetch top-N by created_at, not yet validated this run
  const { data } = await db
    .from("jobs")
    .select("id, url, source")
    .eq("profile_id", profileId)
    .eq("is_dead_link", false)
    .eq("is_expired", false)
    .order("created_at", { ascending: false })
    .limit(TOP_N);

  const jobs: JobRow[] = (data ?? []) as JobRow[];
  if (jobs.length === 0) return { checked: 0, deadFound: 0 };

  let deadFound = 0;
  const deadIds: string[] = [];

  await runWithConcurrency(
    jobs,
    async (job) => {
      // Adzuna links are from API and protected by CF, skip validation
      if (job.source === "adzuna") return;
      
      const alive = await checkLink(job.url);
      if (!alive) {
        deadIds.push(job.id);
        deadFound++;
      }
    },
    CONCURRENCY
  );

  // Bulk-mark dead links
  if (deadIds.length > 0) {
    await db
      .from("jobs")
      .update({ is_dead_link: true })
      .in("id", deadIds);
  }

  console.log(`[linkValidator] checked ${jobs.length}, dead: ${deadFound}`);
  return { checked: jobs.length, deadFound };
}
