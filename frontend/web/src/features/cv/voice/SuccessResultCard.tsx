"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui";
import { TrustBadge } from "./TrustBadge";
import { WORD_MIN, formalityLabel, type SubmitResult } from "./types";

interface Props {
  result: SubmitResult;
  onReset: () => void;
}

export function SuccessResultCard({ result, onReset }: Props) {
  const [showDetails, setShowDetails] = useState(false);

  return (
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
      <Button
        variant="default"
        size="sm"
        onClick={onReset}
        className="text-xs text-emerald-700 underline hover:no-underline"
      >
        Submit another sample
      </Button>

      <div className="border border-[var(--card-border)] rounded-lg overflow-hidden">
        <Button
          variant="default"
          size="sm"
          onClick={() => setShowDetails((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-medium text-[var(--text-2)] hover:bg-[var(--surface-2)] transition-colors"
        >
          <span>View what we learned about your writing</span>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showDetails ? "rotate-180" : ""}`} />
        </Button>

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
  );
}
