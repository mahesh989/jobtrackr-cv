// Pipeline orchestrator — runs all stages in order for a given profile.
//
// Stage  0: profile loaded
// Stage  1: run log created (status=running)
// Stage  2: source layer — parallel adapter calls
// Stage  3: normalise
// Stage  4: keyword pre-filter
// Stage  5: dedup L1 (url hash)
// Stage  6: dedup L2 (content fingerprint)
// Stage  7: dedup L3 FLAGGED OFF (DEDUP_L3_ENABLED=false)
// Stage  8: dedup L4 repost — placeholder
// Stage  9: expiry check (inside save)
// Stage 10: visa extraction — regex-first, AI fallback for ambiguous (gpt-4o-mini or claude-haiku)
// Stage 11: active link validation — HEAD requests top 50
// Stage 11b: distance — Nominatim geocode + OSRM driving distance per survivor
// Stage 12: idempotent upsert
// Stage 13: notify — Phase 6

export { runPipeline } from "./runPipeline.js";
