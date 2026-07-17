"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button, Textarea, Input } from "@/ui";
import { downloadApplicationBundle } from "@/lib/downloadZip";

interface GenerationStatus {
  generate: string;
  honesty:  string;
}

interface OpeningVariant {
  id:            string;
  text:          string;
  pattern_label: string;
}

export interface CoverLetterRow {
  id:                       string;
  status:                   "pending" | "running" | "completed" | "failed" | "picking";
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
  // Phase 11 columns
  opening_variants:         OpeningVariant[] | null;
  chosen_opening:           string | null;
  discarded_openings:       OpeningVariant[] | null;
}

interface Props {
  jobId:    string;
  /** Pre-fetched letter row if one already exists for this job — null if not yet generated. */
  initial:  CoverLetterRow | null;
  /** Saved hiring manager name from the job row (used to pre-fill the download modal). */
  jobHiringManager: string | null;
  cvStoragePath?: string | null;
  companyName?: string | null;
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

export function CoverLetterPanel({ jobId, initial, jobHiringManager, cvStoragePath, companyName }: Props) {
  const [letter, setLetter]     = useState<CoverLetterRow | null>(initial);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  /** Billing cap hit (HTTP 402) — { message, reason } drives the upgrade banner. */
  const [paywall, setPaywall]   = useState<{ message: string; reason: string } | null>(null);
  const [copied, setCopied]     = useState(false);
  const [editedBody, setEditedBody] = useState<string | null>(null);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadHiringMgr, setDownloadHiringMgr] = useState<string>(jobHiringManager ?? "");
  const [downloading, setDownloading] = useState(false);
  const [downloadingZip, setDownloadingZip] = useState(false);

  async function handleDownloadZip() {
    if (downloadingZip || !letter || !cvStoragePath) return;
    setError(null);
    setDownloadingZip(true);
    try {
      await downloadApplicationBundle({
        jobId,
        letterId: letter.id,
        cvStoragePath,
        companyName: companyName ?? "Company",
        hiringManager: downloadHiringMgr || null,
        editedBody: editedBody || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download ZIP bundle");
    } finally {
      setDownloadingZip(false);
    }
  }

  // Phase D-2: when the API returns 422 + action=below_final_gate, surface
  // an inline override prompt with the actual score + threshold so the
  // user can decide whether to spend the ~5-15s AI call anyway.
  const [belowFinalGate, setBelowFinalGate] = useState<{
    score:     number | null;
    threshold: number;
  } | null>(null);
  // When the cover letter API returns 422 with action=research_company we
  // auto-trigger company research and retry generation. This state drives the
  // inline "Researching <company> first…" indicator while that runs.
  const [researching, setResearching] = useState<string | null>(null);
  const statusRef               = useRef(letter?.status ?? "");

  statusRef.current = letter?.status ?? "";

  // ── Realtime + polling subscription ────────────────────────────────────────
  useEffect(() => {
    if (!letter?.id) return;
    const letterId = letter.id;
    const supabase = createClient();
    let active = true;

    async function fetchOnce() {
      // Stop polling for terminal states and for 'picking' — the row won't
      // change until the user acts; Realtime will deliver the pick update.
      if (
        statusRef.current === "completed" ||
        statusRef.current === "failed"    ||
        statusRef.current === "picking"
      ) return;
      const { data } = await supabase
        .from("cover_letters")
        .select(
          "id, status, generation_status, pass_3_final, burstiness_score, " +
          "naturalness_score, coherence_score, specificity_ok, honesty_ok, " +
          "quality_flags, company_hook_text, tone_target, error_message, " +
          "pass_1_model, pass_2_model, pass_3_model, " +
          "opening_variants, chosen_opening, discarded_openings",
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

  // Reset session-only edits when the active letter changes (e.g. regenerate)
  // so stale edits from a prior letter aren't silently sent to the PDF route.
  // Compared during render (React's "adjusting state when a prop changes"
  // pattern) rather than in an effect.
  const [prevLetterId, setPrevLetterId] = useState(letter?.id);
  if (prevLetterId !== letter?.id) {
    setPrevLetterId(letter?.id);
    setEditedBody(null);
  }

  // Escape-to-close + body scroll lock while the download modal is open.
  useEffect(() => {
    if (!showDownloadModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !downloading) setShowDownloadModal(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [showDownloadModal, downloading]);

  // ── Trigger generation ────────────────────────────────────────────────────
  // didAutoResearch guards against infinite loops: if the second call STILL
  // returns research_company, we surface an error instead of spinning forever.
  // override (Phase D-2) is set when the user clicks "Generate anyway" on
  // a below-final-gate prompt — forwarded to the API as ?override=final_gate.
  async function handleGenerate(
    regenerate     = false,
    didAutoResearch = false,
    override?:    "final_gate",
  ) {
    setLoading(true);
    setError(null);
    setPaywall(null);
    setBelowFinalGate(null);

    try {
      const url = override
        ? `/api/jobs/${jobId}/cover-letter?override=${override}`
        : `/api/jobs/${jobId}/cover-letter`;
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ regenerate }),
      });
      const data = await res.json();

      if (!res.ok) {
        // Billing cap hit — surface an upgrade banner instead of a plain error.
        if (res.status === 402) {
          setPaywall({
            message: (data.error as string) ?? "Cover-letter limit reached",
            reason:  (data.reason as string | undefined) ?? "letter_unique_cap",
          });
          return;
        }

        // Phase D-2: tailored score below user's final-ATS threshold.
        // Show an inline override prompt so the user can decide whether to
        // spend the AI call anyway.
        if (res.status === 422 && data.action === "below_final_gate") {
          setBelowFinalGate({
            score:     (data.tailored_score as number | null) ?? null,
            threshold: (data.threshold      as number)         ?? 75,
          });
          return;
        }

        // 422 + action=research_company → company research is a prerequisite.
        // Auto-run it once, then retry generation. The user never sees a button.
        if (res.status === 422 && data.action === "research_company") {
          if (didAutoResearch) {
            setError("Company research did not produce enough information to draft the letter. Try again or research the company manually from the Integrations page.");
            return;
          }
          const companyName = data.company_name ?? "this company";
          setResearching(companyName);
          try {
            const r = await fetch("/api/company-research", {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ company_name: companyName }),
            });
            const d = await r.json();
            if (!r.ok) {
              setError(d.error ?? "Company research failed. Try again.");
              return;
            }
          } catch {
            setError("Network error while researching the company.");
            return;
          } finally {
            setResearching(null);
          }
          // Recurse once with the guard flipped so a repeat 422 errors cleanly.
          // CRITICAL: preserve `override`. If the user clicked "Generate
          // anyway" on a below-final-gate job, the override must survive the
          // auto-research detour — otherwise the retry trips the final-gate
          // again and the amber card pops back up, forcing another click.
          await handleGenerate(regenerate, true, override);
          return;
        }
        setError(data.error ?? "Generation failed. Try again.");
        return;
      }

      if (data.status === "cached" && data.letter_id) {
        // Cached letter — fetch the full row (may be 'picking', 'completed', etc.)
        const r = await fetch(`/api/jobs/${jobId}/cover-letter/${data.letter_id}`);
        const d = await r.json();
        if (d.letter) setLetter(d.letter as CoverLetterRow);
        return;
      }

      // Phase 11: variants generated — show the picker
      if (data.status === "picking" && data.letter_id) {
        setLetter({
          id:                 data.letter_id,
          status:             "picking",
          generation_status:  { generate: "pending", honesty: "pending" },
          pass_3_final:       null,
          burstiness_score:   null,
          naturalness_score:  null,
          coherence_score:    null,
          specificity_ok:     null,
          honesty_ok:         null,
          quality_flags:      {},
          company_hook_text:  null,
          tone_target:        null,
          error_message:      null,
          pass_1_model:       null,
          pass_2_model:       null,
          pass_3_model:       null,
          opening_variants:   data.variants ?? null,
          chosen_opening:     null,
          discarded_openings: null,
        });
        return;
      }

      // Legacy / fallback: status=generating — set pending shell
      if (data.letter_id) {
        setLetter({
          id:                 data.letter_id,
          status:             "pending",
          generation_status:  { generate: "pending", honesty: "pending" },
          pass_3_final:       null,
          burstiness_score:   null,
          naturalness_score:  null,
          coherence_score:    null,
          specificity_ok:     null,
          honesty_ok:         null,
          quality_flags:      {},
          company_hook_text:  null,
          tone_target:        null,
          error_message:      null,
          pass_1_model:       null,
          pass_2_model:       null,
          pass_3_model:       null,
          opening_variants:   null,
          chosen_opening:     null,
          discarded_openings: null,
        });
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // ── Variant picker ────────────────────────────────────────────────────────
  const [pickingId, setPickingId] = useState<string | null>(null);

  async function handlePick(variantId: string) {
    if (!letter?.id) return;
    setPickingId(variantId);
    setError(null);
    try {
      const res = await fetch(
        `/api/jobs/${jobId}/cover-letter/${letter.id}/pick`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ variant_id: variantId }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to confirm selection. Try again.");
        return;
      }
      // Optimistic: advance to pending shell so the progress UI shows immediately.
      // Realtime will deliver the true status updates from cv-backend.
      setLetter((prev) =>
        prev
          ? {
              ...prev,
              status:             "pending",
              generation_status:  { generate: "pending", honesty: "pending" },
            }
          : prev,
      );
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPickingId(null);
    }
  }

  async function handleCopy() {
    if (!letter?.pass_3_final) return;
    await navigator.clipboard.writeText(letter.pass_3_final);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleDownloadPDF() {
    if (!letter?.id) return;
    setDownloading(true);
    try {
      // Phase G-2: rendering now happens server-side via the same renderer the
      // Applications outbox uses. Fetch the PDF bytes directly with format=pdf
      // and hand them to the browser via an object URL.
      const params = new URLSearchParams({ format: "pdf" });
      if (downloadHiringMgr) params.append("hiring_manager_override", downloadHiringMgr);
      if (editedBody)        params.append("edited_body", editedBody);

      const res = await fetch(
        `/api/jobs/${jobId}/cover-letter/${letter.id}/download?${params}`,
        { method: "GET" }
      );
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        setError(msg.error ?? `Failed to prepare PDF (${res.status})`);
        setDownloading(false);
        return;
      }

      // Filename comes from Content-Disposition; falling back to a generic
      // name if the header is missing for any reason.
      const cd = res.headers.get("Content-Disposition") ?? "";
      const fnMatch = cd.match(/filename="?([^"]+)"?/i);
      const filename = fnMatch?.[1] ?? "cover_letter.pdf";

      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setShowDownloadModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate PDF");
    } finally {
      setDownloading(false);
    }
  }

  const isPicking  = letter?.status === "picking";
  const isTerminal = letter?.status === "completed" || letter?.status === "failed";
  const isRunning  = letter?.status === "running" || letter?.status === "pending";
  const genStatus  = letter?.generation_status ?? { generate: "pending", honesty: "pending" };

  // Live word/character count of the letter as it currently stands (reflects
  // unsaved edits in the textarea). Shown in the header once a letter exists.
  const currentBody = editedBody ?? letter?.pass_3_final ?? "";
  const hasBody     = letter?.status === "completed" && !!letter.pass_3_final;
  const wordCount   = currentBody.trim() ? currentBody.trim().split(/\s+/).length : 0;
  const charCount   = currentBody.length;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="bg-surface border border-border rounded-md">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border bg-surface-2 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[14px] font-semibold text-text">Cover Letter</h2>
          <p className="text-[11px] text-text-3 mt-0.5">
            Tailored to your voice, your CV, and this job description
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {hasBody && (
            <span className="text-[11px] text-text-3 tabular-nums whitespace-nowrap">
              {wordCount.toLocaleString()} words · {charCount.toLocaleString()} characters
            </span>
          )}
          {letter?.status === "completed" && (
            <Button
              variant="default"
              size="sm"
              onClick={() => handleGenerate(true)}
              disabled={loading}
              className="text-[11px] text-text-3 hover:text-text underline disabled:opacity-40"
            >
              Regenerate
            </Button>
          )}
          {!letter && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => handleGenerate(false)}
              disabled={loading}
              className="rounded bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Generating options…" : "Generate cover letter"}
            </Button>
          )}
        </div>
      </div>

      {/* Phase D-2 — final-ATS gate override prompt */}
      {belowFinalGate && (
        <div className="mx-5 mt-4 rounded border-2 border-amber-300 bg-amber-50 px-3 py-3">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[10px] font-bold text-amber-900">!</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-amber-900 leading-snug">
                Below your final-ATS threshold
              </p>
              <p className="mt-1 text-[12px] text-amber-800 leading-relaxed">
                Tailored CV scored{" "}
                <span className="font-bold tabular-nums">{belowFinalGate.score ?? "—"}</span>
                {" "}/ 100, below your configured threshold of{" "}
                <span className="font-bold tabular-nums">{belowFinalGate.threshold}</span>.
                A cover letter built on a low tailored score rarely wins interviews — consider improving the CV first, or generate the letter anyway if you want to send it as-is.
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => handleGenerate(true)}
              disabled={loading}
              isLoading={loading}
              className="mt-3 rounded bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Starting…" : "Try again"}
            </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setBelowFinalGate(null)}
                  className="px-2 py-1 text-[12px] text-amber-700 hover:text-amber-900 transition-colors"
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-5 mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {error}
        </div>
      )}

      {/* Billing cap — upgrade prompt */}
      {paywall && (
        <div className="mx-5 mt-4 flex items-center justify-between gap-3 rounded border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-800">
          <span className="font-medium">{paywall.message}</span>
          <a
            href={`/dashboard/billing?denied=${paywall.reason}`}
            className="shrink-0 rounded-md bg-[var(--brand)] px-2.5 py-1 text-[11px] font-semibold text-[var(--brand-fg)] hover:opacity-90"
          >
            Upgrade
          </a>
        </div>
      )}

      {/* Auto-research indicator: shown while we transparently fetch company
          research before drafting (the user doesn't click anything). */}
      {researching && (
        <div className="mx-5 mt-4 rounded border border-blue-200 bg-blue-50 px-4 py-3 text-[12px] text-blue-900">
          <span className="animate-pulse">●</span>{" "}
          Researching <span className="font-medium">{researching}</span> before drafting your letter…
        </div>
      )}

      {/* No letter yet — prompt */}
      {!letter && !loading && !error && !researching && (
        <div className="px-5 py-8 text-center">
          <p className="text-[13px] text-text-2">
            Generate a personalised cover letter using your writing voice, story library,
            and company research.
          </p>
          <p className="mt-1 text-[11px] text-text-3">
            Requires: active CV · writing voice · extracted stories · JD text
          </p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => handleGenerate(false)}
              disabled={loading}
              isLoading={loading}
              className="rounded bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Generating options…" : "Generate cover letter"}
            </Button>
        </div>
      )}

      {/* Variant picker — shown while status='picking' */}
      {isPicking && letter?.opening_variants && letter.opening_variants.length > 0 && (
        <div className="px-5 py-4">
          <p className="text-[13px] text-text-2 mb-4">
            Choose an opening — the rest of the letter will be written to match it.
          </p>
          <div className="space-y-3">
            {letter.opening_variants.map((variant) => (
              <div
                key={variant.id}
                className="rounded border border-border bg-surface p-4"
              >
                <p className="text-[10px] font-semibold text-text-3 uppercase tracking-wider mb-2">
                  {variant.pattern_label}
                </p>
                <p className="text-[13px] text-text leading-relaxed mb-3">
                  {variant.text}
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handlePick(variant.id)}
                  disabled={pickingId !== null}
                  isLoading={pickingId === variant.id}
                  className="rounded bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {pickingId === variant.id ? "Confirming…" : "Use this opener"}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Progress steps */}
      {letter && (isRunning || (!isTerminal && !isPicking)) && (
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
            <Button
              variant="default"
              size="sm"
              onClick={() => handleGenerate(true)}
              disabled={loading}
              className="text-[11px] text-text-3 hover:text-text underline disabled:opacity-40"
            >
              Regenerate
            </Button>
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

          {/* Letter body — editable textarea */}
          <div>
            <Textarea
              label="Review and refine your letter"
              value={editedBody ?? letter.pass_3_final ?? ""}
              onChange={(e) => setEditedBody(e.target.value)}
              rows={12}
              className="rounded border-border bg-surface px-3 py-2 text-[13px] text-text leading-relaxed font-sans focus:ring-2 focus:ring-[var(--brand)]/30 resize-y"
            />
            <p className="text-[11px] text-text-3 mt-1">
              Edit freely — changes are temporary during this session.
            </p>
          </div>

          {/* Quality warnings — honesty (unsupported claims) + research fallback */}
          {(() => {
            const flags = (letter.quality_flags ?? {}) as {
              unsupported_claims?: string[];
              honesty_inconclusive?: boolean;
              honesty_retried?: boolean;
              honesty_passed_after_retry?: boolean;
              low_quality_company_research?: boolean;
            };
            const claims = Array.isArray(flags.unsupported_claims) ? flags.unsupported_claims : [];
            return (
              <>
                {claims.length > 0 && (
                  <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                    <p className="font-medium">Review before sending — these claims could not be verified against your CV:</p>
                    <ul className="mt-1 list-disc list-inside space-y-0.5">
                      {claims.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                )}
                {flags.low_quality_company_research && (
                  <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                    Company research returned limited information for this employer.
                    Paragraph 2 falls back to the job description — read it carefully
                    before sending.
                  </div>
                )}
                {claims.length === 0 && flags.honesty_inconclusive && (
                  <p className="text-[11px] text-text-3">
                    Note: honesty check was inconclusive — give the letter a quick read before sending.
                  </p>
                )}
              </>
            );
          })()}

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="default"
              size="sm"
              onClick={handleCopy}
              className="rounded border border-border px-3 py-1.5 text-[12px] text-text-2 hover:text-text hover:border-text-3 transition-colors"
            >
              {copied ? "Copied!" : "Copy text"}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => setShowDownloadModal(true)}
              className="rounded border border-border px-3 py-1.5 text-[12px] text-text-2 hover:text-text hover:border-text-3 transition-colors"
            >
              Download PDF
            </Button>
            {cvStoragePath && (
              <Button
                variant="default"
                size="sm"
                onClick={handleDownloadZip}
                disabled={downloadingZip}
                isLoading={downloadingZip}
                className="rounded border border-border px-3 py-1.5 text-[12px] text-text-2 hover:text-text hover:border-text-3 transition-colors disabled:opacity-40 flex items-center gap-1.5"
              >
                {downloadingZip && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {downloadingZip ? "Preparing ZIP…" : "Download ZIP"}
              </Button>
            )}
            {/* Jump to the Applications "Application pool" tab so the user
                can queue this letter for review without hunting through the nav. */}
            <Link
              href="/dashboard/applications"
              className="ml-auto inline-flex items-center gap-1 rounded bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 transition-colors"
            >
              Apply now
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
            </Link>
          </div>

          {/* Model provenance */}
          {letter.pass_3_model && (
            <p className="text-[10px] text-text-3">
              Generated with {letter.pass_3_model}
            </p>
          )}
        </div>
      )}

      {/* Download PDF Modal */}
      {showDownloadModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onClick={() => { if (!downloading) setShowDownloadModal(false); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="download-pdf-title"
            className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-border">
              <h3 id="download-pdf-title" className="text-[14px] font-semibold text-text">
                Download as PDF
              </h3>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <Input
                  label="Hiring manager name (optional)"
                  id="dl-hiring-mgr"
                  type="text"
                  autoFocus
                  value={downloadHiringMgr}
                  onChange={(e) => setDownloadHiringMgr(e.target.value)}
                  placeholder="e.g., John Smith"
                />
                <p className="text-[11px] text-text-3 mt-1">
                  Used in the salutation line. Leave blank to use the job default or &ldquo;Hiring Manager&rdquo;.
                </p>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-border flex gap-2 justify-end bg-surface-2">
              <Button
                variant="default"
                size="sm"
                onClick={() => setShowDownloadModal(false)}
                disabled={downloading}
                className="rounded border border-border px-3 py-1.5 text-[12px] text-text-2 hover:text-text transition-colors disabled:opacity-40"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleDownloadPDF}
                disabled={downloading}
                isLoading={downloading}
                className="rounded bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {downloading ? "Generating…" : "Download"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
