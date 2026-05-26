"use client";

// Source-coverage beta UI.
//
// Input form (free-form keywords / location / posted-within window) +
// per-source result cards + cross-source overlap summary + sample titles.
//
// Polls /api/source-eval/[id] every 2s until the row hits status =
// completed | failed (sources are processed concurrently on the worker so
// most cards arrive within 30-90s of Start).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SOURCES = [
  { key: "adzuna",      label: "Adzuna",        note: "Free public API" },
  { key: "seek_direct", label: "SEEK (direct)", note: "got-scraping — free, primary path" },
  { key: "seek_apify",  label: "SEEK (Apify)",  note: "Actor — needs Apify integration" },
  { key: "careerjet",   label: "Careerjet",     note: "Free public API + JD enrichment" },
  { key: "greenhouse",  label: "Greenhouse",    note: "Public ATS — full JD inline" },
  { key: "lever",       label: "Lever",         note: "Public ATS — full JD inline" },
] as const;

type SourceKey = (typeof SOURCES)[number]["key"];

interface Counts {
  fetched:         number;
  after_url_dedup: number;
  after_keyword:   number;
  after_smart:     number;
  after_dedup:     number;
  would_save:      number;
  full_jd:         number;
  thin_jd:         number;
}

interface Sample {
  title:     string;
  company:   string;
  location:  string;
  url:       string;
  url_hash:  string;
  posted_at: string | null;
  full_jd:   boolean;
  desc_len:  number;
}

interface IntegrationDiag {
  provider:    string;
  present:     boolean;
  is_enabled?: boolean;
  status?:     string;
  reason?:     string;
}

interface Diagnostics {
  env:          Record<string, boolean>;
  integration?: IntegrationDiag;
  logs:         string[];
}

interface SourceResult {
  status:           "pending" | "running" | "done" | "error";
  error?:           string;
  note?:            string;
  started_at?:      string;
  finished_at?:     string;
  timing_ms?:       { fetch: number; dedup: number; jd_enrich: number };
  counts?:          Counts;
  samples?:         Sample[];
  kept_url_hashes?: string[];
  jd_enrich?:       { fetched: number; merged: number; cost_usd: number };
  diagnostics?:     Diagnostics;
}

interface RecentItem {
  id:                 string;
  keywords:           string[];
  location:           string | null;
  posted_within_days: number;
  sources_requested:  string[];
  status:             "running" | "completed" | "failed";
  unique_total:       number | null;
  created_at:         string;
  finished_at:        string | null;
}

interface EvalRow {
  id:                  string;
  keywords:            string[];
  location:            string | null;
  posted_within_days:  number;
  sources_requested:   string[];
  status:              "running" | "completed" | "failed";
  results:             Record<string, SourceResult>;
  unique_total:        number | null;
  overlap:             Record<string, string[]> | null;
  created_at:          string;
  finished_at:         string | null;
}

function emptyCounts(): Counts {
  return {
    fetched: 0, after_url_dedup: 0, after_keyword: 0, after_smart: 0,
    after_dedup: 0, would_save: 0, full_jd: 0, thin_jd: 0,
  };
}

function fmtMs(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function SourceEvalClient() {
  // ── Form state ────────────────────────────────────────────────────────────
  const [keywords, setKeywords] = useState("Data Analyst");
  const [location, setLocation] = useState("Sydney NSW");
  const [days, setDays]         = useState(14);
  const [distanceKm, setDistanceKm] = useState(50);
  // Optional smart filter — comma-separated. Empty = trust each source's
  // own search. When set, drop jobs whose title+description doesn't contain
  // any of these phrases.
  const [mustInclude, setMustInclude] = useState("");
  const [selected, setSelected] = useState<Set<SourceKey>>(
    new Set(SOURCES.map((s) => s.key))
  );

  // Mirror of the worker's normaliser — strip ", Australia", postcode, state
  // suffix. Shown under the location input so the user can see what each
  // adapter will actually receive.
  const normalisedLocation = useMemo(() => {
    let loc = location.trim();
    loc = loc.replace(/[,\s]+australia\s*$/i, "").trim();
    loc = loc.replace(/[,\s]+\d{4}\b/, "").trim();
    loc = loc.replace(
      /[,\s]+(NSW|VIC|QLD|WA|SA|TAS|NT|ACT|New South Wales|Victoria|Queensland|Western Australia|South Australia|Tasmania|Northern Territory|Australian Capital Territory)\b/i,
      "",
    ).trim();
    return loc.replace(/[,\s]+$/, "").trim();
  }, [location]);

  // ── Eval state ────────────────────────────────────────────────────────────
  const [evalId, setEvalId]   = useState<string | null>(null);
  const [row, setRow]         = useState<EvalRow | null>(null);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [recent, setRecent]   = useState<RecentItem[]>([]);
  const pollTimer             = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirror the current eval id into ?id=<uuid> via the History API so a refresh
  // doesn't lose context. Pop state (back/forward) re-hydrates.
  const writeIdToUrl = (id: string | null) => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (id) u.searchParams.set("id", id);
    else    u.searchParams.delete("id");
    window.history.replaceState(null, "", u.toString());
  };

  // ── Initial hydrate from URL ?id= ─────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = new URL(window.location.href).searchParams.get("id");
    if (id) {
      setEvalId(id);
      setBusy(true);  // poll will flip this off when status terminal
    }
  }, []);

  // ── Recent evals (last 10) ───────────────────────────────────────────────
  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/source-eval/list?limit=10");
      if (!res.ok) return;
      const body = await res.json();
      setRecent(body.items ?? []);
    } catch { /* swallow — non-critical */ }
  }, []);
  useEffect(() => { void loadRecent(); }, [loadRecent]);

  const toggle = (k: SourceKey) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const start = useCallback(async () => {
    setError(null);
    const kwList = keywords.split(",").map((s) => s.trim()).filter(Boolean);
    if (kwList.length === 0) {
      setError("At least one keyword is required.");
      return;
    }
    if (selected.size === 0) {
      setError("Pick at least one source.");
      return;
    }
    setBusy(true);
    setRow(null);
    setEvalId(null);
    const mustIncludeList = mustInclude.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const res = await fetch("/api/source-eval/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords:         kwList,
          location,
          postedWithinDays: days,
          distanceKm,
          mustInclude:      mustIncludeList,
          sources:          Array.from(selected),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Start failed (${res.status})`);
      const id = body.id as string;
      setEvalId(id);
      writeIdToUrl(id);
      // Refresh the "Recent" list — the new run shows up immediately as running.
      void loadRecent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [keywords, location, days, distanceKm, mustInclude, selected, loadRecent]);

  const openRecent = (item: RecentItem) => {
    setEvalId(item.id);
    writeIdToUrl(item.id);
    setBusy(item.status === "running");
    setError(null);
    // Pre-populate the form from the past run so re-running with tweaks is easy.
    setKeywords(item.keywords.join(", "));
    setLocation(item.location ?? "");
    setDays(item.posted_within_days);
    setSelected(new Set(item.sources_requested as SourceKey[]));
  };

  // ── Polling ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!evalId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/source-eval/${evalId}`);
        if (!res.ok) throw new Error(`Poll failed (${res.status})`);
        const data = (await res.json()) as EvalRow;
        if (cancelled) return;
        setRow(data);
        if (data.status === "completed" || data.status === "failed") {
          setBusy(false);
          void loadRecent();   // surface the final unique_total in the sidebar
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
      pollTimer.current = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [evalId, loadRecent]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const overlapStats = useMemo(() => {
    if (!row?.overlap) return null;
    // Histogram: how many jobs appear in N sources
    const histo: Record<number, number> = {};
    for (const sources of Object.values(row.overlap)) {
      const n = sources.length;
      histo[n] = (histo[n] ?? 0) + 1;
    }
    return histo;
  }, [row?.overlap]);

  const seekDirect = row?.results?.seek_direct;
  const seekApify  = row?.results?.seek_apify;
  const seekDelta  = useMemo(() => {
    if (!seekDirect?.kept_url_hashes || !seekApify?.kept_url_hashes) return null;
    const direct = new Set(seekDirect.kept_url_hashes);
    const apify  = new Set(seekApify.kept_url_hashes);
    const onlyDirect = [...direct].filter((h) => !apify.has(h)).length;
    const onlyApify  = [...apify].filter((h) => !direct.has(h)).length;
    const both       = [...direct].filter((h) => apify.has(h)).length;
    return { onlyDirect, onlyApify, both };
  }, [seekDirect, seekApify]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-text">Source coverage — A/B/C/D test</h1>
        <p className="text-sm text-text-2">
          Runs each source independently against the same query. Dry-run — no jobs are saved.
          Results survive refresh (the URL carries the eval id).
        </p>
      </header>

      {/* ── Recent evals ────────────────────────────────────────────────── */}
      {recent.length > 0 && (
        <section className="rounded-md border border-border bg-surface p-4 space-y-2">
          <h2 className="text-sm font-semibold text-text">Recent evals</h2>
          <ul className="divide-y divide-border">
            {recent.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => openRecent(r)}
                  className={`w-full text-left text-xs py-2 hover:bg-bg rounded px-2 flex items-center justify-between gap-3 ${
                    r.id === evalId ? "bg-bg" : ""
                  }`}
                >
                  <span className="flex-1 truncate">
                    <span className="text-text">{r.keywords.join(", ")}</span>
                    <span className="text-text-3"> · {r.location ?? "—"} · {r.posted_within_days}d</span>
                    <span className="text-text-3"> · {r.sources_requested.length} sources</span>
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[10px] ${
                    r.status === "completed" ? "bg-green-100 text-green-800" :
                    r.status === "failed"    ? "bg-red-100 text-red-800"     :
                                               "bg-blue-100 text-blue-800"
                  }`}>
                    {r.status}
                    {r.unique_total != null && ` · ${r.unique_total}`}
                  </span>
                  <span className="text-text-3 w-32 text-right">
                    {new Date(r.created_at).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Form ────────────────────────────────────────────────────────── */}
      <section className="rounded-md border border-border bg-surface p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="block md:col-span-2">
            <span className="block text-xs text-text-2 mb-1">Keywords (comma-separated)</span>
            <input
              className="w-full rounded border border-border bg-bg text-text px-3 py-2 text-sm"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="Data Analyst, BI Analyst"
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="block text-xs text-text-2 mb-1">Location</span>
            <input
              className="w-full rounded border border-border bg-bg text-text px-3 py-2 text-sm"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Sydney NSW 2000"
              disabled={busy}
            />
            {normalisedLocation !== location.trim() && normalisedLocation && (
              <span className="block text-[10px] text-text-3 mt-0.5">
                → sent to adapters as <b>{normalisedLocation}</b>
              </span>
            )}
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-xs text-text-2 mb-1">Days</span>
              <input
                type="number" min={1} max={60}
                className="w-full rounded border border-border bg-bg text-text px-3 py-2 text-sm"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                disabled={busy}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-text-2 mb-1" title="Adzuna only">Radius km</span>
              <input
                type="number" min={1} max={500}
                className="w-full rounded border border-border bg-bg text-text px-3 py-2 text-sm"
                value={distanceKm}
                onChange={(e) => setDistanceKm(Number(e.target.value))}
                disabled={busy}
              />
            </label>
          </div>
        </div>

        <label className="block">
          <span className="block text-xs text-text-2 mb-1">
            Smart filter — must include any of <span className="text-text-3">(optional, comma-separated)</span>
          </span>
          <input
            className="w-full rounded border border-border bg-bg text-text px-3 py-2 text-sm"
            value={mustInclude}
            onChange={(e) => setMustInclude(e.target.value)}
            placeholder="AIN, Assistant in Nursing, PCA, Care Worker"
            disabled={busy}
          />
          <span className="block text-[10px] text-text-3 mt-0.5">
            After fetch, only keep jobs whose title or description contains any of these phrases.
            Leave empty to keep every job each source returns (will include noise like off-topic results).
          </span>
        </label>

        <div className="flex flex-wrap gap-2">
          {SOURCES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              disabled={busy}
              className={`text-xs px-3 py-1.5 rounded border transition ${
                selected.has(s.key)
                  ? "bg-brand text-white border-brand"
                  : "bg-bg text-text-2 border-border hover:border-text-3"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={start}
            disabled={busy}
            className="rounded bg-brand text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? "Running…" : "Start eval"}
          </button>
          {error && <span className="text-sm text-red-600">{error}</span>}
          {row && (
            <span className="text-xs text-text-3">
              eval {row.id.slice(0, 8)} — {row.status}
              {row.unique_total != null && ` — ${row.unique_total} unique across sources`}
            </span>
          )}
        </div>
      </section>

      {/* ── Cross-source summary ────────────────────────────────────────── */}
      {row && row.status !== "running" && (
        <section className="rounded-md border border-border bg-surface p-4 space-y-3">
          <h2 className="text-sm font-semibold text-text">Cross-source summary</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat label="Unique URLs (post-filter)" value={row.unique_total ?? 0} />
            <Stat
              label="Total kept (sum across sources)"
              value={Object.values(row.results).reduce(
                (acc, r) => acc + (r.counts?.after_dedup ?? 0), 0
              )}
            />
            <Stat
              label="Total full JD"
              value={Object.values(row.results).reduce(
                (acc, r) => acc + (r.counts?.full_jd ?? 0), 0
              )}
            />
            <Stat
              label="Total thin JD"
              value={Object.values(row.results).reduce(
                (acc, r) => acc + (r.counts?.thin_jd ?? 0), 0
              )}
            />
          </div>

          {overlapStats && (
            <div className="text-xs text-text-2">
              <div className="font-medium text-text mb-1">Overlap histogram</div>
              <ul className="space-y-0.5">
                {Object.entries(overlapStats)
                  .sort((a, b) => Number(a[0]) - Number(b[0]))
                  .map(([n, count]) => (
                    <li key={n}>
                      {count} job{count === 1 ? "" : "s"} found by{" "}
                      <b>{n}</b> source{Number(n) === 1 ? "" : "s"}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {seekDelta && (
            <div className="text-xs text-text-2 border-t border-border pt-2">
              <span className="font-medium text-text">SEEK direct vs Apify:</span>{" "}
              both <b>{seekDelta.both}</b> · only direct <b>{seekDelta.onlyDirect}</b> · only Apify <b>{seekDelta.onlyApify}</b>
            </div>
          )}
        </section>
      )}

      {/* ── Per-source cards ────────────────────────────────────────────── */}
      {row && (
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {row.sources_requested.map((src) => (
            <SourceCard
              key={src}
              source={src}
              label={SOURCES.find((s) => s.key === src)?.label ?? src}
              note={SOURCES.find((s) => s.key === src)?.note}
              result={row.results[src]}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-border bg-bg p-3">
      <div className="text-xs text-text-3">{label}</div>
      <div className="text-xl font-semibold text-text">{value}</div>
    </div>
  );
}

function SourceCard({
  source,
  label,
  note,
  result,
}: {
  source: string;
  label:  string;
  note?:  string;
  result: SourceResult | undefined;
}) {
  const status = result?.status ?? "pending";
  const counts = result?.counts ?? emptyCounts();

  const statusColor =
    status === "done"    ? "bg-green-100 text-green-800" :
    status === "error"   ? "bg-red-100 text-red-800"     :
    status === "running" ? "bg-blue-100 text-blue-800"   :
                           "bg-gray-100 text-gray-700";

  return (
    <div className="rounded-md border border-border bg-surface p-4 space-y-3">
      <header className="flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-text">{label}</div>
          {note && <div className="text-xs text-text-3">{note}</div>}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded ${statusColor}`}>{status}</span>
      </header>

      {/* Funnel */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <Funnel n={counts.fetched}         lbl="Fetched"            />
        <Funnel n={counts.after_url_dedup} lbl="After URL dedup"    />
        <Funnel n={counts.after_keyword}   lbl="After keyword"      />
        <Funnel n={counts.after_smart}     lbl="After smart filter" />
        <Funnel n={counts.after_dedup}     lbl="After content dedup"/>
        <Funnel n={counts.would_save}      lbl="Would save"  bold   />
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border border-border bg-bg p-2">
          <div className="text-text-3">Full JD</div>
          <div className="font-semibold text-text">{counts.full_jd}</div>
        </div>
        <div className="rounded border border-border bg-bg p-2">
          <div className="text-text-3">Thin JD</div>
          <div className="font-semibold text-text">{counts.thin_jd}</div>
        </div>
      </div>

      {result?.timing_ms && (
        <div className="text-xs text-text-3">
          fetch {fmtMs(result.timing_ms.fetch)} · dedup {fmtMs(result.timing_ms.dedup)} ·
          {" "}jd-enrich {fmtMs(result.timing_ms.jd_enrich)}
          {result.jd_enrich && result.jd_enrich.fetched > 0 && (
            <> · merged {result.jd_enrich.merged}/{result.jd_enrich.fetched}
              {result.jd_enrich.cost_usd > 0 && <> · ${result.jd_enrich.cost_usd.toFixed(4)}</>}
            </>
          )}
        </div>
      )}

      {result?.error && (
        <div className="text-xs text-red-700 rounded border border-red-300 bg-red-50 px-2 py-1">
          {result.error}
        </div>
      )}
      {result?.note && (
        <div className="text-xs text-amber-800 rounded border border-amber-300 bg-amber-50 px-2 py-1">
          {result.note}
        </div>
      )}

      {result?.diagnostics && (
        <details className="text-xs">
          <summary className="cursor-pointer text-text-2">Diagnostics</summary>
          <div className="mt-2 space-y-2">
            {/* Env vars */}
            {Object.keys(result.diagnostics.env).length > 0 && (
              <div>
                <div className="text-text-3 mb-0.5">Env vars on worker:</div>
                <ul className="ml-2">
                  {Object.entries(result.diagnostics.env).map(([k, v]) => (
                    <li key={k} className={v ? "text-green-700" : "text-red-700"}>
                      {v ? "✓" : "✗"} {k}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/* Integration state */}
            {result.diagnostics.integration && (
              <div>
                <div className="text-text-3 mb-0.5">Integration ({result.diagnostics.integration.provider}):</div>
                <ul className="ml-2 text-text-2">
                  <li>present: {String(result.diagnostics.integration.present)}</li>
                  {result.diagnostics.integration.is_enabled != null && (
                    <li>is_enabled: {String(result.diagnostics.integration.is_enabled)}</li>
                  )}
                  {result.diagnostics.integration.status && (
                    <li>status: {result.diagnostics.integration.status}</li>
                  )}
                  {result.diagnostics.integration.reason && (
                    <li className="text-amber-700">reason: {result.diagnostics.integration.reason}</li>
                  )}
                </ul>
              </div>
            )}
            {/* Captured logs */}
            {result.diagnostics.logs.length > 0 && (
              <div>
                <div className="text-text-3 mb-0.5">Logs ({result.diagnostics.logs.length}):</div>
                <pre className="max-h-48 overflow-auto text-[10px] bg-bg border border-border rounded p-2 whitespace-pre-wrap">
                  {result.diagnostics.logs.join("\n")}
                </pre>
              </div>
            )}
          </div>
        </details>
      )}

      {result?.samples && result.samples.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-text-2">
            {result.samples.length} sample{result.samples.length === 1 ? "" : "s"} (top by JD length)
          </summary>
          <ul className="mt-2 space-y-1">
            {result.samples.map((s) => (
              <li key={s.url_hash} className="border-l-2 border-border pl-2">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand underline decoration-dotted hover:decoration-solid"
                >
                  {s.title}
                </a>{" "}
                · <span className="text-text-2">{s.company}</span>
                <span className="text-text-3"> · {s.location}</span>
                {s.posted_at && (
                  <span className="text-text-3"> · {s.posted_at.slice(0, 10)}</span>
                )}
                <span className="text-text-3">
                  {" "}· {s.full_jd ? "full" : "thin"} ({s.desc_len} chars)
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Source-specific hint */}
      {source === "seek_direct" && status === "done" && (
        <div className="text-[11px] text-text-3 border-t border-border pt-2">
          Tip: open
          {" "}<a className="text-brand underline" target="_blank" rel="noopener noreferrer"
              href="https://www.seek.com.au/jobs">seek.com.au</a>{" "}
          and run the same keyword + location + 14-day filter to verify against the SEEK direct result.
        </div>
      )}
    </div>
  );
}

function Funnel({ n, lbl, bold }: { n: number; lbl: string; bold?: boolean }) {
  return (
    <div className={`rounded border border-border bg-bg p-2 ${bold ? "ring-1 ring-brand" : ""}`}>
      <div className="text-text-3">{lbl}</div>
      <div className={`text-lg ${bold ? "font-bold text-text" : "font-semibold text-text"}`}>{n}</div>
    </div>
  );
}
