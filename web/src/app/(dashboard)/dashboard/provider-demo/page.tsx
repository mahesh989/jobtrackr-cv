"use client";

/**
 * DEMO — /dashboard/provider-demo
 * 3 options for provider + model selection on the Integrations page.
 * Delete once design is chosen.
 */

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Sparkles } from "lucide-react";

const PROVIDERS = [
  {
    id: "anthropic", label: "Anthropic", color: "#b86a00",
    models: [
      { value: "claude-sonnet-4-6",          label: "Claude Sonnet 4.6",       tag: "recommended" },
      { value: "claude-opus-4-7",            label: "Claude Opus 4.7",         tag: "most capable" },
      { value: "claude-haiku-4-5",           label: "Claude Haiku 4.5",        tag: "fastest" },
      { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet",       tag: "legacy" },
    ],
  },
  {
    id: "openai", label: "OpenAI", color: "#10a37f",
    models: [
      { value: "gpt-5.2",     label: "GPT-5.2",      tag: "recommended" },
      { value: "gpt-5.2-pro", label: "GPT-5.2 Pro",  tag: "most capable" },
      { value: "gpt-5-mini",  label: "GPT-5 mini",   tag: "cheap" },
      { value: "o3-mini",     label: "o3-mini",       tag: "reasoning" },
    ],
  },
  {
    id: "deepseek", label: "DeepSeek", color: "#4d6ef5",
    models: [
      { value: "deepseek-chat",      label: "deepseek-chat",      tag: "default" },
      { value: "deepseek-reasoner",  label: "deepseek-reasoner",  tag: "reasoning" },
    ],
  },
];

const TAG_STYLE: Record<string, string> = {
  recommended:   "bg-[var(--brand)]/10 text-[var(--brand)] border-[var(--brand)]/20",
  "most capable":"bg-purple-100 text-purple-700 border-purple-200",
  fastest:       "bg-green-50 text-green-700 border-green-200",
  cheap:         "bg-green-50 text-green-700 border-green-200",
  reasoning:     "bg-blue-50 text-blue-700 border-blue-200",
  legacy:        "bg-gray-100 text-gray-500 border-gray-200",
  default:       "bg-gray-100 text-gray-500 border-gray-200",
};

/* ══════════════════════════════════════════════════════════════
   OPTION A
   Provider pills on top → model pills appear inline below
   Two separate rows, same visual language as status tabs
   ══════════════════════════════════════════════════════════════ */
function OptionA() {
  const [provider, setProvider] = useState("anthropic");
  const [models,   setModels]   = useState<Record<string, string>>({
    anthropic: "claude-sonnet-4-6",
    openai:    "gpt-5.2",
    deepseek:  "deepseek-chat",
  });

  const current  = PROVIDERS.find((p) => p.id === provider)!;
  const modelList = current.models;

  return (
    <div className="space-y-3">
      {/* Row 1 — provider */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3 w-[110px]">
          Provider
        </span>
        <div className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-md p-0.5">
          {PROVIDERS.map((p) => {
            const on = provider === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setProvider(p.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded text-[12px] font-medium transition-all ${
                  on ? "bg-[var(--surface)] text-text shadow-sm border border-[var(--border)]"
                     : "text-text-2 hover:text-text"
                }`}
              >
                {on && <Check className="w-3 h-3" style={{ color: p.color }} />}
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Row 2 — model (updates when provider changes) */}
      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3 w-[110px] pt-1">
          Model
        </span>
        <div className="flex flex-wrap gap-1.5">
          {modelList.map((m) => {
            const on = models[provider] === m.value;
            return (
              <button
                key={m.value}
                onClick={() => setModels((prev) => ({ ...prev, [provider]: m.value }))}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-all ${
                  on
                    ? "bg-text text-[var(--surface)] border-text"
                    : "bg-[var(--surface)] border-[var(--border)] text-text-2 hover:text-text"
                }`}
              >
                {m.label}
                {m.tag && (
                  <span className={`text-[9px] px-1 py-0.5 rounded border font-semibold ${
                    on ? "bg-white/20 text-white border-white/20" : TAG_STYLE[m.tag]
                  }`}>
                    {m.tag}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-[11px] text-text-3 pl-[118px]">
        All analyses will use <strong>{current.label}</strong> · {modelList.find((m) => m.value === models[provider])?.label}
      </p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   OPTION B
   Single compact dropdown — opens a 2-column panel:
   left = provider list, right = model list for selected provider
   ══════════════════════════════════════════════════════════════ */
function OptionB() {
  const [open,     setOpen]     = useState(false);
  const [provider, setProvider] = useState("anthropic");
  const [models,   setModels]   = useState<Record<string, string>>({
    anthropic: "claude-sonnet-4-6",
    openai:    "gpt-5.2",
    deepseek:  "deepseek-chat",
  });
  const [hover, setHover] = useState("anthropic");

  const activeProv  = PROVIDERS.find((p) => p.id === provider)!;
  const activeModel = activeProv.models.find((m) => m.value === models[provider])!;
  const hoverProv   = PROVIDERS.find((p) => p.id === hover)!;

  function pick(pId: string, mVal: string) {
    setProvider(pId);
    setModels((prev) => ({ ...prev, [pId]: mVal }));
    setOpen(false);
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-text-3 font-medium">Preferred</span>
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] text-[12px] font-medium text-text hover:bg-[var(--surface-2)] transition-colors"
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: activeProv.color }} />
          {activeProv.label}
          <span className="text-text-3">·</span>
          <span className="text-text-2">{activeModel.label}</span>
          <ChevronDown className="w-3.5 h-3.5 text-text-3 ml-0.5" />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-full mt-1 z-50 flex rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl overflow-hidden">
              {/* Left — providers */}
              <div className="w-[140px] border-r border-[var(--border)] py-1 bg-[var(--surface-2)]">
                <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-3">Provider</p>
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    onMouseEnter={() => setHover(p.id)}
                    onClick={() => setHover(p.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                      hover === p.id ? "bg-[var(--surface)] text-text" : "text-text-2 hover:text-text"
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
                    <span className="text-[12px] font-medium">{p.label}</span>
                    {provider === p.id && <Check className="w-3 h-3 ml-auto text-[var(--brand)]" />}
                    {hover === p.id && provider !== p.id && <ChevronRight className="w-3 h-3 ml-auto text-text-3" />}
                  </button>
                ))}
              </div>

              {/* Right — models for hovered provider */}
              <div className="w-[220px] py-1">
                <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-3">
                  {hoverProv.label} models
                </p>
                {hoverProv.models.map((m) => {
                  const selected = provider === hoverProv.id && models[hoverProv.id] === m.value;
                  return (
                    <button
                      key={m.value}
                      onClick={() => pick(hoverProv.id, m.value)}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-2)] ${
                        selected ? "text-text" : "text-text-2"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium truncate">{m.label}</p>
                      </div>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold shrink-0 ${TAG_STYLE[m.tag]}`}>
                        {m.tag}
                      </span>
                      {selected && <Check className="w-3 h-3 text-[var(--brand)] shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   OPTION C
   Accordion cards — click a provider to expand model list inside
   ══════════════════════════════════════════════════════════════ */
function OptionC() {
  const [provider, setProvider] = useState("anthropic");
  const [models,   setModels]   = useState<Record<string, string>>({
    anthropic: "claude-sonnet-4-6",
    openai:    "gpt-5.2",
    deepseek:  "deepseek-chat",
  });

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-text-3 font-medium">Preferred provider &amp; model</p>
      {PROVIDERS.map((p) => {
        const active      = provider === p.id;
        const activeModel = p.models.find((m) => m.value === models[p.id])!;

        return (
          <div
            key={p.id}
            className={`rounded-lg border transition-all overflow-hidden ${
              active
                ? "border-[var(--brand)] shadow-sm"
                : "border-[var(--border)] opacity-70 hover:opacity-100"
            }`}
          >
            {/* Header — click to expand */}
            <button
              onClick={() => setProvider(p.id)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                active ? "bg-[var(--brand)]/5" : "bg-[var(--surface)] hover:bg-[var(--surface-2)]"
              }`}
            >
              {/* radio */}
              <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                active ? "border-[var(--brand)]" : "border-[var(--border)]"
              }`}>
                {active && <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)]" />}
              </span>
              <span className="text-[13px] font-semibold text-text">{p.label}</span>
              {!active && (
                <span className="ml-auto text-[11px] text-text-3">
                  {activeModel.label}
                </span>
              )}
              {active && (
                <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded border"
                  style={{ background: `${p.color}15`, color: p.color, borderColor: `${p.color}30` }}>
                  active
                </span>
              )}
            </button>

            {/* Expanded — model grid */}
            {active && (
              <div className="px-4 pb-3 pt-1 border-t border-[var(--border)] bg-[var(--surface)]">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-3 mb-2">Select model</p>
                <div className="flex flex-wrap gap-1.5">
                  {p.models.map((m) => {
                    const on = models[p.id] === m.value;
                    return (
                      <button
                        key={m.value}
                        onClick={() => setModels((prev) => ({ ...prev, [p.id]: m.value }))}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium transition-all ${
                          on
                            ? "bg-text text-[var(--surface)] border-text"
                            : "bg-[var(--surface-2)] border-[var(--border)] text-text-2 hover:text-text"
                        }`}
                      >
                        {m.label}
                        <span className={`text-[9px] px-1 py-0.5 rounded border font-semibold ${
                          on ? "bg-white/20 text-white border-white/20" : TAG_STYLE[m.tag]
                        }`}>
                          {m.tag}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Fake AiKeyCard shell
   ══════════════════════════════════════════════════════════════ */
function FakeCard({ label, tagline, connected }: {
  label: string; tagline: string; connected: boolean;
}) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-md overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-[var(--border)] bg-[var(--surface-2)]">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-text">{label}</span>
            {connected && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-green-50 border-green-200 text-green-700">
                CONNECTED
              </span>
            )}
          </div>
          <p className="text-[11px] text-text-3 mt-0.5">{tagline}</p>
        </div>
      </div>
      <div className="px-5 py-2.5">
        <p className="text-[11px] text-text-2">
          {connected ? "Key stored · last validated 14 May 2026" : "Not connected — add a key to enable."}
        </p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Page
   ══════════════════════════════════════════════════════════════ */
const OPTIONS = [
  {
    key: "A",
    label: "Option A — Two rows (provider pills → model pills)",
    sub:   "Provider tabs on top, model pills slide in below. Clean & label-driven.",
    node:  <OptionA />,
  },
  {
    key: "B",
    label: "Option B — Split-panel dropdown",
    sub:   "One compact button. Click opens a 2-column flyout: providers on left, models on right.",
    node:  <OptionB />,
  },
  {
    key: "C",
    label: "Option C — Accordion cards",
    sub:   "Each provider is a card. Click to expand and reveal model options inside.",
    node:  <OptionC />,
  },
];

export default function ProviderDemoPage() {
  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-12">

        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-[var(--brand)]" />
            <h1 className="text-lg font-semibold text-text">Provider + model picker — 3 options</h1>
          </div>
          <p className="text-[13px] text-text-2">
            Each option lets you pick both a provider and a model. Shown in the Integrations page context.
          </p>
        </div>

        {OPTIONS.map(({ key, label, sub, node }) => (
          <div key={key} className="space-y-3">
            <div>
              <p className="text-[13px] font-semibold text-text">{label}</p>
              <p className="text-[12px] text-text-2">{sub}</p>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-6 py-5 space-y-5">
              <div>
                <h2 className="text-[13px] font-semibold text-text mb-0.5">AI providers</h2>
                <p className="text-[12px] text-text-3 mb-4">
                  Bring your own key. Choose your preferred provider and model for all analyses.
                </p>
                {node}
              </div>

              <div className="space-y-2 pt-2 border-t border-[var(--border)]">
                <FakeCard label="Anthropic" tagline="Claude family (Sonnet, Haiku, Opus)" connected />
                <FakeCard label="OpenAI"    tagline="GPT-5 family + reasoning (o-series)"  connected />
                <FakeCard label="DeepSeek"  tagline="deepseek-chat & deepseek-reasoner"    connected={false} />
              </div>
            </div>
          </div>
        ))}

        <p className="text-[11px] text-text-3">
          Demo route: <code className="font-mono">/dashboard/provider-demo</code> — delete when done.
        </p>
      </div>
    </div>
  );
}
