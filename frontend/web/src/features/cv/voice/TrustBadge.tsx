import { AlertCircle, CheckCircle2 } from "lucide-react";

export function TrustBadge({ score }: { score: number }) {
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
