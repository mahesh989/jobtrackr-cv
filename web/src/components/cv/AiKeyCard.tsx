"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export type AiKeyProvider = "anthropic" | "openai" | "deepseek";

export interface AiKeyState {
  connected:        boolean;
  status?:          string;
  status_reason?:   string | null;
  last_validated_at?: string | null;
  is_enabled?:      boolean;
  model?:           string | null;
}

interface ProviderMeta {
  label:     string;
  tagline:   string;
  placeholder: string;
  helpUrl:   string;
  defaultModel: string;
  models:    { value: string; label: string }[];
}

const META: Record<AiKeyProvider, ProviderMeta> = {
  anthropic: {
    label:       "Anthropic",
    tagline:     "Claude family (Sonnet, Haiku, Opus)",
    placeholder: "sk-ant-...",
    helpUrl:     "https://console.anthropic.com/account/keys",
    defaultModel: "claude-3-5-sonnet-20241022",
    models: [
      { value: "claude-sonnet-4-6",           label: "Claude Sonnet 4.6 (latest, balanced)" },
      { value: "claude-opus-4-7",             label: "Claude Opus 4.7 (most capable)" },
      { value: "claude-haiku-4-5-20251001",   label: "Claude Haiku 4.5 (fastest, cheapest)" },
      { value: "claude-3-5-sonnet-20241022",  label: "Claude 3.5 Sonnet (legacy default)" },
    ],
  },
  openai: {
    label:       "OpenAI",
    tagline:     "GPT-5 family + reasoning (o-series)",
    placeholder: "sk-...",
    helpUrl:     "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.2",
    models: [
      { value: "gpt-5.2",       label: "GPT-5.2 (recommended)" },
      { value: "gpt-5.2-pro",   label: "GPT-5.2 Pro (most capable)" },
      { value: "gpt-5-mini",    label: "GPT-5 mini (cheap)" },
      { value: "gpt-5.4",       label: "GPT-5.4 (newer)" },
      { value: "gpt-5.4-pro",   label: "GPT-5.4 Pro" },
      { value: "gpt-5.5",       label: "GPT-5.5 (latest)" },
      { value: "gpt-4o",        label: "GPT-4o (legacy)" },
      { value: "o1",            label: "o1 (reasoning)" },
      { value: "o3-mini",       label: "o3-mini (reasoning, cheap)" },
    ],
  },
  deepseek: {
    label:       "DeepSeek",
    tagline:     "deepseek-chat & deepseek-reasoner",
    placeholder: "sk-...",
    helpUrl:     "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    models: [
      { value: "deepseek-chat",      label: "deepseek-chat" },
      { value: "deepseek-reasoner",  label: "deepseek-reasoner" },
    ],
  },
};

const CUSTOM_SENTINEL = "__custom__";

interface Props {
  provider: AiKeyProvider;
  initial:  AiKeyState;
}

export function AiKeyCard({ provider, initial }: Props) {
  const router = useRouter();
  const meta = META[provider];
  const [state, setState]           = useState<AiKeyState>(initial);
  const [showInput, setShowInput]   = useState(!initial.connected);
  const [key, setKey]               = useState("");
  const [error, setError]           = useState<string | null>(null);
  const [pending, startTransition]  = useTransition();

  // Model selection
  const initialModel = initial.model ?? null;
  const isCustomInitial =
    initialModel !== null && !meta.models.some((m) => m.value === initialModel);
  const [modelChoice, setModelChoice] = useState<string>(
    isCustomInitial ? CUSTOM_SENTINEL : (initialModel ?? meta.defaultModel),
  );
  const [customModel, setCustomModel] = useState<string>(
    isCustomInitial ? initialModel : "",
  );
  const [modelSavedFlash, setModelSavedFlash] = useState(false);

  const effectiveModel =
    modelChoice === CUSTOM_SENTINEL ? customModel.trim() : modelChoice;
  const modelChanged = (state.model ?? meta.defaultModel) !== effectiveModel;

  async function saveModel() {
    setError(null);
    if (modelChoice === CUSTOM_SENTINEL && customModel.trim() === "") {
      setError("Enter a model name or pick from the list.");
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/integrations/ai-keys/${provider}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model: effectiveModel }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error ?? "Failed to save model"); return; }
      setState((s) => ({ ...s, model: effectiveModel }));
      setModelSavedFlash(true);
      setTimeout(() => setModelSavedFlash(false), 1500);
    });
  }

  async function handleConnect() {
    setError(null);
    if (!key.trim()) { setError("Paste a key first."); return; }
    if (modelChoice === CUSTOM_SENTINEL && customModel.trim() === "") {
      setError("Enter a model name or pick one from the list.");
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/integrations/ai-keys/${provider}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ key, model: effectiveModel }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Failed (${res.status})`);
        return;
      }
      setState({
        connected: true,
        status: "valid",
        last_validated_at: new Date().toISOString(),
        model: effectiveModel,
      });
      setKey("");
      setShowInput(false);
      router.refresh();
    });
  }

  async function handleDisconnect() {
    if (!confirm(`Disconnect ${meta.label}?`)) return;
    startTransition(async () => {
      const res = await fetch(`/api/integrations/ai-keys/${provider}`, { method: "DELETE" });
      if (!res.ok) { setError("Disconnect failed — try again."); return; }
      setState({ connected: false });
      setShowInput(true);
      router.refresh();
    });
  }

  const isValid = state.connected && state.status === "valid";

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-border bg-surface-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-text">{meta.label}</span>
            {isValid && (
              <span className="text-[10px] text-green bg-green-light border border-green/20 px-1.5 py-0.5 rounded">
                CONNECTED
              </span>
            )}
          </div>
          <p className="text-[12px] text-text-2 mt-0.5">{meta.tagline}</p>
        </div>
        <a
          href={meta.helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-text-3 hover:underline shrink-0"
        >
          Get key ↗
        </a>
      </div>

      <div className="px-5 py-5 space-y-3">
        {state.connected && !showInput && (
          <>
            <div className="text-[12px] text-text-2">
              Key stored, last validated{" "}
              {state.last_validated_at
                ? new Date(state.last_validated_at).toLocaleDateString("en-AU", {
                    day: "numeric", month: "short", year: "numeric",
                  })
                : "—"}.
            </div>
            {state.status_reason && (
              <div className="rounded-md bg-amber-light border border-amber/20 px-3 py-2 text-[12px] text-amber">
                {state.status_reason}
              </div>
            )}

            {/* Model selector */}
            <ModelPicker
              meta={meta}
              modelChoice={modelChoice}
              customModel={customModel}
              setModelChoice={setModelChoice}
              setCustomModel={setCustomModel}
            />
            {modelChanged && (
              <button
                onClick={saveModel}
                disabled={pending}
                className="gh-btn gh-btn-primary text-[12px]"
              >
                {pending ? "Saving…" : "Save model"}
              </button>
            )}
            {modelSavedFlash && (
              <p className="text-[11px] text-[#1A7F37]">Model saved.</p>
            )}

            <div className="flex gap-2 pt-1">
              <button onClick={() => setShowInput(true)} className="gh-btn text-[12px]" disabled={pending}>
                Replace key
              </button>
              <button onClick={handleDisconnect} className="gh-btn gh-btn-danger text-[12px]" disabled={pending}>
                Disconnect
              </button>
            </div>
          </>
        )}

        {showInput && (
          <>
            <div>
              <label className="block text-[12px] text-text-2 mb-1.5" htmlFor={`${provider}-key`}>
                API key
              </label>
              <input
                id={`${provider}-key`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={meta.placeholder}
                className="w-full bg-surface border border-border rounded-md px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-accent/30 font-mono"
              />
              <p className="text-[11px] text-text-3 mt-1.5">
                Stored encrypted (AES-256-GCM). The browser never receives it back.
              </p>
            </div>
            <ModelPicker
              meta={meta}
              modelChoice={modelChoice}
              customModel={customModel}
              setModelChoice={setModelChoice}
              setCustomModel={setCustomModel}
            />
            {error && (
              <div className="rounded-md bg-red-light border border-red/20 px-3 py-2 text-[12px] text-red">
                {error}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleConnect}
                disabled={pending}
                className="gh-btn gh-btn-primary text-[12px]"
              >
                {pending ? "Validating…" : (state.connected ? "Save new key" : "Connect")}
              </button>
              {state.connected && (
                <button onClick={() => { setShowInput(false); setKey(""); setError(null); }} className="gh-btn text-[12px]" disabled={pending}>
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── ModelPicker ─────────────────────────────────────────────────────────────

function ModelPicker({
  meta, modelChoice, customModel, setModelChoice, setCustomModel,
}: {
  meta:            ProviderMeta;
  modelChoice:     string;
  customModel:     string;
  setModelChoice:  (v: string) => void;
  setCustomModel:  (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-[12px] text-text-2 mb-1.5">Model</label>
      <select
        value={modelChoice}
        onChange={(e) => setModelChoice(e.target.value)}
        className="w-full bg-surface border border-border rounded-md px-3 py-2 text-[13px] text-text focus:outline-none focus:ring-2 focus:ring-accent/30"
      >
        {meta.models.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
        <option value={CUSTOM_SENTINEL}>Other (enter manually)…</option>
      </select>
      {modelChoice === CUSTOM_SENTINEL && (
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={customModel}
          onChange={(e) => setCustomModel(e.target.value)}
          placeholder="e.g. gpt-5.1-mini"
          className="mt-2 w-full bg-surface border border-border rounded-md px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-accent/30 font-mono"
        />
      )}
      <p className="text-[11px] text-text-3 mt-1.5">
        Used for all analysis steps on this provider. Pick from the list above or
        enter any model name your account has access to.
      </p>
    </div>
  );
}
