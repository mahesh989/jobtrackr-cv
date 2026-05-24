"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, PenLine, Plus, Eye, Pencil } from "lucide-react";

interface TrustComponents {
  ai_pattern_score:             number;
  sentence_variance_score:      number;
  length_appropriateness_score: number;
}

interface SubmitResult {
  trust_score:        number;
  trust_components:   TrustComponents;
  word_count:         number;
  matched_ai_phrases: string[];
  fingerprint:        Record<string, unknown>;
}

interface VoiceProfile {
  id:                       string;
  fingerprint:              Record<string, unknown>;
  voice_sample_raw:         string | null;
  voice_sample_trust_score: number;
  voice_sample_source:      string;
  created_at:               string;
  updated_at:               string;
}

interface Props {
  initialProfile: VoiceProfile | null;
}

type SourceTag = "in_app_capture" | "pasted_cover_letter";

const WORD_MIN = 150;
const WORD_MAX = 600;

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function TrustBadge({ score }: { score: number }) {
  const pct   = Math.round(score * 100);
  const color =
    score >= 0.75 ? "text-emerald-600 bg-emerald-50 border-emerald-200" :
    score >= 0.5  ? "text-amber-600 bg-amber-50 border-amber-200" :
                    "text-red-600 bg-red-50 border-red-200";
  const label =
    score >= 0.75 ? "Strong human signal" :
    score >= 0.5  ? "Some AI phrases detected" :
                    "High AI pattern density";

  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium ${color}`}>
      {score >= 0.75
        ? <CheckCircle2 className="w-4 h-4 shrink-0" />
        : <AlertCircle  className="w-4 h-4 shrink-0" />}
      {pct}% — {label}
    </div>
  );
}

function formalityLabel(score: number): string {
  if (score >= 0.7) return "Formal";
  if (score >= 0.4) return "Professional";
  return "Casual";
}

function sourceLabel(s: string): string {
  if (s === "pasted_cover_letter") return "From a pasted cover letter";
  return "Typed sample";
}

export function VoiceCaptureClient({ initialProfile }: Props) {
  // Editing state — the tab the user is currently typing into. Either tab
  // can be active; only the active one's text gets submitted.
  const [activeTab,  setActiveTab]  = useState<SourceTag>("in_app_capture");
  const [writtenText, setWrittenText] = useState("");
  const [pastedText,  setPastedText]  = useState("");

  const [status,      setStatus]      = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [result,      setResult]      = useState<SubmitResult | null>(null);
  const [errorMsg,    setErrorMsg]    = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);   // Reveal stored sample text
  // First-time users see the form immediately. Existing users see their
  // current sample first and click Edit to open the form.
  const [showForm,    setShowForm]    = useState<boolean>(!initialProfile);

  const text = activeTab === "in_app_capture" ? writtenText : pastedText;
  const setText = activeTab === "in_app_capture" ? setWrittenText : setPastedText;

  const words     = countWords(text);
  const canSubmit = words >= WORD_MIN && status !== "submitting";
  const inRange   = words >= WORD_MIN && words <= WORD_MAX;
  const tooShort  = words > 0 && words < WORD_MIN;

  function startEditing(prefill?: string) {
    // Load the existing sample into whichever tab matches its source — so
    // pasted-cover-letter samples don't get edited under the typed-sample
    // pasting-disabled textarea (and vice versa).
    const source = (initialProfile?.voice_sample_source ?? "in_app_capture") as SourceTag;
    setActiveTab(source);
    if (source === "in_app_capture") setWrittenText(prefill ?? initialProfile?.voice_sample_raw ?? "");
    else                              setPastedText(prefill  ?? initialProfile?.voice_sample_raw ?? "");
    setErrorMsg(null);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus("submitting");
    setErrorMsg(null);

    let provider: string | null = null;
    try { provider = localStorage.getItem("jobtrackr-preferred-provider"); } catch { /* SSR */ }

    try {
      const res  = await fetch("/api/user/voice-profile", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          voice_sample_text: text,
          provider:          provider ?? undefined,
          source:            activeTab,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg((data as { error?: string }).error ?? "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      setResult(data as SubmitResult);
      setStatus("success");
      // Clear both tabs after a successful save.
      setWrittenText("");
      setPastedText("");
    } catch {
      setErrorMsg("Network error. Please try again.");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-6">

      {/* Current profile card — visible when one exists and we're not
          in the post-submit success state. Now shows the actual stored
          sample text (collapsed by default) + Edit button. */}
      {initialProfile && status !== "success" && (
        <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-[var(--text)]">Current writing sample</p>
              <p className="text-[11px] text-[var(--sidebar-text-dim)]">
                {sourceLabel(initialProfile.voice_sample_source)}
                {" · Last updated "}
                {new Date(initialProfile.updated_at).toLocaleDateString("en-GB", {
                  day: "numeric", month: "short", year: "numeric",
                })}
              </p>
            </div>
            <TrustBadge score={initialProfile.voice_sample_trust_score} />
          </div>

          {/* Show / hide the raw sample text. */}
          {initialProfile.voice_sample_raw && (
            <div className="border border-[var(--card-border)] rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setShowCurrent((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] transition-colors"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5" />
                  {showCurrent ? "Hide saved sample" : "View saved sample"}
                </span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showCurrent ? "rotate-180" : ""}`} />
              </button>
              {showCurrent && (
                <div className="border-t border-[var(--card-border)] px-3 py-3 bg-[var(--surface-2)]">
                  <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text-2)] font-sans">
                    {initialProfile.voice_sample_raw}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Edit / Replace controls — only shown when the form isn't already open. */}
          {!showForm && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => startEditing(initialProfile.voice_sample_raw ?? "")}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--brand)] text-[var(--brand)] text-xs font-semibold hover:bg-[var(--brand)] hover:text-[var(--brand-fg)] transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit current sample
              </button>
              <button
                type="button"
                onClick={() => { setActiveTab("in_app_capture"); setWrittenText(""); setPastedText(""); setShowForm(true); setErrorMsg(null); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--card-border)] text-[var(--text-2)] text-xs font-semibold hover:bg-[var(--surface-2)] hover:text-[var(--text)] transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Replace with a new sample
              </button>
              <span className="text-[11px] text-[var(--sidebar-text-dim)] ml-auto">
                Saving any new text replaces the current sample.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Success result (unchanged structure, just kept on this tier) */}
      {status === "success" && result && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            <p className="text-sm font-semibold text-emerald-800">Writing voice saved</p>
          </div>
          <TrustBadge score={result.trust_score} />

          {result.matched_ai_phrases.length > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <span className="font-medium">Phrases that weaken your voice signal: </span>
              {result.matched_ai_phrases.join(", ")}
            </div>
          )}
          {result.trust_score < 0.5 && (
            <p className="text-xs text-red-700">
              This sample has a high AI pattern density. For best results, write freely without editing — your natural voice is what the system needs.
            </p>
          )}
          {result.word_count < WORD_MIN && (
            <p className="text-xs text-amber-700">
              Sample is short ({result.word_count} words). Add more detail for a richer fingerprint.
            </p>
          )}
          <button
            onClick={() => { setStatus("idle"); setResult(null); setShowDetails(false); setShowForm(true); }}
            className="text-xs text-emerald-700 underline hover:no-underline"
          >
            Submit another sample
          </button>

          <div className="border border-[var(--card-border)] rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] transition-colors"
            >
              <span>View what we learned about your writing</span>
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showDetails ? "rotate-180" : ""}`} />
            </button>

            {showDetails && (() => {
              const fp = result.fingerprint as Record<string, unknown>;
              return (
                <div className="border-t border-[var(--card-border)] px-3 py-3 space-y-4 text-xs text-[var(--text-2)]">
                  <div>
                    <p className="font-semibold text-[var(--text)] mb-2">Trust score</p>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span>Overall</span>
                        <span className="tabular-nums font-medium">{Math.round(result.trust_score * 100)}%</span>
                      </div>
                      <div className="flex items-center justify-between text-[var(--text-3)]">
                        <span>Human vs AI patterns</span>
                        <span className="tabular-nums">{Math.round(result.trust_components.ai_pattern_score * 100)}%</span>
                      </div>
                      <div className="flex items-center justify-between text-[var(--text-3)]">
                        <span>Sentence variety</span>
                        <span className="tabular-nums">{Math.round(result.trust_components.sentence_variance_score * 100)}%</span>
                      </div>
                      <div className="flex items-center justify-between text-[var(--text-3)]">
                        <span>Sample length</span>
                        <span className="tabular-nums">{Math.round(result.trust_components.length_appropriateness_score * 100)}%</span>
                      </div>
                    </div>
                  </div>

                  {typeof fp.formality_score === "number" && (
                    <div>
                      <p className="font-semibold text-[var(--text)] mb-1">Formality</p>
                      <div className="flex items-center justify-between">
                        <span>{formalityLabel(fp.formality_score)}</span>
                        <span className="tabular-nums">{Math.round(fp.formality_score * 100)}%</span>
                      </div>
                    </div>
                  )}

                  {Array.isArray(fp.tells) && fp.tells.length > 0 && (
                    <div>
                      <p className="font-semibold text-[var(--text)] mb-1.5">Your writing tells</p>
                      <ul className="space-y-1 list-disc list-inside">
                        {(fp.tells as string[]).slice(0, 5).map((tell, i) => (
                          <li key={i}>{tell}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {result.matched_ai_phrases.length > 0 && (
                    <div>
                      <p className="font-semibold text-[var(--text)] mb-1.5">AI-pattern phrases detected</p>
                      <div className="flex flex-wrap gap-1">
                        {result.matched_ai_phrases.map((phrase) => (
                          <span
                            key={phrase}
                            className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200"
                          >
                            {phrase}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Capture form — dual-input tabs. */}
      {status !== "success" && showForm && (
        <form onSubmit={handleSubmit} className="space-y-3">

          {/* Tabs */}
          <div className="flex border-b border-[var(--card-border)]" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "in_app_capture"}
              onClick={() => setActiveTab("in_app_capture")}
              className={`px-3 py-2 text-[12px] font-semibold border-b-2 -mb-px transition-colors ${
                activeTab === "in_app_capture"
                  ? "border-[var(--brand)] text-[var(--brand)]"
                  : "border-transparent text-[var(--text-2)] hover:text-[var(--text)]"
              }`}
            >
              Write a sample
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "pasted_cover_letter"}
              onClick={() => setActiveTab("pasted_cover_letter")}
              className={`px-3 py-2 text-[12px] font-semibold border-b-2 -mb-px transition-colors ${
                activeTab === "pasted_cover_letter"
                  ? "border-[var(--brand)] text-[var(--brand)]"
                  : "border-transparent text-[var(--text-2)] hover:text-[var(--text)]"
              }`}
            >
              Paste a cover letter
            </button>
            <span className="ml-auto px-2 text-[11px] text-[var(--sidebar-text-dim)] self-center">
              Use whichever feels easier — you only need one.
            </span>
          </div>

          {/* Tab guidance — different copy per tab */}
          {activeTab === "in_app_capture" ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
              <p className="text-[12px] font-semibold text-emerald-800 mb-0.5">
                Recommended — writing fresh in your own voice gives the cleanest signal.
              </p>
              <p className="text-[11px] text-emerald-700 leading-relaxed">
                Type {WORD_MIN}+ words about a project, a problem you've solved, or anything you'd naturally
                talk about. Don't polish, don't proof, don't paraphrase — typos and casual phrasing are
                what give us your real voice. Pasting is disabled on this tab on purpose.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--card-border)] bg-[var(--surface-2)] px-3 py-2.5">
              <p className="text-[12px] font-semibold text-[var(--text)] mb-0.5">
                Works fine — but pasted text tends to be more polished than your real voice.
              </p>
              <p className="text-[11px] text-[var(--text-2)] leading-relaxed">
                Paste a cover letter <span className="font-semibold">you wrote yourself</span> (not one AI generated
                or someone else drafted for you). {WORD_MIN}+ words. We'll still learn from it, but the rewrites
                may come out a bit more buttoned-up than how you actually sound. If you want the warmest result,
                switch to the other tab.
              </p>
            </div>
          )}

          <textarea
            key={activeTab}  /* Force a fresh textarea when switching tabs so paste rules reset */
            id="voice-sample"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={activeTab === "in_app_capture" ? (e) => e.preventDefault() : undefined}
            placeholder={activeTab === "in_app_capture"
              ? "Start typing here…"
              : "Paste your cover letter here…"}
            rows={10}
            className="w-full rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-black placeholder:text-[var(--sidebar-text-dim)] focus:outline-none focus:ring-2 focus:ring-[var(--brand)] resize-y"
          />

          <div className="flex items-center justify-between">
            <span className={`text-xs tabular-nums ${
              inRange   ? "text-emerald-600" :
              tooShort  ? "text-amber-600"   :
                          "text-[var(--sidebar-text-dim)]"
            }`}>
              {words} / {WORD_MIN}+ words
            </span>
            {tooShort && (
              <span className="text-xs text-[var(--sidebar-text-dim)]">
                {WORD_MIN - words} more {WORD_MIN - words === 1 ? "word" : "words"} needed
              </span>
            )}
          </div>

          {errorMsg && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {errorMsg}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--brand)] text-[var(--brand-fg)] text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              {status === "submitting" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Analysing…
                </>
              ) : (
                <>
                  <PenLine className="w-4 h-4" />
                  {initialProfile ? "Save changes" : "Save writing voice"}
                </>
              )}
            </button>

            {initialProfile && status !== "submitting" && (
              <button
                type="button"
                onClick={() => { setShowForm(false); setWrittenText(""); setPastedText(""); setErrorMsg(null); }}
                className="px-3 py-2 rounded-lg text-sm text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
