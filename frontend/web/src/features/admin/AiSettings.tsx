"use client";

/**
 * AiSettings — admin-only accordion for the single platform-wide AI
 * provider (migration 060). Structurally mirrors the old per-user
 * ProviderPicker, but the radio dot now means "active for every user" (only
 * one provider can be active — enforced server-side by a partial unique
 * index), not "preferred for me".
 */

import { useState } from "react";
import { Check, ChevronDown, ChevronUp, Loader2, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { PROVIDER_META, PROVIDER_ORDER, type AiProvider } from "@/lib/ai/models";
import { Button, Input } from "@/components/ui";

export interface AdminProviderRow {
  provider:         AiProvider;
  hasKey:           boolean;
  model:            string;
  isActive:         boolean;
  statusReason:     string | null;
  lastValidatedAt:  string | null;
}

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

interface RowState {
  hasKey:          boolean;
  statusReason:    string | null;
  lastValidatedAt: string | null;
  model:           string;
  isActive:        boolean;
}

export function AiSettings({ initialProviders }: { initialProviders: AdminProviderRow[] }) {
  const router = useRouter();

  const initStates = () => {
    const m = {} as Record<AiProvider, RowState>;
    for (const p of initialProviders) {
      m[p.provider] = {
        hasKey:          p.hasKey,
        statusReason:    p.statusReason,
        lastValidatedAt: p.lastValidatedAt,
        model:           p.model,
        isActive:        p.isActive,
      };
    }
    return m;
  };

  const activeId = initialProviders.find((p) => p.isActive)?.provider ?? null;

  const [states,   setStates]   = useState<Record<AiProvider, RowState>>(initStates);
  const [expanded, setExpanded] = useState<AiProvider | null>(activeId ?? PROVIDER_ORDER[0]);

  const [keyInputs,   setKeyInputs]   = useState<Record<AiProvider, string>>({ anthropic: "", openai: "", deepseek: "" });
  const [replaceMode, setReplaceMode] = useState<Record<AiProvider, boolean>>({ anthropic: false, openai: false, deepseek: false });

  const [connecting,  setConnecting]  = useState<AiProvider | null>(null);
  const [activating,  setActivating]  = useState<AiProvider | null>(null);
  const [savingModel, setSavingModel] = useState<AiProvider | null>(null);
  const [savedFlash,  setSavedFlash]  = useState<AiProvider | null>(null);
  const [errors,      setErrors]      = useState<Record<AiProvider, string | null>>({ anthropic: null, openai: null, deepseek: null });

  function setErr(id: AiProvider, msg: string | null) {
    setErrors((prev) => ({ ...prev, [id]: msg }));
  }

  function toggleExpand(id: AiProvider) {
    setExpanded((prev) => (prev === id ? null : id));
  }

  async function patch(id: AiProvider, body: Record<string, unknown>) {
    const res  = await fetch("/api/admin/ai-settings", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ provider: id, ...body }),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, json };
  }

  async function handleConnect(id: AiProvider) {
    const key = keyInputs[id].trim();
    if (!key) { setErr(id, "Paste an API key first."); return; }
    setErr(id, null);
    setConnecting(id);
    try {
      const { ok, json } = await patch(id, { key, model: states[id].model });
      if (!ok) { setErr(id, json.error ?? "Failed to validate key"); return; }
      setStates((prev) => ({ ...prev, [id]: { ...prev[id], hasKey: true, lastValidatedAt: new Date().toISOString(), statusReason: null } }));
      setKeyInputs((prev) => ({ ...prev, [id]: "" }));
      setReplaceMode((prev) => ({ ...prev, [id]: false }));
      router.refresh();
    } finally {
      setConnecting(null);
    }
  }

  async function handleSetActive(id: AiProvider) {
    if (!states[id].hasKey) return;
    setErr(id, null);
    setActivating(id);
    try {
      const { ok, json } = await patch(id, { setActive: true });
      if (!ok) { setErr(id, json.error ?? "Failed to activate"); return; }
      setStates((prev) => {
        const next = { ...prev };
        for (const p of PROVIDER_ORDER) next[p] = { ...next[p], isActive: p === id };
        return next;
      });
      router.refresh();
    } finally {
      setActivating(null);
    }
  }

  async function handleSaveModel(id: AiProvider, model: string) {
    setStates((prev) => ({ ...prev, [id]: { ...prev[id], model } }));
    setErr(id, null);
    setSavingModel(id);
    try {
      const { ok, json } = await patch(id, { model });
      if (!ok) { setErr(id, json.error ?? "Failed to save model"); return; }
      setSavedFlash(id);
      setTimeout(() => setSavedFlash((v) => (v === id ? null : v)), 1500);
      router.refresh();
    } finally {
      setSavingModel(null);
    }
  }

  return (
    <div className="space-y-2">
      {PROVIDER_ORDER.map((id) => {
        const meta   = PROVIDER_META[id];
        const state  = states[id];
        const isOpen = expanded === id;
        const isBusy = connecting === id || activating === id;

        return (
          <div
            key={id}
            className={`rounded-lg border overflow-hidden transition-all ${
              state.isActive ? "border-[var(--brand)] shadow-sm" : "border-[var(--border)]"
            }`}
          >
            <div
              className={`flex items-center gap-3 px-4 py-3 cursor-pointer select-none transition-colors ${
                state.isActive ? "bg-[var(--brand)]/5" : "bg-[var(--surface)] hover:bg-[var(--surface-2)]"
              }`}
              onClick={() => toggleExpand(id)}
            >
              {/* Radio — sets ACTIVE for every user, separate click target */}
              <span
                role="radio"
                aria-checked={state.isActive}
                onClick={(e) => { e.stopPropagation(); handleSetActive(id); }}
                className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                  state.isActive
                    ? "border-[var(--brand)] cursor-pointer"
                    : state.hasKey
                    ? "border-[var(--border)] cursor-pointer hover:border-[var(--brand)]/50"
                    : "border-[var(--border)] opacity-40 cursor-not-allowed"
                }`}
              >
                {state.isActive && <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)]" />}
                {activating === id && <Loader2 className="w-2.5 h-2.5 animate-spin text-[var(--brand)]" />}
              </span>

              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.color }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-body font-semibold text-text">{meta.label}</span>
                  {state.hasKey && (
                    <span className="text-micro font-semibold px-1.5 py-0.5 rounded border bg-green-50 border-green-200 text-green-700">
                      KEY SET
                    </span>
                  )}
                  {state.isActive && (
                    <span
                      className="text-micro font-semibold px-1.5 py-0.5 rounded border"
                      style={{ background: `${meta.color}18`, color: meta.color, borderColor: `${meta.color}30` }}
                    >
                      active for all users
                    </span>
                  )}
                </div>
                <p className="text-caption text-text-3 mt-0.5">{meta.tagline}</p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {state.hasKey && !isOpen && (
                  <span className="text-caption text-text-3 hidden sm:block truncate max-w-[150px]">
                    {state.model}
                  </span>
                )}
                {isOpen ? <ChevronUp className="w-4 h-4 text-text-3" /> : <ChevronDown className="w-4 h-4 text-text-3" />}
              </div>
            </div>

            {isOpen && (
              <div className="border-t border-[var(--border)] bg-[var(--surface)] px-4 py-4 space-y-4">
                {state.statusReason && (
                  <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-label text-amber-700">
                    {state.statusReason}
                  </div>
                )}

                {(!state.hasKey || replaceMode[id]) && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-caption font-semibold uppercase tracking-wide text-text-3">API key</label>
                      <a
                        href={meta.helpUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-1 text-caption text-text-3 hover:text-text transition-colors"
                      >
                        Get key <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                    <Input
                      label=""
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={keyInputs[id]}
                      onChange={(e) => setKeyInputs((prev) => ({ ...prev, [id]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && handleConnect(id)}
                      placeholder={meta.placeholder}
                      className="rounded-md bg-[var(--surface-2)] px-3 py-2 text-body font-mono placeholder:text-text-3 focus:ring-2 focus:ring-[var(--brand)]/20 focus:border-[var(--brand)]"
                    />
                    <p className="text-caption text-text-3">
                      Stored encrypted (AES-256-GCM). Used for every user&apos;s analyses while this provider is active.
                    </p>
                  </div>
                )}

                {state.hasKey && !replaceMode[id] && (
                  <div className="text-label text-text-2">
                    Key stored · last validated{" "}
                    <span className="text-text font-medium">
                      {state.lastValidatedAt
                        ? new Date(state.lastValidatedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })
                        : "—"}
                    </span>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-caption font-semibold uppercase tracking-wide text-text-3">Model</label>
                    <span className="flex items-center gap-1 h-4">
                      {savingModel === id && (
                        <span className="flex items-center gap-1 text-caption text-text-3">
                          <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                        </span>
                      )}
                      {savedFlash === id && savingModel !== id && (
                        <span className="flex items-center gap-1 text-caption text-green-600">
                          <Check className="w-3 h-3" /> Saved
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {meta.models.map((m) => {
                      const on = state.model === m.value;
                      return (
                        <button key={m.value} disabled={savingModel === id} onClick={() => { if (state.hasKey) handleSaveModel(id, m.value); else setStates((prev) => ({ ...prev, [id]: { ...prev[id], model: m.value } })); }} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-caption font-medium transition-all disabled:opacity-50 ${ on ? "bg-text text-[var(--surface)] border-text" : "bg-[var(--surface-2)] border-[var(--border)] text-text-2 hover:text-text" }`}>
                          {m.label}
                          <span className={`text-micro px-1 py-0.5 rounded border font-semibold ${on ? "bg-white/20 text-white border-white/20" : TAG_CLS[m.tag]}`}>
                            {m.tag}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {errors[id] && (
                  <p className="text-label text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                    {errors[id]}
                  </p>
                )}

                <div className="flex items-center gap-2 pt-1">
                  {(!state.hasKey || replaceMode[id]) && (
                    <Button variant="brand" size="sm" disabled={isBusy} onClick={() => handleConnect(id)}>
                      {connecting === id
                        ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Validating…</>
                        : state.hasKey ? "Save new key" : "Connect"}
                    </Button>
                  )}

                  {state.hasKey && replaceMode[id] && (
                    <Button size="sm" onClick={() => { setReplaceMode((p) => ({ ...p, [id]: false })); setErr(id, null); }}>
                      Cancel
                    </Button>
                  )}

                  {state.hasKey && !replaceMode[id] && (
                    <Button size="sm" onClick={() => setReplaceMode((p) => ({ ...p, [id]: true }))}>
                      Replace key
                    </Button>
                  )}

                  {state.hasKey && !state.isActive && (
                    <Button
                      size="sm"
                      isLoading={activating === id}
                      disabled={isBusy}
                      onClick={() => handleSetActive(id)}
                    >
                      {activating === id ? "Activating…" : "Make active for all users"}
                    </Button>
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
