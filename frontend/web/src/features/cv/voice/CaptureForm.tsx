import { AlertCircle, PenLine } from "lucide-react";
import { Button, Form, Textarea } from "@/components/ui";
import { WORD_MIN, type SourceTag } from "./types";

interface Props {
  activeTab:     SourceTag;
  onTabChange:   (tab: SourceTag) => void;
  text:          string;
  onTextChange:  (text: string) => void;
  words:         number;
  status:        "idle" | "submitting" | "error" | "success";
  errorMsg:      string | null;
  canSubmit:     boolean;
  isEditing:     boolean;
  onSubmit:      (e: React.FormEvent) => void;
  onCancel:      () => void;
  showCancel:    boolean;
}

export function CaptureForm({
  activeTab,
  onTabChange,
  text,
  onTextChange,
  words,
  status,
  errorMsg,
  canSubmit,
  isEditing,
  onSubmit,
  onCancel,
  showCancel,
}: Props) {
  const inRange  = words >= WORD_MIN && words <= 600;
  const tooShort = words > 0 && words < WORD_MIN;

  return (
    <Form onSubmit={onSubmit} className="space-y-3">
      <div className="flex border-b border-[var(--card-border)]" role="tablist">
        <button role="tab" aria-selected={activeTab === "in_app_capture"} onClick={() => onTabChange("in_app_capture")} className={`px-3 py-2 text-label font-semibold border-b-2 -mb-px transition-colors ${ activeTab === "in_app_capture" ? "border-[var(--brand)] text-[var(--brand)]" : "border-transparent text-[var(--text-2)] hover:text-[var(--text)]" }`}>
          Write a sample
        </button>
        <button role="tab" aria-selected={activeTab === "pasted_cover_letter"} onClick={() => onTabChange("pasted_cover_letter")} className={`px-3 py-2 text-label font-semibold border-b-2 -mb-px transition-colors ${ activeTab === "pasted_cover_letter" ? "border-[var(--brand)] text-[var(--brand)]" : "border-transparent text-[var(--text-2)] hover:text-[var(--text)]" }`}>
          Paste a cover letter
        </button>
        <span className="ml-auto px-2 text-caption text-[var(--sidebar-text-dim)] self-center">
          Use whichever feels easier — you only need one.
        </span>
      </div>

      {activeTab === "in_app_capture" ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
          <p className="text-label font-semibold text-text mb-0.5">
            Recommended — writing fresh in your own voice gives the cleanest signal.
          </p>
          <p className="text-caption text-text-2 leading-relaxed">
            Type {WORD_MIN}+ words about a project, a problem you&apos;ve solved, or anything you&apos;d naturally
            talk about. Don&apos;t polish, don&apos;t proof, don&apos;t paraphrase — typos and casual phrasing are
            what give us your real voice. Pasting is disabled on this tab on purpose.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--card-border)] bg-[var(--surface-2)] px-3 py-2.5">
          <p className="text-label font-semibold text-[var(--text)] mb-0.5">
            Works fine — but pasted text tends to be more polished than your real voice.
          </p>
          <p className="text-caption text-[var(--text-2)] leading-relaxed">
            Paste a cover letter <span className="font-semibold">you wrote yourself</span> (not one AI generated
            or someone else drafted for you). {WORD_MIN}+ words. We&apos;ll still learn from it, but the rewrites
            may come out a bit more buttoned-up than how you actually sound. If you want the warmest result,
            switch to the other tab.
          </p>
        </div>
      )}

      <Textarea
        key={activeTab}
        id="voice-sample"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onPaste={activeTab === "in_app_capture" ? (e) => e.preventDefault() : undefined}
        placeholder={activeTab === "in_app_capture"
          ? "Start typing here…"
          : "Paste your cover letter here…"}
        rows={10}
        className="resize-y"
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
        <Button
          type="submit"
          variant="brand"
          size="sm"
          disabled={!canSubmit}
          isLoading={status === "submitting"}
          icon={status === "submitting" ? undefined : <PenLine className="w-4 h-4" />}
        >
          {status === "submitting"
            ? "Analysing…"
            : isEditing ? "Save changes" : "Save writing voice"}
        </Button>

        {showCancel && (
          <Button type="button" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </Form>
  );
}
