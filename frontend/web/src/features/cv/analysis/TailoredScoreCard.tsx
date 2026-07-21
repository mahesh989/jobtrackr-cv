"use client";

/**
 * Faithful port of cv-magic's TailoredScoreCard:
 *   - Three-up tile: Original score · Lift delta badge · Tailored score
 *   - Injected / Failed-to-inject / Fabricated / Honest-gaps keyword chips
 */

interface Props {
  beforeScore?:    number | null;        // run.match_score
  afterScore?:     number | null;        // run.tailored_match_score
  lift?:           number | null;
  injected?:       string[];
  failedToInject?: string[];
  filteredAsNonSkill?: string[];         // approved but stripped as junk (sector/setting names)
  honestGaps?:     string[];
  fabricated?:     string[];
  structuralReport?: {
    summary?: { pass?: number; warn?: number; fail?: number };
  };
}

export function TailoredScoreCard(props: Props) {
  const { beforeScore, afterScore, lift } = props;
  if (beforeScore == null && afterScore == null) return null;

  const before = beforeScore ?? 0;
  const after  = afterScore  ?? 0;
  const delta  = lift ?? (after - before);

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2">
        <h2 className="text-title font-semibold text-text">Tailored CV — ATS lift</h2>
      </div>
      <div className="px-5 py-4 space-y-4">
        <div className="grid grid-cols-3 items-center gap-3">
          <ScoreCircle label="Original" score={beforeScore} muted />
          <DeltaBadge  delta={delta} />
          <ScoreCircle label="Tailored" score={afterScore} />
        </div>

        {props.injected && props.injected.length > 0 && (
          <ChipList
            label={`Injected into tailored CV (${props.injected.length})`}
            sublabel="Verified to literally appear in the tailored markdown."
            items={props.injected}
            cls="bg-green-light text-green border-green/30"
          />
        )}
        {props.failedToInject && props.failedToInject.length > 0 && (
          <ChipList
            label={`Approved but missed (${props.failedToInject.length})`}
            sublabel="Approved by the feasibility plan but not detected in the tailored CV. Re-run if it matters."
            items={props.failedToInject}
            cls="bg-[#FFF8C5] text-[#9A6700] border-[#D4A72C]/40"
          />
        )}
        {props.filteredAsNonSkill && props.filteredAsNonSkill.length > 0 && (
          <ChipList
            label={`Filtered as non-skill (${props.filteredAsNonSkill.length})`}
            sublabel="Approved by feasibility but recognised as a sector / setting / filler phrase (e.g. 'Residential Care', 'Home Care Support'). Stripped to keep the Skills section clean — these would not have helped ATS scoring."
            items={props.filteredAsNonSkill}
            cls="bg-surface-2 text-text-3 border-border"
          />
        )}
        {props.fabricated && props.fabricated.length > 0 && (
          <ChipList
            label={`⚠ Fabricated (${props.fabricated.length})`}
            sublabel="Classified as honest gaps but the AI inserted them anyway. Review — these may not be defensible in interview."
            items={props.fabricated}
            cls="bg-red-light text-red border-red/30"
          />
        )}
        {props.honestGaps && props.honestGaps.length > 0 && (
          <ChipList
            label={`Honest gaps (${props.honestGaps.length})`}
            sublabel="Not in your CV, not added. Real upskilling required."
            items={props.honestGaps}
            cls="bg-surface-2 text-text-2 border-border"
          />
        )}

        {props.structuralReport?.summary && (
          <div className="text-caption text-text-3 flex gap-3 pt-2 border-t border-border">
            <span>Structure check:</span>
            <span className="text-green">{props.structuralReport.summary.pass ?? 0} pass</span>
            <span className="text-[#9A6700]">{props.structuralReport.summary.warn ?? 0} warn</span>
            <span className="text-red">{props.structuralReport.summary.fail ?? 0} fail</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreCircle({ label, score, muted }: { label: string; score?: number | null; muted?: boolean }) {
  const has = typeof score === "number";
  const v = has ? Math.round(score!) : null;
  return (
    <div className={`flex flex-col items-center ${muted ? "opacity-70" : ""}`}>
      <div className={`w-20 h-20 rounded-full flex items-center justify-center text-h1 font-bold tabular-nums border-2 ${
        v == null ? "text-text-3 border-border bg-surface-2"
        : v >= 80 ? "text-green border-green/40 bg-green-light"
        : v >= 60 ? "text-[#9A6700] border-[#D4A72C]/40 bg-[#FFF8C5]"
        : "text-red border-red/40 bg-red-light"
      }`}>
        {v ?? "—"}
      </div>
      <span className="text-caption text-text-3 uppercase tracking-wide mt-1.5">{label}</span>
    </div>
  );
}

function DeltaBadge({ delta }: { delta: number }) {
  const positive = delta >= 0;
  return (
    <div className="flex flex-col items-center">
      <div className={`px-3 py-1.5 rounded-md border text-h3 font-bold tabular-nums ${
        positive
          ? "bg-green-light text-green border-green/30"
          : "bg-red-light text-red border-red/30"
      }`}>
        {positive ? "+" : ""}{delta}
      </div>
      <span className="text-caption text-text-3 uppercase tracking-wide mt-1.5">Lift</span>
    </div>
  );
}

function ChipList({ label, sublabel, items, cls }: {
  label:    string;
  sublabel: string;
  items:    string[];
  cls:      string;
}) {
  return (
    <div>
      <h3 className="text-caption font-semibold text-text">{label}</h3>
      <p className="text-caption text-text-3 mb-1.5">{sublabel}</p>
      <div className="flex flex-wrap gap-1">
        {items.map((s, i) => (
          <span key={i} className={`text-caption px-1.5 py-0.5 rounded border font-mono ${cls}`}>{s}</span>
        ))}
      </div>
    </div>
  );
}
