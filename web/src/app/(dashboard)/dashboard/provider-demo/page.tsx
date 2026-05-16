"use client";

/**
 * DEMO PAGE — /dashboard/_provider-demo
 * Visual mockup of provider-picker options. Delete this file once design is picked.
 */

import { useState } from "react";
import { Sparkles, ChevronDown, Check } from "lucide-react";

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic",  model: "Claude Sonnet 4.6",    color: "#b86a00" },
  { id: "openai",    label: "OpenAI",     model: "GPT-5.2",              color: "#10a37f" },
  { id: "deepseek",  label: "DeepSeek",   model: "deepseek-chat",        color: "#4d6ef5" },
];

/* ─── shared styles ──────────────────────────────────────────── */
const pillStyle = (color: string) =>
  `inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded` +
  ` border border-[${color}]/25 bg-[${color}]/10 text-[${color}]`;

/* ══════════════════════════════════════════════════════════════════
   OPTION A — Split button
   Left half fires with top-priority provider.
   Right ▾ opens a provider list.
   ══════════════════════════════════════════════════════════════════ */
function OptionA() {
  const [open, setOpen]         = useState(false);
  const [chosen, setChosen]     = useState<string | null>(null);
  const [fired, setFired]       = useState(false);

  function fire(id?: string) {
    setChosen(id ?? null);
    setOpen(false);
    setFired(true);
    setTimeout(() => setFired(false), 1400);
  }

  const active = chosen ? PROVIDERS.find((p) => p.id === chosen) : PROVIDERS[0];

  return (
    <div className="relative inline-flex items-center">
      {/* Left: primary action */}
      <button
        onClick={() => fire()}
        className={`flex items-center gap-1.5 rounded-l-md px-2.5 py-1 text-xs font-medium transition-opacity border border-r-0
          ${fired
            ? "bg-green-600 text-white border-green-600"
            : "bg-[var(--brand)] text-[var(--brand-fg)] border-[var(--brand)]"}
        `}
      >
        {fired
          ? <Check className="h-3.5 w-3.5" />
          : <Sparkles className="h-3.5 w-3.5" />}
        {fired ? "Started!" : "Analyze"}
      </button>

      {/* Right: chevron to pick provider */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center px-1.5 py-1 rounded-r-md border border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)] hover:opacity-80 transition-opacity"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[220px] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1">
            <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-3">
              Analyze with…
            </p>
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                onClick={() => fire(p.id)}
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[var(--surface-2)] transition-colors text-left"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-text">{p.label}</p>
                  <p className="text-[11px] text-text-3 truncate">{p.model}</p>
                </div>
                {active?.id === p.id && !chosen && (
                  <span className="text-[10px] text-text-3">default</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   OPTION B — Single dropdown button (always opens menu)
   ══════════════════════════════════════════════════════════════════ */
function OptionB() {
  const [open, setOpen]     = useState(false);
  const [fired, setFired]   = useState<string | null>(null);

  function fire(id: string) {
    setOpen(false);
    setFired(id);
    setTimeout(() => setFired(null), 1400);
  }

  return (
    <div className="relative inline-flex">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium
          bg-[var(--brand)] text-[var(--brand-fg)] border border-[var(--brand)] hover:opacity-90 transition-opacity"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Analyze
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[220px] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                onClick={() => fire(p.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 transition-colors text-left
                  ${fired === p.id ? "bg-green-50 text-green-700" : "hover:bg-[var(--surface-2)]"}`}
              >
                {fired === p.id
                  ? <Check className="h-4 w-4 text-green-600 shrink-0" />
                  : <Sparkles className="h-4 w-4 text-[var(--brand)] shrink-0 opacity-60" />}
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-text">{p.label}</p>
                  <p className="text-[11px] text-text-3 truncate">{p.model}</p>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   OPTION C — Inline select + button
   ══════════════════════════════════════════════════════════════════ */
function OptionC() {
  const [selected, setSelected] = useState("anthropic");
  const [fired, setFired]       = useState(false);

  function fire() {
    setFired(true);
    setTimeout(() => setFired(false), 1400);
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        style={{ width: "auto", height: "28px", fontSize: "11px", flexShrink: 0,
          border: "1px solid var(--border)", borderRadius: "6px",
          background: "var(--surface)", color: "var(--text)",
          paddingLeft: "6px", paddingRight: "6px" }}
      >
        {PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>{p.label} · {p.model}</option>
        ))}
      </select>

      <button
        onClick={fire}
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-all
          ${fired
            ? "bg-green-600 text-white border-green-600"
            : "bg-[var(--brand)] text-[var(--brand-fg)] border-[var(--brand)] hover:opacity-90"}`}
      >
        {fired ? <Check className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
        {fired ? "Started!" : "Analyze"}
      </button>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   Demo page
   ══════════════════════════════════════════════════════════════════ */
export default function ProviderDemoPage() {
  return (
    <div className="min-h-full px-8 py-10 space-y-12">
      <div>
        <h1 className="text-lg font-semibold text-text mb-1">Provider picker — design options</h1>
        <p className="text-sm text-text-2">Each option is interactive. Pick one, then delete this page.</p>
      </div>

      {/* ── Simulated job row ──────────────────────────────────────── */}
      {[
        { label: "Option A", sub: "Split button — one click fires default, chevron opens picker (recommended)", node: <OptionA /> },
        { label: "Option B", sub: "Single dropdown — always shows provider menu before firing", node: <OptionB /> },
        { label: "Option C", sub: "Inline select + button — provider visible at a glance, extra width", node: <OptionC /> },
      ].map(({ label, sub, node }) => (
        <div key={label} className="space-y-3">
          <div>
            <p className="text-[13px] font-semibold text-text">{label}</p>
            <p className="text-[12px] text-text-2">{sub}</p>
          </div>

          {/* Fake table row */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
            {/* header */}
            <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-[var(--surface-2)] border-b border-[var(--border)] text-[10px] font-semibold uppercase tracking-wider text-text-3">
              <div className="col-span-4">Role</div>
              <div className="col-span-3">Company</div>
              <div className="col-span-2 text-center">Posted</div>
              <div className="col-span-3 text-right">Actions</div>
            </div>
            {/* row */}
            <div className="grid grid-cols-12 gap-2 px-4 py-3 items-center">
              <div className="col-span-4">
                <p className="text-[13px] font-semibold text-text">Senior Software Engineer</p>
                <p className="text-[11px] text-text-3">Sydney, NSW</p>
              </div>
              <div className="col-span-3">
                <p className="text-[12px] font-medium text-text">Atlassian</p>
              </div>
              <div className="col-span-2 flex justify-center">
                <span className="text-[11px] text-text-3">2d ago</span>
              </div>
              <div className="col-span-3 flex justify-end gap-1.5 items-center">
                {node}
                {/* ⋮ stub */}
                <button className="gh-btn p-1.5 text-text-3 hover:text-text">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 4 16" fill="currentColor">
                    <circle cx="2" cy="2" r="1.5"/><circle cx="2" cy="8" r="1.5"/><circle cx="2" cy="14" r="1.5"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}

      <p className="text-[11px] text-text-3 pt-4">
        Route: <code className="font-mono">/dashboard/_provider-demo</code> — delete{" "}
        <code className="font-mono">web/src/app/(dashboard)/dashboard/_provider-demo/</code> when done.
      </p>
    </div>
  );
}
