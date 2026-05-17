"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Mic } from "lucide-react";

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
  voice_sample_trust_score: number;
  voice_sample_source:      string;
  created_at:               string;
  updated_at:               string;
}

interface Props {
  initialProfile: VoiceProfile | null;
}

const WORD_MIN = 150;
const WORD_MAX = 300;

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

export function VoiceCaptureClient({ initialProfile }: Props) {
  const [text,     setText]     = useState("");
  const [status,   setStatus]   = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [result,   setResult]   = useState<SubmitResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const words      = countWords(text);
  const canSubmit  = words >= WORD_MIN && status !== "submitting";
  const inRange    = words >= WORD_MIN && words <= WORD_MAX;
  const tooShort   = words > 0 && words < WORD_MIN;

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
        body:    JSON.stringify({ voice_sample_text: text, provider: provider ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg((data as { error?: string }).error ?? "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      setResult(data as SubmitResult);
      setStatus("success");
      setText("");
    } catch {
      setErrorMsg("Network error. Please try again.");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-6">

      {/* Existing profile banner */}
      {initialProfile && status !== "success" && (
        <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-4 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm font-medium text-[var(--sidebar-text-hover)]">Current voice profile</p>
            <TrustBadge score={initialProfile.voice_sample_trust_score} />
          </div>
          <p className="text-xs text-[var(--sidebar-text-dim)]">
            Last updated{" "}
            {new Date(initialProfile.updated_at).toLocaleDateString("en-GB", {
              day: "numeric", month: "short", year: "numeric",
            })}
          </p>
        </div>
      )}

      {/* Success result */}
      {status === "success" && result && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            <p className="text-sm font-semibold text-emerald-800">Voice profile saved</p>
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
            onClick={() => { setStatus("idle"); setResult(null); }}
            className="text-xs text-emerald-700 underline hover:no-underline"
          >
            Submit another sample
          </button>
        </div>
      )}

      {/* Capture form */}
      {status !== "success" && (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <label
              htmlFor="voice-sample"
              className="text-sm font-medium text-[var(--sidebar-text-hover)]"
            >
              Write a short sample in your own voice
            </label>
            <p className="text-xs text-[var(--sidebar-text-dim)]">
              {WORD_MIN}–{WORD_MAX} words works best. Write about a project, a challenge you solved,
              or anything you&apos;d say in a cover letter.
              Type directly — pasting is disabled to capture your natural style.
            </p>
          </div>

          <textarea
            id="voice-sample"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => e.preventDefault()}
            placeholder="Start typing here…"
            rows={10}
            className="w-full rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2.5 text-sm text-black placeholder:text-[var(--sidebar-text-dim)] focus:outline-none focus:ring-2 focus:ring-[var(--brand)] resize-y"
          />

          <div className="flex items-center justify-between">
            <span className={`text-xs tabular-nums ${
              inRange   ? "text-emerald-600" :
              tooShort  ? "text-amber-600"   :
                          "text-[var(--sidebar-text-dim)]"
            }`}>
              {words} / {WORD_MIN}–{WORD_MAX} words
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
                <Mic className="w-4 h-4" />
                Capture voice
              </>
            )}
          </button>
        </form>
      )}
    </div>
  );
}
