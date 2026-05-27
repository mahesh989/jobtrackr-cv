/**
 * distance.ts — geocode + driving-distance helpers.
 *
 * Free-tier only:
 *   - Nominatim public instance for geocoding (1 req/sec, requires User-Agent).
 *   - OSRM public demo server for driving routes (low-volume only).
 *   - Haversine straight-line as the safety net when OSRM returns no route.
 *
 * Pipeline usage: one call per saved job per run. The process-lifetime cache
 * dedupes within a run; downstream the result is persisted on the job row so
 * subsequent runs don't re-geocode the same location.
 */
import { setTimeout as sleep } from "node:timers/promises";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const USER_AGENT = "jobtrackr-cv/1.0 (job-distance)";
const NOMINATIM_GAP_MS = 1100;  // ≥1s between hits — Nominatim public tier
const REQUEST_TIMEOUT_MS = 8000;

export interface LatLng { lat: number; lng: number; }

/** Result of resolving a location string to a driving distance. */
export interface DistanceResult {
  /** Distance in kilometres, rounded to two decimals. */
  km: number;
  /** 'driving' = OSRM route. 'haversine' = straight-line fallback. */
  method: "driving" | "haversine";
}

// ── In-process caches ───────────────────────────────────────────────────────
// Both are reset per worker process. Negative results cached as null to avoid
// re-querying known-bad strings in the same run.
const geocodeCache = new Map<string, LatLng | null>();
let lastNominatimAt = 0;

// ── Nominatim ───────────────────────────────────────────────────────────────

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => ctrl.signal.addEventListener("abort", () => rej(new Error("timeout")))),
    ]);
  } finally {
    clearTimeout(t);
  }
}

async function rateLimitNominatim(): Promise<void> {
  const wait = lastNominatimAt + NOMINATIM_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatimAt = Date.now();
}

/**
 * Geocode a free-text location string. Returns null if Nominatim has no hit.
 *
 * `countryCode` biases results — default 'au'. Pass undefined to search globally.
 */
export async function geocode(query: string, countryCode: string | undefined = "au"): Promise<LatLng | null> {
  const key = `${countryCode ?? "*"}::${query}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;

  await rateLimitNominatim();
  const url = new URL(NOMINATIM_BASE);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  if (countryCode) url.searchParams.set("countrycodes", countryCode);

  try {
    const res = await withTimeout(
      fetch(url.toString(), { headers: { "User-Agent": USER_AGENT, "Accept": "application/json" } }),
      REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) {
      console.warn(`[distance] nominatim ${res.status} for "${query}"`);
      geocodeCache.set(key, null);
      return null;
    }
    const arr = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!arr.length) {
      geocodeCache.set(key, null);
      return null;
    }
    const hit = { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
    geocodeCache.set(key, hit);
    return hit;
  } catch (err) {
    console.warn(`[distance] nominatim error for "${query}": ${err instanceof Error ? err.message : err}`);
    geocodeCache.set(key, null);
    return null;
  }
}

/**
 * Build candidate query strings from a raw `company · suburb, area` location,
 * ordered from most specific to most generic. We stop at the first one
 * Nominatim resolves.
 */
export function candidatesFor(companyLocation: string): string[] {
  const raw = (companyLocation ?? "").trim();
  if (!raw) return [];

  // "Contract Care · Narrabeen, Manly Area" → after the dot we have the address.
  const dotSplit = raw.split(/\s+[·•]\s+/);
  const tail = dotSplit.length > 1 ? dotSplit.slice(1).join(" ") : raw;
  const candidates = new Set<string>();

  // 1. Whole thing — sometimes the company is a real venue (hospitals etc).
  candidates.add(raw);
  // 2. Address tail.
  candidates.add(tail);
  // 3. Strip "X Area" — Nominatim doesn't know "Manly Area" but knows Narrabeen.
  const noArea = tail.replace(/,?\s*[A-Za-z\s]+Area\b/i, "").trim();
  if (noArea) candidates.add(noArea);
  // 4. First suburb only.
  const firstSuburb = tail.split(",")[0]?.trim();
  if (firstSuburb) candidates.add(firstSuburb);

  return Array.from(candidates).filter(Boolean);
}

/** Try each candidate string until one geocodes. */
export async function geocodeLocation(companyLocation: string): Promise<LatLng | null> {
  for (const q of candidatesFor(companyLocation)) {
    const hit = await geocode(q);
    if (hit) return hit;
  }
  return null;
}

// ── OSRM ────────────────────────────────────────────────────────────────────

/** Driving distance in km via OSRM public demo. null if no route or error. */
export async function drivingDistanceKm(a: LatLng, b: LatLng): Promise<number | null> {
  const coords = `${a.lng},${a.lat};${b.lng},${b.lat}`;
  const url = `${OSRM_BASE}/${coords}?overview=false`;
  try {
    const res = await withTimeout(
      fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept": "application/json" } }),
      REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { code?: string; routes?: Array<{ distance: number }> };
    if (data.code !== "Ok" || !data.routes?.length) return null;
    return data.routes[0].distance / 1000;
  } catch (err) {
    console.warn(`[distance] osrm error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── Haversine ───────────────────────────────────────────────────────────────

/** Great-circle distance in km. Used when OSRM has no route. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ── High-level ──────────────────────────────────────────────────────────────

/**
 * Compute the distance between `origin` and a job's location string.
 * Returns null if the location can't be geocoded.
 */
export async function distanceFor(origin: LatLng, companyLocation: string): Promise<DistanceResult | null> {
  const dest = await geocodeLocation(companyLocation);
  if (!dest) return null;

  const driving = await drivingDistanceKm(origin, dest);
  if (driving !== null) {
    return { km: Math.round(driving * 100) / 100, method: "driving" };
  }
  // OSRM had no route (e.g. islands, malformed input) — fall back to straight line.
  const straight = haversineKm(origin, dest);
  return { km: Math.round(straight * 100) / 100, method: "haversine" };
}
