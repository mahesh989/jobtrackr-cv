import { AlertCircle, CheckCircle2 } from "lucide-react";

export function TrustBadge({ score }: { score: number }) {
  const pct   = Math.round(score * 100);
  const color =
    score >= 0.75 ? "text-success bg-success-subtle border-success-border" :
    score >= 0.5  ? "text-warning bg-warning-subtle border-warning-border" :
                    "text-danger bg-danger-subtle border-danger-border";
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
