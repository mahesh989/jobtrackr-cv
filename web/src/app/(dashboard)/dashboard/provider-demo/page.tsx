"use client";

/**
 * DEMO — /dashboard/provider-demo
 * Shows 3 UI options for picking a preferred AI provider on the Integrations page.
 * Delete once design is chosen.
 */

import { useState } from "react";
import { Check, ChevronDown, Sparkles, Zap } from "lucide-react";

const CONNECTED = [
  { id: "anthropic", label: "Anthropic", model: "Claude Sonnet 4.6", color: "var(--brand)" },
  { id: "openai",    label: "OpenAI",    model: "GPT-5.2",           color: "#10a37f"      },
  { id: "deepseek",  label: "DeepSeek",  model: "deepseek-chat",     color: "#4d6ef5"      },
];

/* ══════════════════════════════════════════════════════════════
   OPTION A — Segmented pill tabs  (like the status tabs)
   ══════════════════════════════════════════════════════════════ */
function OptionA() {
  const [active, setActive] = useState("anthropic");
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[12px] text-text-3 font-medium">Preferred provider</span>
      <div className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-md p-0.5">
        {CONNECTED.map((p) => {
          const on = active === p.id;
          return (
            <button
              key={p.id}
              onClick={() => setActive(p.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded text-[12px] font-medium transition-all ${
                on
                  ? "bg-[var(--surface)] text-text shadow-sm border border-[var(--border)]"
                  : "text-text-2 hover:text-text"
              }`}
            >
              {on && <Check className="w-3 h-3 text-[var(--brand)]" />}
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   OPTION B — Compact dropdown select
   ══════════════════════════════════════════════════════════════ */
function OptionB() {
  const [open, setOpen]     = useState(false);
  const [active, setActive] = useState("anthropic");
  const current = CONNECTED.find((p) => p.id === active)!;

  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-text-3 font-medium">Preferred provider</span>
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] text-[12px] font-medium text-text hover:bg-[var(--surface-2)] transition-colors"
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: current.color }} />
          {current.label}
          <span className="text-[11px] text-text-3">· {current.model}</span>
          <ChevronDown className="w-3.5 h-3.5 text-text-3" />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-full mt-1 z-50 min-w-[220px] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1">
              {CONNECTED.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { setActive(p.id); setOpen(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[var(--surface-2)] transition-colors text-left"
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-text">{p.label}</p>
                    <p className="text-[11px] text-text-3">{p.model}</p>
                  </div>
                  {active === p.id && <Check className="w-3.5 h-3.5 text-[var(--brand)] shrink-0" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   OPTION C — Radio cards  (click a card to activate)
   ══════════════════════════════════════════════════════════════ */
function OptionC() {
  const [active, setActive] = useState("anthropic");
  return (
    <div className="space-y-2">
      <p className="text-[12px] text-text-3 font-medium">Preferred provider</p>
      <div className="flex gap-2 flex-wrap">
        {CONNECTED.map((p) => {
          const on = active === p.id;
          return (
            <button
              key={p.id}
              onClick={() => setActive(p.id)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-all ${
                on
                  ? "border-[var(--brand)] bg-[var(--brand)]/5 shadow-sm"
                  : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)]"
              }`}
            >
              <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                on ? "border-[var(--brand)]" : "border-[var(--border)]"
              }`}>
                {on && <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)]" />}
              </span>
              <div>
                <p className="text-[12px] font-medium text-text leading-none">{p.label}</p>
                <p className="text-[10px] text-text-3 mt-0.5">{p.model}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Fake AiKeyCard shell
   ══════════════════════════════════════════════════════════════ */
function FakeCard({ label, model, tagline, connected }: {
  label: string; model: string; tagline: string; connected: boolean;
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
      <div className="px-5 py-3">
        <p className="text-[11px] text-text-2">
          {connected ? `Model: ${model}` : "Not connected — add a key to enable."}
        </p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Demo page
   ══════════════════════════════════════════════════════════════ */
const OPTIONS = [
  {
    key: "A",
    label: "Option A — Pill tabs",
    sub: "Compact segmented control, same style as the Active / New / Applied status tabs",
    node: <OptionA />,
  },
  {
    key: "B",
    label: "Option B — Dropdown",
    sub: "Single button showing the active provider + model. Click to switch.",
    node: <OptionB />,
  },
  {
    key: "C",
    label: "Option C — Radio cards",
    sub: "Clickable cards — one per provider. Active one gets a brand-colour border.",
    node: <OptionC />,
  },
];

export default function ProviderDemoPage() {
  return (
    <div className="min-h-full px-6 pt-6 pb-24">
      <div className="max-w-3xl mx-auto space-y-12">

        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-[var(--brand)]" />
            <h1 className="text-lg font-semibold text-text">Preferred provider — Integrations page mockup</h1>
          </div>
          <p className="text-[13px] text-text-2">
            Each option shows how the selector sits above the AI provider cards.
            The Analyze button on the job board stays visually unchanged.
          </p>
        </div>

        {OPTIONS.map(({ key, label, sub, node }) => (
          <div key={key} className="space-y-3">
            <div>
              <p className="text-[13px] font-semibold text-text">{label}</p>
              <p className="text-[12px] text-text-2">{sub}</p>
            </div>

            {/* Simulated integrations section */}
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 px-6 py-5 space-y-4">
              <div>
                <h2 className="text-[13px] font-semibold text-text mb-0.5">AI providers</h2>
                <p className="text-[12px] text-text-3 mb-4">
                  Bring your own key. Set a preferred provider for all analyses.
                </p>
                {node}
              </div>

              <div className="space-y-2 pt-1 border-t border-[var(--border)]">
                <FakeCard label="Anthropic" model="Claude Sonnet 4.6" tagline="Claude family (Sonnet, Haiku, Opus)" connected />
                <FakeCard label="OpenAI"    model="GPT-5.2"           tagline="GPT-5 family + reasoning (o-series)"  connected />
                <FakeCard label="DeepSeek"  model="deepseek-chat"     tagline="deepseek-chat & deepseek-reasoner" connected={false} />
              </div>
            </div>
          </div>
        ))}

        <p className="text-[11px] text-text-3 pt-2 flex items-center gap-1.5">
          <Zap className="w-3 h-3" />
          Demo route: <code className="font-mono">/dashboard/provider-demo</code> — delete when done.
        </p>
      </div>
    </div>
  );
}
