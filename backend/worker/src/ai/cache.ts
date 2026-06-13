// AI cache — prevents re-scoring the same job+keywords combination.
// cache_key = sha256(url_hash + ":" + keywords_hash)
// keywords_hash = sha256(sorted keywords joined with comma)
import { createHash } from "crypto";
import { db } from "../db/client.js";

export interface CachedScore {
  visa_likelihood: number;
  visa_signals: string[];
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function keywordsHash(keywords: string[]): string {
  return sha256([...keywords].sort().join(","));
}

export function cacheKey(urlHash: string, kwHash: string): string {
  return sha256(`${urlHash}:${kwHash}`);
}

export async function cacheLookup(
  keys: string[]
): Promise<Map<string, CachedScore>> {
  if (keys.length === 0) return new Map();

  const { data } = await db
    .from("ai_cache")
    .select("cache_key, result_json")
    .in("cache_key", keys)
    .gt("expires_at", new Date().toISOString());

  const map = new Map<string, CachedScore>();
  for (const row of data ?? []) {
    map.set(row.cache_key as string, row.result_json as CachedScore);
  }
  return map;
}

export async function cacheWrite(
  entries: Array<{ key: string; profileId: string | null; score: CachedScore }>
): Promise<void> {
  if (entries.length === 0) return;

  const rows = entries.map((e) => ({
    cache_key: e.key,
    profile_id: e.profileId,
    result_json: e.score,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  }));

  await db.from("ai_cache").upsert(rows, {
    onConflict: "cache_key",
    ignoreDuplicates: true, // never overwrite valid cached entries
  });
}
