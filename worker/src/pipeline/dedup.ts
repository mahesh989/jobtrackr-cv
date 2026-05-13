// Stage 5–6 — Dedup engine
//
// L1 (url_hash)      : exact URL collision → drop. Catches same-source re-scrapes.
// L2-strong          : title + city + company-prefix all match → drop loser, keep best.
//                      Catches the cross-source case (SEEK + Adzuna + Jora finding
//                      the same role at the same employer in the same city).
// L2-weak (flag)     : title + company-shortcode match BUT city differs → keep both,
//                      mark loser as `possible_duplicate` so UI can show a pill
//                      with a Hide action. Catches genuine multi-branch listings.
//
// Existing rows in the `jobs` table for this profile participate in the bucket
// so cross-run dedup also works.

import { createHash } from "crypto";
import type { NormalisedJob } from "./types.js";
import { db } from "../db/client.js";
import {
  normaliseTitle,
  normaliseCity,
  normaliseCompany,
  companiesMatch,
  companyShortcode,
  bucketKey,
} from "./normalise/keys.js";
import { scoreJob } from "./normalise/winner.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function computeHashes(job: NormalisedJob): NormalisedJob {
  // content_hash kept for backwards compatibility with downstream stages
  // (visa extraction, save). It's no longer the dedup key — bucketKey is.
  const fp = `${normaliseTitle(job.title)}|${normaliseCity(job.location)}|${normaliseCompany(job.company)}`;
  return {
    ...job,
    url_hash:     sha256(job.url),
    content_hash: sha256(fp),
  };
}

// Minimal existing-job shape needed for dedup bucketing
interface ExistingJob {
  id:       string;
  url_hash: string;
  title:    string;
  company:  string;
  location: string;
  source:   string;
  description?: string | null;
}

async function fetchExistingJobsForProfile(profileId: string): Promise<ExistingJob[]> {
  const { data } = await db
    .from("jobs")
    .select("id, url_hash, title, company, location, source, description")
    .eq("profile_id", profileId)
    .neq("dedup_status", "duplicate")  // already-dropped rows shouldn't influence new dedup
    .limit(5000);
  return (data ?? []) as ExistingJob[];
}

export interface DedupResult {
  kept:           NormalisedJob[];   // pass to next stage (may include possible_duplicate)
  l1Dropped:      number;
  l2Dropped:      number;            // hard drops (strong match within same city)
  l2WeakMarked:   number;            // saved but flagged as possible_duplicate
}

export async function dedup(
  jobs:      NormalisedJob[],
  profileId: string
): Promise<DedupResult> {
  // ── Stage A: L1 url_hash dedup ───────────────────────────────────────────────
  const existing = await fetchExistingJobsForProfile(profileId);
  const existingByUrlHash = new Set(existing.map((e) => e.url_hash));

  const hashed = jobs.map(computeHashes);
  const seenUrlHash = new Set<string>();
  const candidates: NormalisedJob[] = [];
  let l1Dropped = 0;

  for (const j of hashed) {
    if (existingByUrlHash.has(j.url_hash) || seenUrlHash.has(j.url_hash)) {
      l1Dropped++;
      continue;
    }
    seenUrlHash.add(j.url_hash);
    candidates.push(j);
  }

  // Build universe for bucketing: new candidates + existing rows for this profile.
  // Existing rows are read-only — they help us spot duplicates that span runs but
  // we never drop or mark them.
  type Member =
    | { kind: "new"; job: NormalisedJob }
    | { kind: "existing"; job: ExistingJob };

  const universe: Member[] = [
    ...candidates.map((j) => ({ kind: "new" as const,      job: j })),
    ...existing  .map((j) => ({ kind: "existing" as const, job: j })),
  ];

  // ── Stage B: L2-strong — same title + city + company prefix → drop loser ─────
  const dropSet = new Set<string>();    // url_hashes of NEW candidates to drop
  let l2Dropped = 0;

  const strongBuckets = new Map<string, Member[]>();
  for (const m of universe) {
    const k = bucketKey(m.job.title, m.job.location);
    if (!k.includes("|")) continue;
    const list = strongBuckets.get(k);
    if (list) list.push(m); else strongBuckets.set(k, [m]);
  }

  for (const bucket of strongBuckets.values()) {
    if (bucket.length < 2) continue;
    // Within bucket: partition into company-prefix groups
    const groups: Member[][] = [];
    for (const m of bucket) {
      const cn = normaliseCompany(m.job.company);
      if (!cn) continue;
      const home = groups.find((g) =>
        companiesMatch(cn, normaliseCompany(g[0].job.company))
      );
      if (home) home.push(m); else groups.push([m]);
    }

    for (const group of groups) {
      if (group.length < 2) continue;
      // Pick winner by score (existing rows score the same way)
      const scored = group.map((m) => ({ m, s: scoreOf(m) })).sort((a, b) => b.s - a.s);
      const winner = scored[0].m;
      for (const { m } of scored.slice(1)) {
        if (m.kind === "new" && m.job.url_hash !== winner.job.url_hash) {
          dropSet.add(m.job.url_hash);
          l2Dropped++;
        }
      }
    }
  }

  // ── Stage C: L2-weak — same title + company shortcode, different city → mark ─
  const weakBuckets = new Map<string, Member[]>();
  for (const m of universe) {
    if (m.kind === "new" && dropSet.has(m.job.url_hash)) continue; // already dropped
    const code = companyShortcode(m.job.company);
    if (!code) continue;
    const k = `${normaliseTitle(m.job.title)}|${code}`;
    const list = weakBuckets.get(k);
    if (list) list.push(m); else weakBuckets.set(k, [m]);
  }

  const possibleDupeHashes = new Set<string>();
  let l2WeakMarked = 0;

  for (const bucket of weakBuckets.values()) {
    if (bucket.length < 2) continue;
    // Multiple cities? If yes, mark all-but-top as possible_duplicate
    const cities = new Set(bucket.map((m) => normaliseCity(m.job.location)));
    if (cities.size < 2) continue;

    const scored = bucket.map((m) => ({ m, s: scoreOf(m) })).sort((a, b) => b.s - a.s);
    const winnerCity = normaliseCity(scored[0].m.job.location);
    for (const { m } of scored.slice(1)) {
      if (m.kind !== "new") continue;
      if (normaliseCity(m.job.location) === winnerCity) continue;
      if (dropSet.has(m.job.url_hash)) continue;
      possibleDupeHashes.add(m.job.url_hash);
      l2WeakMarked++;
    }
  }

  // ── Build result ─────────────────────────────────────────────────────────────
  const kept = candidates
    .filter((j) => !dropSet.has(j.url_hash))
    .map((j) =>
      possibleDupeHashes.has(j.url_hash)
        ? { ...j, dedup_status: "possible_duplicate" as const }
        : j
    );

  return { kept, l1Dropped, l2Dropped, l2WeakMarked };
}

function scoreOf(m: { kind: "new"; job: NormalisedJob } | { kind: "existing"; job: ExistingJob }): number {
  if (m.kind === "new") return scoreJob(m.job);
  // Existing rows: minimal info, use a simplified scorer
  const desc = (m.job.description ?? "").length;
  const src  = m.job.source;
  const srcBonus =
    src === "seek"        ? 2000 :
    src === "greenhouse"  ? 1500 :
    src === "lever"       ? 1500 :
    src === "adzuna"      ?  400 :
    src === "jora"        ?  100 : 0;
  return Math.min(desc, 5000) + srcBonus;
}
