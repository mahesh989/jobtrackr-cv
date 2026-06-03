"use client";

/**
 * ProviderPicker — unified AI provider accordion.
 *
 * Each card handles:
 *   • Provider selection (radio → localStorage)
 *   • API key connect / replace / disconnect
 *   • Model picker (pills → PATCH to DB)
 *
 * Replaces the separate AiKeyCard + old ProviderPicker components.
 */

import { useState } from "react";
import { Check, ChevronDown, ChevronUp, Loader2, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";

export type ProviderId = "anthropic" | "openai" | "deepseek";

export interface ProviderStatus {
  id:             ProviderId;
  connected:      boolean;
  status?:        string | null;
  statusReason?:  string | null;
  lastValidated?: string | null;
  model?:         string | null;
}

/* ─── Provider metadata ──────────────────────────────────────── */
const META: Record<ProviderId, {
  label:        string;
  tagline:      string;
  color:        string;
  placeholder:  string;
  helpUrl:      string;
  defaultModel: string;
  models: { value: string; label: string; tag: string }[];
}> = {
  anthropic: {
    label:        "Anthropic",
    tagline:      "Claude Opus & Sonnet families",
    color:        "#b86a00",
    placeholder:  "sk-ant-...",
    helpUrl:      "https://console.anthropic.com/account/keys",
    defaultModel: "claude-sonnet-4-6",
    models: [
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tag: "recommended"  },
      { value: "claude-opus-4-8",   label: "Claude Opus 4.8",   tag: "latest"       },
      { value: "claude-opus-4-7",   label: "Claude Opus 4.7",   tag: "most capable" },
      { value: "claude-opus-4-6",   label: "Claude Opus 4.6",   tag: "stable"       },
    ],
  },
  openai: {
    label:        "OpenAI",
    tagline:      "GPT-5 family",
    color:        "#10a37f",
    placeholder:  "sk-...",
    helpUrl:      "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.1",
    models: [
      { value: "gpt-5.1", label: "GPT-5.1", tag: "recommended" },
      { value: "gpt-5",   label: "GPT-5",   tag: "base"        },
      { value: "gpt-5.2", label: "GPT-5.2", tag: "newer"       },
      { value: "gpt-5.5", label: "GPT-5.5", tag: "latest"      },
    ],
  },
  deepseek: {
    label:        "DeepSeek",
    tagline:      "deepseek-chat & deepseek-reasoner",
    color:        "#4d6ef5",
    placeholder:  "sk-...",
    helpUrl:      "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    models: [
      { value: "deepseek-chat",     label: "deepseek-chat",     tag: "default"   },
      { value: "deepseek-reasoner", label: "deepseek-reasoner", tag: "reasoning" },
    ],
  },
};

const TAG_CLS: Record<string, string> = {
  recommended:    "bg-[var(--brand)]/10 text-[var(--brand)] border-[var(--brand)]/20",
  "most capable": "bg-purple-50  text-purple-700  border-purple-200",
  fastest:        "bg-green-50   text-green-700   border-green-200",
  cheap:          "bg-green-50   text-green-700   border-green-200",
  reasoning:      "bg-blue-50    text-blue-700    border-blue-200",
  latest:         "bg-blue-50    text-blue-700    border-blue-200",
  newer:          "bg-blue-50    text-blue-700    border-blue-200",
  stable:         "bg-gray-100   text-gray-600    border-gray-200",
  base:           "bg-gray-100   text-gray-600    border-gray-200",
  legacy:         "bg-gray-100   text-gray-500    border-gray-200",
  default:        "bg-gray-100   text-gray-500    border-gray-200",
};

const LS_KEY = "jobtrackr-preferred-provider";

function readPreferred(): ProviderId | null {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === "anthropic" || v === "openai" || v === "deepseek") return v;
  } catch {}
  return null;
}
function savePreferred(id: ProviderId) {
  try { localStorage.setItem(LS_KEY, id); } catch {}
}

/* ─── Per-provider state shape ───────────────────────────────── */
interface ProvState {
  connected:     boolean;
  statusReason:  string | null;
  lastValidated: string | null;
  model:         string;           // resolved model id
}

const ORDER: ProviderId[] = ["anthropic", "openai", "deepseek"];

/* ═══════════════════════════════════════════════════════════════ */
export function ProviderPicker({ providers }: { providers: ProviderStatus[] }) {
  const router = useRouter();

  /* ── Initial state ── */
  const initStates = () => {
    const m = {} as Record<ProviderId, ProvState>;
    for (const p of providers) {
      m[p.id] = {
        connected:     p.connected,
        statusReason:  p.statusReason ?? null,
        lastValidated: p.lastValidated ?? null,
        model:         p.model ?? META[p.id].defaultModel,
      };
    }
    return m;
  };

  const connectedIds = providers.filter((p) => p.connected).map((p) => p.id);
  const stored       = readPreferred();
  const initPreferred = (stored && connectedIds.includes(stored)) ? stored
    : connectedIds[0] ?? null;

  const [states,    setStates]    = useState<Record<ProviderId, ProvState>>(initStates);
  const [preferred, setPreferred] = useState<ProviderId | null>(initPreferred);
  const [expanded,  setExpanded]  = useState<ProviderId | null>(initPreferred ?? ORDER[0]);

  // Per-provider key input & replace-mode
  const [keyInputs,  setKeyInputs]  = useState<Record<ProviderId, string>>({ anthropic: "", openai: "", deepseek: "" });
  const [replaceMode, setReplaceMode] = useState<Record<ProviderId, boolean>>({ anthropic: false, openai: false, deepseek: false });

  // Loading / error / flash per provider
  const [connecting,    setConnecting]    = useState<ProviderId | null>(null);
  const [disconnecting, setDisconnecting] = useState<ProviderId | null>(null);
  const [savingModel,   setSavingModel]   = useState<ProviderId | null>(null);
  const [savedFlash,    setSavedFlash]    = useState<ProviderId | null>(null);
  const [errors,        setErrors]        = useState<Record<ProviderId, string | null>>({ anthropic: null, openai: null, deepseek: null });

  function setErr(id: ProviderId, msg: string | null) {
    setErrors((prev) => ({ ...prev, [id]: msg }));
  }

  /* ── Select preferred ── */
  function selectPreferred(id: ProviderId) {
    if (!states[id].connected) return;
    setPreferred(id);
    savePreferred(id);
  }

  /* ── Toggle expand ── */
  function toggleExpand(id: ProviderId) {
    setExpanded((prev) => (prev === id ? null : id));
  }

  /* ── Connect / Replace key ── */
  async function handleConnect(id: ProviderId) {
    const key = keyInputs[id].trim();
    if (!key) { setErr(id, "Paste your API key first."); return; }
    setErr(id, null);
    setConnecting(id);
    try {
      const res  = await fetch(`/api/integrations/ai-keys/${id}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ key, model: states[id].model }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(id, json.error ?? `Failed (${res.status})`); return; }

      setStates((prev) => ({
        ...prev,
        [id]: { ...prev[id], connected: true, lastValidated: new Date().toISOString(), statusReason: null },
      }));
      setKeyInputs((prev) => ({ ...prev, [id]: "" }));
      setReplaceMode((prev) => ({ ...prev, [id]: false }));

      // Auto-set as preferred if no preferred yet
      if (!preferred) { setPreferred(id); savePreferred(id); }
      router.refresh();
    } finally {
      setConnecting(null);
    }
  }

  /* ── Disconnect ── */
  async function handleDisconnect(id: ProviderId) {
    if (!confirm(`Disconnect ${META[id].label}?`)) return;
    setDisconnecting(id);
    try {
      const res = await fetch(`/api/integrations/ai-keys/${id}`, { method: "DELETE" });
      if (!res.ok) { setErr(id, "Disconnect failed — try again."); return; }
      setStates((prev) => ({ ...prev, [id]: { ...prev[id], connected: false, statusReason: null, lastValidated: null } }));
      if (preferred === id) {
        const next = ORDER.find((p) => p !== id && states[p].connected) ?? null;
        setPreferred(next);
        if (next) savePreferred(next); else { try { localStorage.removeItem(LS_KEY); } catch {} }
      }
      router.refresh();
    } finally {
      setDisconnecting(null);
    }
  }

  /* ── Save model ── */
  async function handleSaveModel(id: ProviderId, model: string) {
    setStates((prev) => ({ ...prev, [id]: { ...prev[id], model } }));
    setErr(id, null);
    setSavingModel(id);
    try {
      const res  = await fetch(`/api/integrations/ai-keys/${id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(id, json.error ?? "Failed to save model"); return; }
      setSavedFlash(id);
      setTimeout(() => setSavedFlash((v) => (v === id ? null : v)), 1500);
    } finally {
      setSavingModel(null);
    }
  }

  /* ══════════════════════════════════════════════════════════════ */
  return (
    <div className="space-y-2">
      {ORDER.map((id) => {
        const meta   = META[id];
        const state  = states[id];
        const isOpen = expanded === id;
        const isPref = preferred === id;
        const isBusy = connecting === id || disconnecting === id;

        return (
          <div
            key={id}
            className={`rounded-lg border overflow-hidden transition-all ${
              isPref && state.connected
                ? "border-[var(--brand)] shadow-sm"
                : "border-[var(--border)]"
            }`}
          >
            {/* ── Header ─────────────────────────────────────────── */}
            <div
              className={`flex items-center gap-3 px-4 py-3 cursor-pointer select-none transition-colors ${
                isPref && state.connected
                  ? "bg-[var(--brand)]/5"
                  : "bg-[var(--surface)] hover:bg-[var(--surface-2)]"
              }`}
              onClick={() => toggleExpand(id)}
            >
              {/* Radio — sets preferred; separate click target */}
              <span
                role="radio"
                aria-checked={isPref}
                onClick={(e) => { e.stopPropagation(); selectPreferred(id); }}
                className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                  isPref && state.connected
                    ? "border-[var(--brand)] cursor-pointer"
                    : state.connected
                    ? "border-[var(--border)] cursor-pointer hover:border-[var(--brand)]/50"
                    : "border-[var(--border)] opacity-40 cursor-not-allowed"
                }`}
              >
                {isPref && state.connected && (
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)]" />
                )}
              </span>

              {/* Color dot + name + tagline */}
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.color }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-text">{meta.label}</span>
                  {state.connected && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-green-50 border-green-200 text-green-700">
                      CONNECTED
                    </span>
                  )}
                  {isPref && state.connected && (
                    <span
                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded border"
                      style={{ background: `${meta.color}18`, color: meta.color, borderColor: `${meta.color}30` }}
                    >
                      preferred
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-text-3 mt-0.5">{meta.tagline}</p>
              </div>

              {/* Right: model summary + chevron */}
              <div className="flex items-center gap-2 shrink-0">
                {state.connected && !isOpen && (
                  <span className="text-[11px] text-text-3 hidden sm:block truncate max-w-[150px]">
                    {state.model}
                  </span>
                )}
                {isOpen
                  ? <ChevronUp className="w-4 h-4 text-text-3" />
                  : <ChevronDown className="w-4 h-4 text-text-3" />}
              </div>
            </div>

            {/* ── Expanded body ───────────────────────────────────── */}
            {isOpen && (
              <div className="border-t border-[var(--border)] bg-[var(--surface)] px-4 py-4 space-y-4">

                {/* Status reason warning */}
                {state.statusReason && (
                  <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-700">
                    {state.statusReason}
                  </div>
                )}

                {/* ── API KEY SECTION ── */}
                {(!state.connected || replaceMode[id]) && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
                        API key
                      </label>
                      <a
                        href={meta.helpUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-1 text-[11px] text-text-3 hover:text-text transition-colors"
                      >
                        Get key <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={keyInputs[id]}
                      onChange={(e) => setKeyInputs((prev) => ({ ...prev, [id]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && handleConnect(id)}
                      placeholder={meta.placeholder}
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[13px] font-mono text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/20 focus:border-[var(--brand)]"
                    />
                    <p className="text-[11px] text-text-3">
                      Stored encrypted (AES-256-GCM). Never returned to the browser.
                    </p>
                  </div>
                )}

                {/* Connected key info */}
                {state.connected && !replaceMode[id] && (
                  <div className="text-[12px] text-text-2">
                    Key stored · last validated{" "}
                    <span className="text-text font-medium">
                      {state.lastValidated
                        ? new Date(state.lastValidated).toLocaleDateString("en-AU", {
                            day: "numeric", month: "short", year: "numeric",
                          })
                        : "—"}
                    </span>
                  </div>
                )}

                {/* ── MODEL PICKER ── */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
                      Model
                    </label>
                    <span className="flex items-center gap-1 h-4">
                      {savingModel === id && (
                        <span className="flex items-center gap-1 text-[11px] text-text-3">
                          <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                        </span>
                      )}
                      {savedFlash === id && savingModel !== id && (
                        <span className="flex items-center gap-1 text-[11px] text-green-600">
                          <Check className="w-3 h-3" /> Saved
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {meta.models.map((m) => {
                      const on = state.model === m.value;
                      return (
                        <button
                          key={m.value}
                          disabled={savingModel === id}
                          onClick={() => {
                            if (state.connected) handleSaveModel(id, m.value);
                            else setStates((prev) => ({ ...prev, [id]: { ...prev[id], model: m.value } }));
                          }}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-all disabled:opacity-50 ${
                            on
                              ? "bg-text text-[var(--surface)] border-text"
                              : "bg-[var(--surface-2)] border-[var(--border)] text-text-2 hover:text-text"
                          }`}
                        >
                          {m.label}
                          <span className={`text-[9px] px-1 py-0.5 rounded border font-semibold ${
                            on ? "bg-white/20 text-white border-white/20" : TAG_CLS[m.tag]
                          }`}>
                            {m.tag}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Error */}
                {errors[id] && (
                  <p className="text-[12px] text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                    {errors[id]}
                  </p>
                )}

                {/* ── Action buttons ── */}
                <div className="flex items-center gap-2 pt-1">
                  {/* Connect / Save new key */}
                  {(!state.connected || replaceMode[id]) && (
                    <button
                      disabled={isBusy}
                      onClick={() => handleConnect(id)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand)] px-3 py-1.5 text-[12px] font-medium text-[var(--brand-fg)] hover:opacity-90 disabled:opacity-50 transition-opacity"
                    >
                      {connecting === id
                        ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Validating…</>
                        : state.connected ? "Save new key" : "Connect"}
                    </button>
                  )}

                  {/* Cancel replace */}
                  {state.connected && replaceMode[id] && (
                    <button
                      onClick={() => { setReplaceMode((p) => ({ ...p, [id]: false })); setErr(id, null); }}
                      className="gh-btn text-[12px]"
                    >
                      Cancel
                    </button>
                  )}

                  {/* Replace key */}
                  {state.connected && !replaceMode[id] && (
                    <button
                      onClick={() => setReplaceMode((p) => ({ ...p, [id]: true }))}
                      className="gh-btn text-[12px]"
                    >
                      Replace key
                    </button>
                  )}

                  {/* Disconnect */}
                  {state.connected && !replaceMode[id] && (
                    <button
                      disabled={disconnecting === id}
                      onClick={() => handleDisconnect(id)}
                      className="gh-btn text-[12px] text-red-600 border-red-200 hover:bg-red-50 hover:border-red-300"
                    >
                      {disconnecting === id
                        ? <><Loader2 className="w-3 h-3 animate-spin inline mr-1" />Disconnecting…</>
                        : "Disconnect"}
                    </button>
                  )}
                </div>

              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
