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

/**
 * An Australian state/territory anywhere in a string. Used two ways: to decide
 * whether a location is qualified enough to trust proximity bias (see the
 * ambiguity guard in geocode), and to pull a state out of free text
 * (extractAuState).
 *
 * Abbreviations are matched case-SENSITIVELY via the alternation below because
 * lowercase "act", "nt", "sa", "wa" and "vic" are ordinary words or fragments
 * ("act now", "Vic" as a name); requiring capitals costs nothing on real ads,
 * which always write them uppercase. Full names are matched case-insensitively
 * since "Queensland" is unambiguous however it is cased.
 */
export const AU_STATE_RE =
  /\b(?:NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\b|\b(?:new\s+south\s+wales|victoria|queensland|western\s+australia|south\s+australia|tasmania|northern\s+territory|australian\s+capital\s+territory)\b/i;

// [canonical, full-name (case-insensitive), abbreviation (case-SENSITIVE)]
const STATE_CANON: Array<[string, RegExp, RegExp]> = [
  ["NSW", /\bnew\s+south\s+wales\b/i,               /\bNSW\b/ ],
  ["QLD", /\bqueensland\b/i,                        /\bQLD\b/ ],
  ["VIC", /\bvictoria\b/i,                          /\bVIC\b/ ],
  ["WA",  /\bwestern\s+australia\b/i,               /\bWA\b/  ],
  ["SA",  /\bsouth\s+australia\b/i,                 /\bSA\b/  ],
  ["TAS", /\btasmania\b/i,                          /\bTAS\b/ ],
  ["NT",  /\bnorthern\s+territory\b/i,              /\bNT\b/  ],
  ["ACT", /\baustralian\s+capital\s+territory\b/i,  /\bACT\b/ ],
];

/**
 * Pull an Australian state out of free text (a JD body, a URL slug), returning
 * the canonical abbreviation or null.
 *
 * This exists because the national aged-care boards emit BARE suburbs, which
 * the geocoder cannot place: "Birkdale" is both a Brisbane suburb and, to a
 * Sydney-biased search, a plausible local match. Where a state is recoverable
 * we append it at the source so geocoding is unambiguous; where it is not, the
 * ambiguity guard drops the job rather than guess.
 *
 * Coverage is genuinely partial — measured on the three jobs that leaked into a
 * Sydney search on 2026-08-08: Birkdale had "QLD" in the JD body only, Oxley
 * had "Queensland" in the URL slug only, and Greenbank had NO state anywhere in
 * either. That is why this is a best-effort ENRICHMENT and not the fix on its
 * own. Regis/avature pages carry no JSON-LD and no addressRegion, so there is
 * no structured field to read instead; a per-tenant facility→state table is the
 * durable answer.
 *
 * Only ONE distinct state may appear. A national provider's ad that lists
 * several ("roles across NSW, VIC and QLD") tells us nothing about THIS job, so
 * we return null rather than pick the first.
 */
/**
 * Is this Nominatim hit an actual populated place, as opposed to a street,
 * building or land parcel that merely shares the name?
 *
 * `boundary/administrative` covers gazetted suburbs and LGAs ("Randwick",
 * "Strathfield South"); the `place` class covers nodes not mapped as polygons.
 * Everything else — highway, building, landuse, amenity, shop — is a
 * same-named feature, which under proximity bias is exactly how a Queensland
 * job ends up with Sydney coordinates.
 */
export function isLocalityResult(r: { class?: string; type?: string }): boolean {
  const cls = (r.class ?? "").toLowerCase();
  const typ = (r.type ?? "").toLowerCase();
  if (cls === "boundary" && typ === "administrative") return true;
  if (cls === "place") {
    return [
      "suburb", "town", "city", "village", "hamlet", "locality",
      "neighbourhood", "quarter", "borough", "municipality", "county",
      "state", "region", "island",
    ].includes(typ);
  }
  // Missing class/type (older cached shapes, or a stubbed response) is treated
  // as a locality so the guard can only ever act on POSITIVE evidence that the
  // match is a street or building — it must not start dropping jobs wholesale
  // if the API shape changes.
  if (!cls && !typ) return true;
  return false;
}

export function extractAuState(...texts: Array<string | null | undefined>): string | null {
  // URL slugs separate words with - / _ ("Queensland-Australia-…"), so flatten
  // those to spaces before matching on word boundaries.
  const hay = texts.filter(Boolean).join(" ").replace(/[-_/]+/g, " ");
  const found = new Set<string>();
  for (const [canon, fullRe, abbrRe] of STATE_CANON) {
    if (fullRe.test(hay) || abbrRe.test(hay)) found.add(canon);
  }
  return found.size === 1 ? [...found][0] : null;
}

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
export async function geocode(
  query: string,
  countryCode: string | undefined = "au",
  near?: LatLng,
): Promise<LatLng | null> {
  // Region bias disambiguates same-named suburbs (e.g. "Killara" exists near
  // Sydney AND ~760km away). When `near` is given we PREFER results inside a box
  // around it (soft viewbox) — but do NOT hard-bound, because the aged-care
  // sources are NATIONAL: a hard box made far suburbs ("Busselton WA",
  // "Gatton QLD") either match a wrong in-box place (absurd 15km distance) or
  // return nothing (null → no distance). Soft viewbox keeps the in-box
  // preference for ambiguous bare suburbs while letting genuinely-distant,
  // state-qualified suburbs resolve to their real location.
  const biasKey = near ? `@${near.lat.toFixed(1)},${near.lng.toFixed(1)}` : "";
  const key = `${countryCode ?? "*"}${biasKey}::${query}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;

  await rateLimitNominatim();
  const url = new URL(NOMINATIM_BASE);
  const D = 1.5; // ~165km box — soft preference (no `bounded`), not a hard cap
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  // With a bias box, pull several candidates so we can PREFER an in-box one;
  // without a bias, the single best result is enough.
  url.searchParams.set("limit", near ? "10" : "1");
  if (countryCode) url.searchParams.set("countrycodes", countryCode);
  if (near) {
    url.searchParams.set("viewbox", `${near.lng - D},${near.lat - D},${near.lng + D},${near.lat + D}`);
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[distance] nominatim ${res.status} for "${query}"`);
      geocodeCache.set(key, null);
      return null;
    }
    const arr = (await res.json()) as Array<{ lat: string; lon: string; importance?: number | string; class?: string; type?: string }>;
    if (!arr.length) {
      geocodeCache.set(key, null);
      return null;
    }
    // Pick by Nominatim importance PLUS a small in-box bonus — not "any in-box
    // wins". This way an ambiguous bare suburb prefers the search-city one
    // ("Killara" → Sydney), but a genuinely-distant real place still beats a
    // spurious low-importance in-box street/POI ("Ballina"/"Yeronga"/"Mildura"
    // → their real far location, not a 19-29km Sydney mismatch).
    const IN_BOX_BONUS = 0.15;
    let chosen = arr[0];
    if (near) {
      let best = -Infinity;
      for (const r of arr) {
        const la = parseFloat(r.lat), lo = parseFloat(r.lon);
        const inBox = la >= near.lat - D && la <= near.lat + D && lo >= near.lng - D && lo <= near.lng + D;
        const imp = typeof r.importance === "number" ? r.importance : parseFloat(String(r.importance ?? "0")) || 0;
        const score = imp + (inBox ? IN_BOX_BONUS : 0);
        if (score > best) { best = score; chosen = r; }
      }

      // Locality guard. A BARE suburb from the national aged-care boards
      // cannot be trusted to a proximity-biased lookup, because the viewbox
      // biases the RESULT SET and not merely the ranking: querying "Greenbank"
      // near Sydney returns nine Sydney streets and never returns the real
      // Greenbank in Queensland at all. So there is nothing to compare against
      // and no "wrong winner" to detect — the only usable signal is WHAT the
      // match is. Real suburbs come back as administrative boundaries or place
      // nodes; the false local matches are streets, buildings and landuse:
      //   Greenbank        -> highway/tertiary, building/apartments   (street)
      //   Birkdale         -> landuse/residential                     (parcel)
      //   Strathfield South-> boundary/administrative                 (real)
      //   Randwick         -> boundary/administrative                 (real)
      // Measured against live Nominatim on 2026-08-08, after a Sydney search
      // showed Brisbane aged-care jobs at 12.5km, 43.6km and 53.4km.
      //
      // Returning null rather than the bad point is deliberate: coordinates are
      // what the bucket serve radius filters on, so a null DROPS the job while
      // a confident-but-wrong point displays a fabricated distance. Silent
      // exclusion beats silent fabrication.
      //
      // Only applies to unqualified queries under a bias. State-qualified
      // strings keep the old behaviour, which is why the location-scoped boards
      // are untouched — SEEK/Adzuna/Careerjet emit "Westmead, NSW". Where a
      // state IS recoverable we append it upstream (extractAuState) so the
      // string takes this trusted path instead of being dropped.
      if (!AU_STATE_RE.test(query) && !isLocalityResult(chosen)) {
        console.warn(
          `[distance] "${query}" resolved to ${chosen.class ?? "?"}/${chosen.type ?? "?"} ` +
          `(not a locality) under proximity bias — refusing to guess (dropping coordinates)`,
        );
        geocodeCache.set(key, null);
        return null;
      }
    }
    const hit = { lat: parseFloat(chosen.lat), lng: parseFloat(chosen.lon) };
    geocodeCache.set(key, hit);
    return hit;
  } catch (err) {
    console.warn(`[distance] nominatim error for "${query}": ${err instanceof Error ? err.message : err}`);
    geocodeCache.set(key, null);
    return null;
  }
}

// Aged-care location strings carry facility/provider/shift noise that Nominatim
// can't resolve (e.g. "Mercy Place Parkville", "Anglicare Castle Hill Villages",
// "Kilsyth Night Duty, VIC"). Stripping these exposes the bare suburb.
const PROVIDER_PREFIX =
  /^(anglicare|estia(\s+health)?|hammondcare|bolton\s+clarke|unitingcare(\s+qld)?|uniting|rsl(\s+lifecare)?|mercy(\s+place|\s+health)?|bupa(\s+aged\s+care)?|regis(\s+aged\s+care)?|opal(\s+healthcare)?|australian\s+unity|salvation\s+army|salvos|baptistcare|catholic\s+healthcare|whiddon|irt(\s+group)?|benetas|carinity)\b[\s,'-]*/i;
const FACILITY_WORDS =
  /\b(aged\s+care|care\s+community|community\s+care|nursing\s+home|retirement\s+(?:village|living)|villages?|lodge|house|gardens?|grove|court|manor|residences?|centre|center|estate|hostel|wing)\b/gi;
const SHIFT_NOISE =
  /\b(night|day|morning|afternoon|evening)\s+(?:duty|shift)\b|\b(casual|permanent|part[\s-]?time|full[\s-]?time|expressions?\s+of\s+interest|eoi|aboriginal|indigenous|torres\s+strait)\b/gi;

function cleanLocale(s: string): string {
  return s
    .replace(SHIFT_NOISE, " ")
    .replace(PROVIDER_PREFIX, "")
    .replace(FACILITY_WORDS, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,'-]+|[\s,'-]+$/g, "")
    .trim();
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
  const add = (s: string | undefined) => {
    const t = (s ?? "").trim();
    if (t.length > 1) candidates.add(t);
  };

  // 1. Whole thing — sometimes the company is a real venue (hospitals etc).
  add(raw);
  // 2. Address tail.
  add(tail);
  // 3. Strip "X Area" — Nominatim doesn't know "Manly Area" but knows Narrabeen.
  add(tail.replace(/,?\s*[A-Za-z\s]+Area\b/i, "").trim());
  // 4. Each comma segment on its own — the suburb may be ANY segment, not just
  //    the first ("St Johns Village, Glebe" → Glebe; "Woodberry, Winston Hills").
  const segs = tail.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of segs) add(s);
  // 5. Facility/provider/shift-stripped variants of the tail + each segment —
  //    exposes the bare suburb from "Mercy Place Parkville", "Anglicare
  //    Carlingford House", "Kilsyth Night Duty", etc.
  add(cleanLocale(tail));
  for (const s of segs) add(cleanLocale(s));

  return Array.from(candidates).filter(Boolean);
}

/** Try each candidate string until one geocodes. */
export async function geocodeLocation(companyLocation: string, near?: LatLng): Promise<LatLng | null> {
  for (const q of candidatesFor(companyLocation)) {
    const hit = await geocode(q, "au", near);
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
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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
  return distanceFromCoords(origin, dest);
}

/**
 * Distance from `origin` to ALREADY-GEOCODED destination coordinates. Skips the
 * Nominatim geocode entirely (the rate-limited 1.1s-gap step) — used by the
 * global-bucket serve path, where each posting's lat/lng is geocoded once at
 * write and stored on global_jobs. Only the OSRM driving call (no rate gap)
 * remains, with the usual haversine fallback.
 */
export async function distanceFromCoords(origin: LatLng, dest: LatLng): Promise<DistanceResult> {
  const driving = await drivingDistanceKm(origin, dest);
  if (driving !== null) {
    return { km: Math.round(driving * 100) / 100, method: "driving" };
  }
  const straight = haversineKm(origin, dest);
  return { km: Math.round(straight * 100) / 100, method: "haversine" };
}
