"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { jsPDF } from "jspdf";

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
  /** Saved hiring manager name from the job row (used to pre-fill the download modal). */
  jobHiringManager: string | null;
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

export function CoverLetterPanel({ jobId, initial, jobHiringManager }: Props) {
  const [letter, setLetter]     = useState<CoverLetterRow | null>(initial);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [copied, setCopied]     = useState(false);
  const [editedBody, setEditedBody] = useState<string | null>(null);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadHiringMgr, setDownloadHiringMgr] = useState<string>(jobHiringManager ?? "");
  const [downloading, setDownloading] = useState(false);
  // Research-required state: when the cover letter API returns 422 with
  // action=research_company, we pause generation and ask the user to run
  // company research first.
  const [researchRequired, setResearchRequired] = useState<{ company_name: string } | null>(null);
  const [researching, setResearching]           = useState(false);
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

  // Reset session-only edits when the active letter changes (e.g. regenerate)
  // so stale edits from a prior letter aren't silently sent to the PDF route.
  useEffect(() => {
    setEditedBody(null);
  }, [letter?.id]);

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
        // Special case: 422 + action=research_company → not an error in the
        // user sense, it's an intentional pause asking them to run research.
        if (res.status === 422 && data.action === "research_company") {
          setResearchRequired({ company_name: data.company_name ?? "this company" });
          return;
        }
        setError(data.error ?? "Generation failed. Try again.");
        return;
      }

      setResearchRequired(null);

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

  async function handleResearch() {
    if (!researchRequired) return;
    setResearching(true);
    setError(null);
    try {
      const res = await fetch("/api/company-research", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ company_name: researchRequired.company_name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Company research failed. Try again.");
        return;
      }
      // Research succeeded — clear the gate and immediately trigger generation.
      setResearchRequired(null);
      await handleGenerate(false);
    } catch {
      setError("Network error while researching the company.");
    } finally {
      setResearching(false);
    }
  }

  async function handleDownloadPDF() {
    if (!letter?.id) return;
    setDownloading(true);
    try {
      const params = new URLSearchParams();
      if (downloadHiringMgr) params.append("hiring_manager_override", downloadHiringMgr);
      if (editedBody) params.append("edited_body", editedBody);

      const res = await fetch(
        `/api/jobs/${jobId}/cover-letter/${letter.id}/download?${params}`,
        { method: "GET" }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to prepare PDF");
        setDownloading(false);
        return;
      }

      // Generate PDF client-side with jspdf.
      // A4 portrait, 0.8in margins all sides, 11pt Helvetica.
      const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const pageWidth   = doc.internal.pageSize.getWidth();
      const pageHeight  = doc.internal.pageSize.getHeight();
      const margin      = 57.6; // 0.8in
      const textWidth   = pageWidth - 2 * margin;
      const fontSize    = 11;
      const lineHeight  = fontSize * 1.35;        // explicit; jsPDF default 1.15 is too tight
      const paragraphGap = lineHeight * 0.6;      // extra space for blank source lines

      doc.setFont("Helvetica", "normal");
      doc.setFontSize(fontSize);

      let yPos = margin;
      // Split on hard newlines first so blank source lines become explicit
      // paragraph gaps rather than collapsing into uniform line spacing.
      const rawLines = (data.templated_text as string).split("\n");
      for (const raw of rawLines) {
        if (raw.trim() === "") {
          yPos += paragraphGap;
          continue;
        }
        const wrapped: string[] = doc.splitTextToSize(raw, textWidth);
        for (const wl of wrapped) {
          if (yPos + lineHeight > pageHeight - margin) {
            doc.addPage();
            yPos = margin;
          }
          doc.text(wl, margin, yPos);
          yPos += lineHeight;
        }
      }

      // Filename: <company>_<initials>_cover_letter.pdf
      const slug = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const initials = (data.user_name || "")
        .split(/\s+/)
        .map((w: string) => w[0]?.toUpperCase() ?? "")
        .join("")
        .slice(0, 3);
      const companySlug = slug(data.company || "company");
      const filename = initials
        ? `${companySlug}_${initials}_cover_letter.pdf`
        : `${companySlug}_cover_letter.pdf`;

      doc.save(filename);
      setShowDownloadModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate PDF");
    } finally {
      setDownloading(false);
    }
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

      {/* Research-required gate — shows regardless of whether a prior letter exists,
          since regenerating an existing letter also hits this prompt. */}
      {researchRequired && (
        <div className="mx-5 mt-4 rounded border border-blue-200 bg-blue-50 px-4 py-3">
          <p className="text-[13px] text-blue-900 font-medium">
            Run company research first
          </p>
          <p className="mt-1 text-[12px] text-blue-800">
            Paragraph 2 of your cover letter needs a real fact about{" "}
            <span className="font-medium">{researchRequired.company_name}</span> to anchor on
            — not generic praise. Research takes 1-2 minutes.
          </p>
          <button
            onClick={handleResearch}
            disabled={researching}
            className="mt-3 rounded bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {researching ? "Researching company…" : `Research ${researchRequired.company_name}`}
          </button>
        </div>
      )}

      {/* No letter yet — prompt */}
      {!letter && !loading && !error && !researchRequired && (
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

          {/* Letter body — editable textarea */}
          <div>
            <label className="text-[12px] font-medium text-text-2 mb-2 block">
              Review and refine your letter
            </label>
            <textarea
              value={editedBody ?? letter.pass_3_final ?? ""}
              onChange={(e) => setEditedBody(e.target.value)}
              rows={12}
              className="w-full rounded border border-border bg-surface px-3 py-2 text-[13px] text-text leading-relaxed font-sans focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30 resize-y"
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
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="rounded border border-border px-3 py-1.5 text-[12px] text-text-2 hover:text-text hover:border-text-3 transition-colors"
            >
              {copied ? "Copied!" : "Copy text"}
            </button>
            <button
              onClick={() => setShowDownloadModal(true)}
              className="rounded bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 transition-colors"
            >
              Download PDF
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
                <label htmlFor="dl-hiring-mgr" className="text-[12px] font-medium text-text-2 mb-2 block">
                  Hiring manager name (optional)
                </label>
                <input
                  id="dl-hiring-mgr"
                  type="text"
                  autoFocus
                  value={downloadHiringMgr}
                  onChange={(e) => setDownloadHiringMgr(e.target.value)}
                  placeholder="e.g., John Smith"
                  className="w-full rounded border border-border bg-surface-2 px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30"
                />
                <p className="text-[11px] text-text-3 mt-1">
                  Used in the salutation line. Leave blank to use the job default or &ldquo;Hiring Manager&rdquo;.
                </p>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-border flex gap-2 justify-end bg-surface-2">
              <button
                onClick={() => setShowDownloadModal(false)}
                disabled={downloading}
                className="rounded border border-border px-3 py-1.5 text-[12px] text-text-2 hover:text-text transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleDownloadPDF}
                disabled={downloading}
                className="rounded bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {downloading ? "Generating…" : "Download"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
