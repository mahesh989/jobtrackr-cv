"use client";

interface Props {
  beforeScore?:    number | null;        // run.match_score
  afterScore?:     number | null;        // run.tailored_match_score
  lift?:           number | null;        // run.ats_lift
  injected?:       string[];
  failedToInject?: string[];
  honestGaps?:    string[];
  fabricated?:    string[];
  structuralReport?: {
    summary?: { pass?: number; warn?: number; fail?: number };
  };
}

export function TailoredScoreCard(props: Props) {
  const { beforeScore, afterScore, lift } = props;
  const hasScore = typeof beforeScore === "number" || typeof afterScore === "number";
  if (!hasScore) return null;

  const liftCls = (lift ?? 0) >= 0
    ? "text-green bg-green-light border-green/30"
    : "text-red bg-red-light border-red/30";

  return (
    <div className="bg-surface border border-border rounded-md overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-2">
        <h2 className="text-[14px] font-semibold text-text">Tailoring impact</h2>
        <p className="text-[12px] text-text-3 mt-0.5">
          ATS scores before vs. after tailoring. Lift is computed deterministically
          from which approved keywords actually landed in the tailored markdown.
        </p>
      </div>
      <div className="px-5 py-4 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <ScoreTile label="Before" value={beforeScore} />
          <ScoreTile label="After"  value={afterScore} />
          <div className="bg-surface-2 border border-border rounded p-3">
            <div className="text-[10px] uppercase tracking-wide text-text-3">Lift</div>
            <div className={`mt-1 inline-block text-[18px] font-bold tabular-nums px-2 py-0.5 rounded border ${liftCls}`}>
              {(lift ?? 0) > 0 ? "+" : ""}{lift ?? 0}
            </div>
          </div>
        </div>

        {props.injected && props.injected.length > 0 && (
          <ChipList
            label={`Injected keywords (${props.injected.length})`}
            items={props.injected}
            cls="bg-green-light text-green border-green/30"
          />
        )}
        {props.failedToInject && props.failedToInject.length > 0 && (
          <ChipList
            label={`Approved but missed (${props.failedToInject.length})`}
            items={props.failedToInject}
            cls="bg-[#FFF8C5] text-[#9A6700] border-[#D4A72C]/40"
          />
        )}
        {props.honestGaps && props.honestGaps.length > 0 && (
          <ChipList
            label={`Honest gaps left (${props.honestGaps.length})`}
            items={props.honestGaps}
            cls="bg-surface-2 text-text-2 border-border"
          />
        )}
        {props.fabricated && props.fabricated.length > 0 && (
          <ChipList
            label={`⚠ Fabricated (${props.fabricated.length})`}
            items={props.fabricated}
            cls="bg-red-light text-red border-red/30"
            note="These appear in the tailored CV but lack supporting evidence in your original CV. Review before sending."
          />
        )}

        {props.structuralReport?.summary && (
          <div className="text-[11px] text-text-3 flex gap-3">
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

function ScoreTile({ label, value }: { label: string; value?: number | null }) {
  return (
    <div className="bg-surface-2 border border-border rounded p-3">
      <div className="text-[10px] uppercase tracking-wide text-text-3">{label}</div>
      <div className="mt-1 text-[20px] font-bold tabular-nums text-text">
        {typeof value === "number" ? Math.round(value) : "—"}
        <span className="text-[11px] text-text-3 font-normal ml-1">/ 100</span>
      </div>
    </div>
  );
}

function ChipList({ label, items, cls, note }: {
  label: string;
  items: string[];
  cls: string;
  note?: string;
}) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-3 mb-1.5">{label}</h3>
      <div className="flex flex-wrap gap-1">
        {items.map((s, i) => (
          <span key={i} className={`text-[11px] px-1.5 py-0.5 rounded border ${cls}`}>{s}</span>
        ))}
      </div>
      {note && <p className="text-[11px] text-text-3 mt-1.5">{note}</p>}
    </div>
  );
}
