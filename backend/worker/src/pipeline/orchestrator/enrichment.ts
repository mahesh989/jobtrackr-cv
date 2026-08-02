import type { NormalisedJob } from "../types.js";
import { setStage } from "../runLog.js";
import { excludeByDescription, formatExcludeBreakdown } from "../postFetchFilter.js";
import { seekDirectAdapter, enrichWithDirectJDs } from "../../sources/seekDirect.js";
import { enrichCareerjetJDsViaActor } from "../../sources/careerjetActor.js";
import { enrichWithAdzunaJDs, ADZUNA_DIRECT_JD_FETCH_CAP } from "../../sources/adzuna.js";
import { enrichAdzunaJDsViaActor } from "../../sources/adzunaActor.js";
import { addApifySpend, SEEK_MONTHLY_BUDGET_USD } from "./apifyIntegration.js";
import type { FullProfile, UserIntegration, SourceMethods } from "./types.js";

/**
 * Stages 7 / 7c / 7d / 7b - full-JD enrichment for the survivors, then a
 * re-run of description exclusion against the newly-fetched full text.
 *
 *   7  SEEK JD via free direct fetch (all tiers, $0)
 *   7c Careerjet JD via Apify actor - DEAD in production (CAREERJET_ACTOR_ID
 *      is not set on the worker); moved verbatim, deliberately not restructured
 *   7d Adzuna JD via Apify actor (Unlimited) or legacy direct curl
 *   7b desc-exclusion replay, the only step here that can DROP jobs
 *
 * Mutates `sourceMethods` in place (see the contract warning on its type).
 * Returns the survivors plus how many 7b dropped, so the caller can update
 * jobsAfterDedup exactly when the original code did.
 */
export async function enrichDescriptions(
  dedupKept: NormalisedJob[],
  profile: FullProfile,
  runLogId: string,
  creds: { token: string | null; integration: UserIntegration | null },
  sourceEnabled: (name: string) => boolean,
  sourceMethods: SourceMethods,
): Promise<{ jobs: NormalisedJob[]; descDropped: number }> {
  const seekToken = creds.token;
  const seekIntegration = creds.integration;
  let descDropped = 0;
  // ── Stage 7: SEEK JD enrichment (free direct only, all tiers) ───────────────
  // Fetch full job descriptions for SEEK survivors only — i.e. jobs that have
  // already passed keyword + smart + dedup filters. Free direct path only;
  // the Apify JD-fetcher fallback has been removed (two paid actors max:
  // SEEK listings actor + Adzuna JD actor, both Unlimited-only).
  let kept = dedupKept;
  const seekSurvivors = dedupKept.some((j) => j.source === "seek");
  if (seekSurvivors) {
    await setStage(runLogId, "Fetching full SEEK descriptions");
    // No cap — every SEEK survivor gets a full JD. SEEK direct enrichment is
    // free (curl_cffi, $0), so the only cost is wall-clock; "full JD for all
    // saved jobs" matters more than shaving a few seconds.
    const jdCap = dedupKept.length;
    try {
      const { jobs: enriched, merged, fetched } = await enrichWithDirectJDs(dedupKept, jdCap);
      kept = enriched;
      sourceMethods.seek ??= { enabled: true };
      sourceMethods.seek.jd      = merged > 0 ? "direct" : "teaser";
      sourceMethods.seek.merged  = merged;
      sourceMethods.seek.fetched = fetched;
      console.log(`[pipeline] stage 7 — SEEK JD direct: ${merged}/${fetched} full descriptions merged (cost $0, cap ${jdCap})`);
    } catch (err) {
      sourceMethods.seek ??= { enabled: true };
      sourceMethods.seek.jd = "teaser";
      console.warn(`[pipeline] stage 7 — SEEK JD direct threw: ${err instanceof Error ? err.message : err}; survivors keep teasers`);
    }
  }

  // ── Stage 7c: Careerjet full-JD enrichment ─────────────────────────────────
  // The funnel's narrow+expensive half: listings came free from the v4 API;
  // now fetch full JDs for the Careerjet *survivors* via the careerjet-jd-fetcher
  // actor (residential — datacenter is Turnstile-blocked). No-ops when
  // CAREERJET_ACTOR_ID is unset or no Apify token → survivors keep the snippet.
  const careerjetSurvivors = kept.some((j) => j.source === "careerjet");
  const careerjetEnabled = sourceEnabled("careerjet");
  sourceMethods.careerjet = { enabled: careerjetEnabled, method: "api" };
  if (careerjetSurvivors && process.env.CAREERJET_ACTOR_ID && seekToken && seekIntegration) {
    await setStage(runLogId, "Fetching full Careerjet descriptions");
    try {
      const { jobs: enriched, merged, fetched, costUsd } =
        await enrichCareerjetJDsViaActor(kept, seekToken);
      kept = enriched;
      console.log(`[pipeline] stage 7c — Careerjet JD (actor): ${merged}/${fetched} full descriptions merged (cost $${costUsd.toFixed(4)})`);
      if (costUsd > 0) {
        try {
          await addApifySpend(seekIntegration.id, costUsd, SEEK_MONTHLY_BUDGET_USD, seekIntegration.quota_used_usd);
        } catch (e) {
          console.warn(`[pipeline] careerjet spend update failed (non-fatal): ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (err) {
      console.warn(`[pipeline] stage 7c — Careerjet JD threw: ${err instanceof Error ? err.message : err}`);
    }
  } else if (careerjetSurvivors) {
    console.log(`[pipeline] stage 7c — Careerjet JD: skipped (CAREERJET_ACTOR_ID unset or no Apify token) — keeping v4 API snippet`);
  }

  // ── Stage 7d: Adzuna full-JD enrichment (Unlimited only, via adzuna_method) ──
  // 'api' → skip; teasers (~600 chars) carry forward.
  // 'direct' + ADZUNA_ACTOR_ID + Apify token → fetch full JDs via the
  //   adzuna-jd-fetcher actor on residential proxy (Unlimited tier only).
  // 'direct' without actor → legacy curl-from-Fly path (rate-limited in prod;
  //   kept for local-dev only).
  const adzunaSurvivors = kept.some((j) => j.source === "adzuna");
  const useAdzunaDirect = profile.adzuna_method === "direct";
  const adzunaEnabled = sourceEnabled("adzuna");
  sourceMethods.adzuna = { enabled: adzunaEnabled, method: profile.adzuna_method ?? "api" };
  if (adzunaSurvivors && useAdzunaDirect && process.env.ADZUNA_ACTOR_ID && seekToken && seekIntegration) {
    await setStage(runLogId, "Fetching full Adzuna descriptions");
    try {
      const { jobs: enriched, merged, fetched, costUsd } =
        // No per-run cap — full JD for every Adzuna survivor. The monthly
        // SEEK_MONTHLY_BUDGET_USD guard below bounds total actor spend, and
        // Adzuna survivors per run are few (most lose dedup to SEEK/agedcare).
        await enrichAdzunaJDsViaActor(kept, seekToken, kept.length);
      kept = enriched;
      sourceMethods.adzuna.enrichment = "actor";
      sourceMethods.adzuna.merged     = merged;
      sourceMethods.adzuna.fetched    = fetched;
      console.log(`[pipeline] stage 7d — Adzuna JD (actor): ${merged}/${fetched} full descriptions merged (cost $${costUsd.toFixed(4)})`);
      if (costUsd > 0) {
        try {
          await addApifySpend(seekIntegration.id, costUsd, SEEK_MONTHLY_BUDGET_USD, seekIntegration.quota_used_usd);
        } catch (e) {
          console.warn(`[pipeline] adzuna spend update failed (non-fatal): ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (err) {
      sourceMethods.adzuna.enrichment = "actor_failed_teaser";
      console.warn(
        `[pipeline] stage 7d — Adzuna JD actor failed (${err instanceof Error ? err.message : err}); ` +
        `falling back to API teasers (no full-JD enrichment this run)`,
      );
    }
  } else if (adzunaSurvivors && useAdzunaDirect) {
    await setStage(runLogId, "Fetching full Adzuna descriptions");
    // Capped, unlike the actor branch. This path curls adzuna.com.au straight
    // from the Fly IP with a 2.5s inter-request delay and no residential
    // proxy, so an uncapped survivor list is both slow (25min+ for ~500) and
    // the exact traffic pattern that gets the IP 429'd.
    const jdCap = ADZUNA_DIRECT_JD_FETCH_CAP;
    try {
      const { jobs: enriched, merged, fetched } = await enrichWithAdzunaJDs(kept, jdCap);
      kept = enriched;
      sourceMethods.adzuna.enrichment = "direct_curl";
      sourceMethods.adzuna.merged     = merged;
      sourceMethods.adzuna.fetched    = fetched;
      console.log(`[pipeline] stage 7d — Adzuna JD (direct curl): ${merged}/${fetched} full descriptions merged (cost $0, cap ${jdCap})`);
    } catch (err) {
      sourceMethods.adzuna.enrichment = "direct_curl_failed_teaser";
      console.warn(`[pipeline] stage 7d — Adzuna JD direct threw: ${err instanceof Error ? err.message : err}`);
    }
  } else if (adzunaSurvivors) {
    sourceMethods.adzuna.enrichment = "none";
    console.log(`[pipeline] stage 7d — Adzuna JD: skipped (adzuna_method='api', using API teasers only)`);
  }

  // Adzuna only contributes new desc text to re-scan when 'direct' mode
  // actually enriched something — under 'api' mode the teaser is unchanged
  // and we'd just re-run the same scan stage 4c did.
  const adzunaEnriched = adzunaSurvivors && useAdzunaDirect;
  if (seekSurvivors || careerjetSurvivors || adzunaEnriched) {
    // ── Stage 7b: re-run desc-exclusion against the FULL JD ────────────────
    // The first pass at stage 4c could only see teasers for SEEK. Now that we
    // have full JDs, dropped phrases that lived deep in the description are
    // catchable.
    const { kept: afterDesc, dropped: droppedNow, byPhrase: descByPhrase } = excludeByDescription(kept, profile);
    if (droppedNow > 0) {
      console.log(`[pipeline] stage 7b — desc-exclusion against full JD: ${droppedNow} dropped, ${afterDesc.length} remain${formatExcludeBreakdown(descByPhrase)}`);
      if (afterDesc.length === 0) {
        console.warn(
          `[pipeline] ⚠ stage 7b dropped ALL remaining jobs against the full JD — ` +
          `your "Description must NOT contain"${formatExcludeBreakdown(descByPhrase)} is matching every survivor.`,
        );
      }
      kept = afterDesc;
      descDropped = droppedNow;
    }
  }

  return { jobs: kept, descDropped };
}
