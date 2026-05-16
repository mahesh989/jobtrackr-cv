"use client";

/**
 * ProviderPicker — accordion card selector for preferred AI provider + model.
 * Lives at the top of the Integrations → AI providers section.
 *
 * Provider preference  → localStorage ("jobtrackr-preferred-provider")
 * Model selection      → PATCH /api/integrations/ai-keys/[provider] (DB)
 */

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";

export type ProviderId = "anthropic" | "openai" | "deepseek";

export interface ProviderStatus {
  id:        ProviderId;
  connected: boolean;
  model:     string | null;
}

const META: Record<ProviderId, {
  label:        string;
  color:        string;
  defaultModel: string;
  models:       { value: string; label: string; tag: string }[];
}> = {
  anthropic: {
    label:        "Anthropic",
    color:        "#b86a00",
    defaultModel: "claude-3-5-sonnet-20241022",
    models: [
      { value: "claude-sonnet-4-6",          label: "Claude Sonnet 4.6",  tag: "recommended"  },
      { value: "claude-opus-4-7",            label: "Claude Opus 4.7",    tag: "most capable" },
      { value: "claude-haiku-4-5-20251001",  label: "Claude Haiku 4.5",   tag: "fastest"      },
      { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet",  tag: "legacy"       },
    ],
  },
  openai: {
    label:        "OpenAI",
    color:        "#10a37f",
    defaultModel: "gpt-5.2",
    models: [
      { value: "gpt-5.2",     label: "GPT-5.2",      tag: "recommended"  },
      { value: "gpt-5.2-pro", label: "GPT-5.2 Pro",  tag: "most capable" },
      { value: "gpt-5-mini",  label: "GPT-5 mini",   tag: "cheap"        },
      { value: "o3-mini",     label: "o3-mini",       tag: "reasoning"    },
      { value: "gpt-4o",      label: "GPT-4o",        tag: "legacy"       },
    ],
  },
  deepseek: {
    label:        "DeepSeek",
    color:        "#4d6ef5",
    defaultModel: "deepseek-chat",
    models: [
      { value: "deepseek-chat",     label: "deepseek-chat",     tag: "default"   },
      { value: "deepseek-reasoner", label: "deepseek-reasoner", tag: "reasoning" },
    ],
  },
};

const TAG_CLS: Record<string, string> = {
  recommended:    "bg-[var(--brand)]/10  text-[var(--brand)]  border-[var(--brand)]/20",
  "most capable": "bg-purple-50  text-purple-700  border-purple-200",
  fastest:        "bg-green-50   text-green-700   border-green-200",
  cheap:          "bg-green-50   text-green-700   border-green-200",
  reasoning:      "bg-blue-50    text-blue-700    border-blue-200",
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

/* ─────────────────────────────────────────────────────────────── */

export function ProviderPicker({ providers }: { providers: ProviderStatus[] }) {
  // Resolve initial preferred — first connected provider that matches localStorage,
  // or the first connected provider overall.
  const connectedIds = providers.filter((p) => p.connected).map((p) => p.id);
  const stored       = readPreferred();
  const initialPref  = (stored && connectedIds.includes(stored))
    ? stored
    : connectedIds[0] ?? null;

  const [preferred, setPreferred] = useState<ProviderId | null>(initialPref);

  // Per-provider model state, seeded from DB values passed as props.
  const [models, setModels] = useState<Record<ProviderId, string>>(() => {
    const m = {} as Record<ProviderId, string>;
    for (const p of providers) {
      m[p.id] = p.model ?? META[p.id].defaultModel;
    }
    return m;
  });

  const [savingModel, setSavingModel] = useState<ProviderId | null>(null);
  const [savedFlash,  setSavedFlash]  = useState<ProviderId | null>(null);
  const [modelErr,    setModelErr]    = useState<string | null>(null);
  const [, startTransition]           = useTransition();

  function selectProvider(id: ProviderId) {
    setPreferred(id);
    savePreferred(id);
  }

  async function pickModel(providerId: ProviderId, modelValue: string) {
    setModels((prev) => ({ ...prev, [providerId]: modelValue }));
    setModelErr(null);
    setSavingModel(providerId);

    startTransition(async () => {
      const res = await fetch(`/api/integrations/ai-keys/${providerId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model: modelValue }),
      });
      setSavingModel(null);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setModelErr(j.error ?? "Failed to save model");
        return;
      }
      setSavedFlash(providerId);
      setTimeout(() => setSavedFlash(null), 1500);
    });
  }

  return (
    <div className="space-y-2">
      {providers.map((p) => {
        const meta      = META[p.id];
        const isActive  = preferred === p.id;
        const isSaving  = savingModel === p.id;
        const didSave   = savedFlash === p.id;
        const currModel = models[p.id];

        return (
          <div
            key={p.id}
            className={`rounded-lg border transition-all overflow-hidden ${
              isActive && p.connected
                ? "border-[var(--brand)] shadow-sm"
                : !p.connected
                ? "border-[var(--border)] opacity-50"
                : "border-[var(--border)] hover:border-[var(--brand)]/40"
            }`}
          >
            {/* ── Card header ── */}
            <button
              disabled={!p.connected}
              onClick={() => selectProvider(p.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                isActive && p.connected
                  ? "bg-[var(--brand)]/5"
                  : p.connected
                  ? "bg-[var(--surface)] hover:bg-[var(--surface-2)]"
                  : "bg-[var(--surface)] cursor-not-allowed"
              }`}
            >
              {/* Radio dot */}
              <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                isActive && p.connected
                  ? "border-[var(--brand)]"
                  : "border-[var(--border)]"
              }`}>
                {isActive && p.connected && (
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)]" />
                )}
              </span>

              {/* Provider dot + name */}
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.color }} />
              <span className="text-[13px] font-semibold text-text">{meta.label}</span>

              {/* Right side */}
              <span className="ml-auto flex items-center gap-2">
                {!p.connected && (
                  <span className="text-[11px] text-text-3">Connect a key first</span>
                )}
                {p.connected && !isActive && (
                  <span className="text-[11px] text-text-3 truncate max-w-[160px]">{currModel}</span>
                )}
                {isActive && p.connected && (
                  <span
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded border"
                    style={{
                      background:   `${meta.color}18`,
                      color:         meta.color,
                      borderColor:  `${meta.color}30`,
                    }}
                  >
                    active
                  </span>
                )}
              </span>
            </button>

            {/* ── Expanded model picker (active + connected only) ── */}
            {isActive && p.connected && (
              <div className="border-t border-[var(--border)] px-4 py-3 bg-[var(--surface)] space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-text-3">
                    Model
                  </p>
                  {isSaving && (
                    <span className="flex items-center gap-1 text-[11px] text-text-3">
                      <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                    </span>
                  )}
                  {didSave && !isSaving && (
                    <span className="flex items-center gap-1 text-[11px] text-green-600">
                      <Check className="w-3 h-3" /> Saved
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {meta.models.map((m) => {
                    const on = currModel === m.value;
                    return (
                      <button
                        key={m.value}
                        disabled={isSaving}
                        onClick={() => pickModel(p.id, m.value)}
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

                {modelErr && (
                  <p className="text-[11px] text-red-600">{modelErr}</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
