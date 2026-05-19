"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface GenerationStatus {
  generate: string;
  honesty:  string;
}

interface CoverLetterRow {
  id:                       string;
  status:                   "pending" | "running" | "completed" | "failed";
  generation_status:        GenerationStatus;
  pass_3_final:             string | null;
  burstiness_score:         number | null;
  naturalness_score:        number | null;
  coherence_score:          number | null;
  specificity_ok:           boolean | null;
  honesty_ok:               boolean | null;
  quality_flags:            Record<string, unknown>;
  company_hook_text:        string | null;
  tone_target:              string | null;
  error_message:            string | null;
  pass_1_model:             string | null;
  pass_2_model:             string | null;
  pass_3_model:             string | null;
}

interface Props {
  jobId:    string;
  /** Pre-fetched letter row if one already exists for this job — null if not yet generated. */
  initial:  CoverLetterRow | null;
}

const STEP_LABELS = [
  { key: "generate", label: "Writing your letter"      },
  { key: "honesty",  label: "Checking against your CV" },
] as const;

function stepIcon(state: string) {
  if (state === "completed") return <span className="text-green-600">✓</span>;
  if (state === "running")   return <span className="animate-pulse text-brand">●</span>;
  if (state === "failed")    return <span className="text-red-500">✗</span>;
  return <span className="text-text-3">○</span>;
}

function Naturalnessbadge({ score }: { score: number | null }) {
  if (score === null) return null;
  const label = score >= 0.75 ? "Reads as natural" : score >= 0.5 ? "Reads as mostly natural" : "Reads as a bit AI-ish";
  const colour = score >= 0.75 ? "text-green-700 bg-green-50 border-green-200"
               : score >= 0.5  ? "text-yellow-700 bg-yellow-50 border-yellow-200"
               : "text-red-700 bg-red-50 border-red-200";
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium ${colour}`}>
      {label}
    </span>
  );
}

export function CoverLetterPanel({ jobId, initial }: Props) {
  const [letter, setLetter]     = useState<CoverLetterRow | null>(initial);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [copied, setCopied]     = useState(false);
  const statusRef               = useRef(letter?.status ?? "");

  statusRef.current = letter?.status ?? "";

  // ── Realtime + polling subscription ────────────────────────────────────────
  useEffect(() => {
    if (!letter?.id) return;
    const letterId = letter.id;
    const supabase = createClient();
    let active = true;

    async function fetchOnce() {
      if (statusRef.current === "completed" || statusRef.current === "failed") return;
      const { data } = await supabase
        .from("cover_letters")
        .select(
          "id, status, generation_status, pass_3_final, burstiness_score, " +
          "naturalness_score, coherence_score, specificity_ok, honesty_ok, " +
          "quality_flags, company_hook_text, tone_target, error_message, " +
          "pass_1_model, pass_2_model, pass_3_model",
        )
        .eq("id", letterId)
        .single();
      if (data && active) setLetter(data as unknown as CoverLetterRow);
    }

    fetchOnce();
    const poll = setInterval(fetchOnce, 3_000);

    const channel = supabase
      .channel(`cover_letters:${letterId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "cover_letters", filter: `id=eq.${letterId}` },
        (payload) => {
          if (active) setLetter((prev) => prev ? { ...prev, ...(payload.new as Partial<CoverLetterRow>) } : prev);
        },
      )
      .subscribe();

    return () => {
      active = false;
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [letter?.id]);

  // ── Trigger generation ────────────────────────────────────────────────────
  async function handleGenerate(regenerate = false) {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/jobs/${jobId}/cover-letter`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ regenerate }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Generation failed. Try again.");
        return;
      }

      if (data.status === "cached" && data.letter_id) {
        // Fetch the cached letter to display it
        const r = await fetch(`/api/jobs/${jobId}/cover-letter/${data.letter_id}`);
        const d = await r.json();
        if (d.letter) setLetter(d.letter as CoverLetterRow);
        return;
      }

      // New generation — set a pending shell so the progress UI shows immediately
      if (data.letter_id) {
        setLetter({
          id:                data.letter_id,
          status:            "pending",
          generation_status: { generate: "pending", honesty: "pending" },
          pass_3_final:      null,
          burstiness_score:  null,
          naturalness_score: null,
          coherence_score:   null,
          specificity_ok:    null,
          honesty_ok:        null,
          quality_flags:     {},
          company_hook_text: null,
          tone_target:       null,
          error_message:     null,
          pass_1_model:      null,
          pass_2_model:      null,
          pass_3_model:      null,
        });
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!letter?.pass_3_final) return;
    await navigator.clipboard.writeText(letter.pass_3_final);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const isTerminal = letter?.status === "completed" || letter?.status === "failed";
  const isRunning  = letter?.status === "running" || letter?.status === "pending";
  const genStatus  = letter?.generation_status ?? { generate: "pending", honesty: "pending" };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="bg-surface border border-border rounded-md">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border bg-surface-2 flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-semibold text-text">Cover Letter</h2>
          <p className="text-[11px] text-text-3 mt-0.5">
            Tailored to your voice, your CV, and this job description
          </p>
        </div>
        <div className="flex items-center gap-2">
          {letter?.status === "completed" && (
            <button
              onClick={() => handleGenerate(true)}
              disabled={loading}
              className="text-[11px] text-text-3 hover:text-text underline disabled:opacity-40"
            >
              Regenerate
            </button>
          )}
          {!letter && (
            <button
              onClick={() => handleGenerate(false)}
              disabled={loading}
              className="rounded bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Starting…" : "Generate cover letter"}
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-5 mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {error}
        </div>
      )}

      {/* No letter yet — prompt */}
      {!letter && !loading && !error && (
        <div className="px-5 py-8 text-center">
          <p className="text-[13px] text-text-2">
            Generate a personalised cover letter using your voice profile, story library,
            and company research.
          </p>
          <p className="mt-1 text-[11px] text-text-3">
            Requires: active CV · voice profile · extracted stories · JD text
          </p>
          <button
            onClick={() => handleGenerate(false)}
            disabled={loading}
            className="mt-4 rounded bg-brand px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Starting…" : "Generate cover letter"}
          </button>
        </div>
      )}

      {/* Progress steps */}
      {letter && (isRunning || (!isTerminal)) && (
        <div className="px-5 py-4 space-y-2">
          {STEP_LABELS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-2 text-[13px]">
              {stepIcon(genStatus[key as keyof GenerationStatus])}
              <span className={genStatus[key as keyof GenerationStatus] === "running" ? "text-text font-medium" : "text-text-2"}>
                {label}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Failed */}
      {letter?.status === "failed" && (
        <div className="px-5 py-4">
          <p className="text-[13px] text-red-600 font-medium">Generation failed</p>
          {letter.error_message && (
            <p className="mt-1 text-[11px] text-text-3 font-mono">{letter.error_message}</p>
          )}
          <button
            onClick={() => handleGenerate(true)}
            disabled={loading}
            className="mt-3 rounded bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Starting…" : "Try again"}
          </button>
        </div>
      )}

      {/* Completed — render letter */}
      {letter?.status === "completed" && letter.pass_3_final && (
        <div className="px-5 py-4 space-y-4">
          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-2">
            <Naturalnessbadge score={letter.naturalness_score} />
            {letter.company_hook_text && (
              <span className="text-[11px] text-text-3 italic truncate max-w-xs">
                Hook: {letter.company_hook_text}
              </span>
            )}
          </div>

          {/* Letter body */}
          <div className="rounded border border-border bg-surface-2 px-4 py-4">
            <pre className="whitespace-pre-wrap text-[13px] text-text leading-relaxed font-sans">
              {letter.pass_3_final}
            </pre>
          </div>

          {/* Honesty warning — surfaces unsupported claims so the user reviews before sending */}
          {(() => {
            const flags = (letter.quality_flags ?? {}) as {
              unsupported_claims?: string[];
              honesty_inconclusive?: boolean;
              honesty_retried?: boolean;
              honesty_passed_after_retry?: boolean;
            };
            const claims = Array.isArray(flags.unsupported_claims) ? flags.unsupported_claims : [];
            if (claims.length > 0) {
              return (
                <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  <p className="font-medium">Review before sending — these claims could not be verified against your CV:</p>
                  <ul className="mt-1 list-disc list-inside space-y-0.5">
                    {claims.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </div>
              );
            }
            if (flags.honesty_inconclusive) {
              return (
                <p className="text-[11px] text-text-3">
                  Note: honesty check was inconclusive — give the letter a quick read before sending.
                </p>
              );
            }
            return null;
          })()}

          {/* Actions */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleCopy}
              className="rounded border border-border px-3 py-1.5 text-[12px] text-text-2 hover:text-text hover:border-text-3 transition-colors"
            >
              {copied ? "Copied!" : "Copy text"}
            </button>
          </div>

          {/* Model provenance */}
          {letter.pass_3_model && (
            <p className="text-[10px] text-text-3">
              Generated with {letter.pass_3_model}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
