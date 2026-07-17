"use client";

import { useState, useTransition, useEffect } from "react";
import { Badge, Button, Input } from "@/ui";

interface IntegrationData {
  connected:           boolean;
  status:              string;
  status_reason:       string | null;
  quota_used_usd:      number;
  quota_used_requests: number;
  quota_remaining_usd: number;
  monthly_budget_usd:  number;
  quota_resets_on:     string;
  last_used_at:        string | null;
  is_enabled:          boolean;
}

interface Props {
  initialData: IntegrationData | null;
}

// ── Status badge — uses app Badge component ─────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: "green" | "amber" | "red" | "gray" }> = {
    valid:              { label: "Connected",     variant: "green" },
    pending_validation: { label: "Validating…",   variant: "amber" },
    quota_exceeded:     { label: "Quota reached", variant: "amber" },
    invalid:            { label: "Invalid token", variant: "red"   },
    expired:            { label: "Token expired", variant: "red"   },
    revoked:            { label: "Token revoked", variant: "red"   },
    disabled:           { label: "Disabled",      variant: "gray"  },
  };
  const s = map[status] ?? { label: status, variant: "gray" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

// ── Quota bar ─────────────────────────────────────────────────────────────────
function QuotaBar({ used, total }: { used: number; total: number }) {
  const pct     = Math.min(100, (used / total) * 100);
  const warning = pct >= 80;
  const full    = pct >= 100;
  const fill    = full
    ? "background:var(--red)"
    : warning
    ? "background:var(--amber)"
    : "background:var(--blue)";

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center">
        <span className="text-[12px] text-text-2">Monthly usage</span>
        <span className="text-[12px] font-medium text-text tabular-nums">
          ${used.toFixed(2)} <span className="text-text-3 font-normal">/ ${total.toFixed(2)}</span>
        </span>
      </div>
      {/* Reuse visa-track pattern from globals.css */}
      <div className="w-full h-[6px] rounded-full border border-border overflow-hidden bg-surface-2">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, ...(Object.fromEntries([[fill.split(":")[0], fill.split(":")[1]]])) }}
        />
      </div>
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────
export function ApifyIntegrationCard({ initialData }: Props) {
  const [data, setData]             = useState<IntegrationData | null>(initialData);
  const [token, setToken]           = useState("");
  const [showToken, setShowToken]   = useState(false);
  const [showInput, setShowInput]   = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const connected = !!data?.connected && data.status !== "disabled";

  // Sync real usage from Apify on every page load (server component only reads from DB)
  useEffect(() => {
    if (!initialData?.connected) return;
    fetch("/api/integrations/apify")
      .then((r) => r.ok ? r.json() : null)
      .then((json) => { if (json?.connected) setData(json); })
      .catch(() => { /* keep initialData on network error */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleConnect() {
    if (!token.trim()) { setError("Paste your Apify API token first"); return; }
    setError(null);
    startTransition(async () => {
      const res  = await fetch("/api/integrations/apify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const json = await res.json();
      if (!res.ok || !json.valid) {
        setError(json.error ?? "Connection failed — check your token and try again");
        return;
      }
      const status = await fetch("/api/integrations/apify").then((r) => r.json());
      setData(status);
      setToken(""); setShowInput(false);
    });
  }

  async function handleDisconnect() {
    setError(null);
    startTransition(async () => {
      await fetch("/api/integrations/apify", { method: "DELETE" });
      setData(null); setShowInput(false);
    });
  }

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">

      {/* ── Card header ── */}
      <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-border bg-surface-2">
        <div className="flex items-center gap-3">
          {/* SEEK wordmark icon */}
          <div className="w-9 h-9 rounded-md bg-surface border border-border flex items-center justify-center shrink-0">
            <svg width="20" height="20" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="6" fill="#0069C2"/>
              <path d="M8 16c0-4.418 3.582-8 8-8s8 3.582 8 8-3.582 8-8 8-8-3.582-8-8z" fill="white" opacity="0.15"/>
              <path d="M13 12h2v8h-2zM17 12h2v8h-2z" fill="white"/>
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-text">SEEK Australia</span>
              <span className="text-[11px] text-text-3 bg-surface border border-border px-1.5 py-0.5 rounded-full">
                via Apify
              </span>
            </div>
            <p className="text-[12px] text-text-2 mt-0.5">Australia&apos;s #1 job board — 170,000+ active listings</p>
          </div>
        </div>
        {connected && data && <StatusBadge status={data.status} />}
      </div>

      {/* ── Card body ── */}
      <div className="px-5 py-5 space-y-5">

        {connected && data ? (
          /* ── Connected state ── */
          <>
            <QuotaBar used={data.quota_used_usd} total={data.monthly_budget_usd} />

            <div className="flex items-center justify-between text-[12px]">
              <span className="text-text-3">
                {data.quota_used_requests.toLocaleString()} jobs fetched this month
              </span>
              <span className="text-text-3">Resets {data.quota_resets_on}</span>
            </div>

            {/* Quota exceeded */}
            {data.status === "quota_exceeded" && (
              <div className="rounded-md bg-amber-light border border-amber/20 px-3 py-2.5 text-[12px] text-amber">
                Monthly limit of ${data.monthly_budget_usd.toFixed(0)} reached. SEEK results will resume on {data.quota_resets_on}.{" "}
                <a href="https://apify.com/pricing" target="_blank" rel="noreferrer"
                  className="underline hover:opacity-80">Upgrade Apify plan →</a>
              </div>
            )}

            {/* Token error */}
            {data.status_reason && !["valid", "quota_exceeded"].includes(data.status) && (
              <div className="rounded-md bg-red-light border border-red/20 px-3 py-2.5 text-[12px] text-red">
                {data.status_reason}
              </div>
            )}

            {/* Last used */}
            {data.last_used_at && (
              <p className="text-[11px] text-text-3">
                Last used:{" "}
                {new Date(data.last_used_at).toLocaleDateString("en-AU", {
                  day: "numeric", month: "short", year: "numeric",
                  hour: "2-digit", minute: "2-digit",
                })}
              </p>
            )}

            <div className="divider" />

            {!showInput ? (
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => setShowInput(true)}>
                  Replace token
                </Button>
                <Button variant="danger" size="sm" onClick={handleDisconnect} disabled={isPending}>
                  {isPending ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            ) : (
              <TokenInput
                token={token} showToken={showToken} error={error} isPending={isPending}
                onChange={setToken} onToggleShow={() => setShowToken((v) => !v)}
                onConnect={handleConnect}
                onCancel={() => { setShowInput(false); setToken(""); setError(null); }}
                submitLabel="Replace token"
              />
            )}
          </>
        ) : (
          /* ── Disconnected state ── */
          <>
            <p className="text-[13px] text-text-2 leading-relaxed">
              Connect your free Apify account to include SEEK listings in every pipeline run.
              Each account gets{" "}
              <span className="font-semibold text-text">$5 free credit/month</span>{" "}
              — enough for ~2,000 SEEK jobs.
            </p>

            {/* Benefit pills */}
            <div className="flex flex-wrap gap-2">
              {["No credit card required", "Resets monthly", "Your token, your quota"].map((t) => (
                <span key={t} className="flex items-center gap-1.5 text-[12px] text-green">
                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
                  </svg>
                  {t}
                </span>
              ))}
            </div>

            {/* Setup guide */}
            <div className="rounded-md bg-surface-2 border border-border px-4 py-3 space-y-2">
              <p className="text-[12px] font-semibold text-text">How to get your API token</p>
              <ol className="text-[12px] text-text-2 space-y-1.5">
                <li className="flex gap-2">
                  <span className="text-text-3 shrink-0 w-4 text-right">1.</span>
                  <span>
                    Create a free account at{" "}
                    <a href="https://apify.com" target="_blank" rel="noreferrer"
                      className="text-blue hover:underline">apify.com</a>
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-text-3 shrink-0 w-4 text-right">2.</span>
                  <span>Go to <span className="font-medium text-text">Settings → Integrations → API tokens</span></span>
                </li>
                <li className="flex gap-2">
                  <span className="text-text-3 shrink-0 w-4 text-right">3.</span>
                  <span>Copy your Personal API token and paste it below</span>
                </li>
              </ol>
            </div>

            <TokenInput
              token={token} showToken={showToken} error={error} isPending={isPending}
              onChange={setToken} onToggleShow={() => setShowToken((v) => !v)}
              onConnect={handleConnect} submitLabel="Connect SEEK"
            />
          </>
        )}
      </div>
    </div>
  );
}

// ── Token input ───────────────────────────────────────────────────────────────
function TokenInput({
  token, showToken, error, isPending,
  onChange, onToggleShow, onConnect, onCancel, submitLabel,
}: {
  token: string; showToken: boolean; error: string | null; isPending: boolean;
  onChange: (v: string) => void; onToggleShow: () => void;
  onConnect: () => void; onCancel?: () => void; submitLabel: string;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[12px] font-semibold text-text mb-1.5">
          Apify API Token
        </label>
        <div className="relative">
          <Input
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onConnect()}
            placeholder="apify_api_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
            className="pr-9 font-mono text-[13px]"
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            type="button"
            onClick={onToggleShow}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-3 hover:text-text-2 transition-colors"
            title={showToken ? "Hide" : "Show"}
          >
            {showToken ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
              </svg>
            )}
          </Button>
        </div>
        {error && <p className="mt-1.5 text-[12px] text-red">{error}</p>}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="blue" size="sm"
          onClick={onConnect}
          disabled={isPending || !token.trim()}
          isLoading={isPending}
        >
          {isPending ? "Validating…" : submitLabel}
        </Button>
        {onCancel && (
          <Button size="sm" onClick={onCancel}>Cancel</Button>
        )}
        <span className="ml-auto text-[11px] text-text-3">Token stored encrypted</span>
      </div>
    </div>
  );
}
