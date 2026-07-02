// Backfill work-setting classification onto existing rows (Migration 078).
//
// Rules-only (no AI) — cheap and safe to run repeatedly. Classifies rows whose
// setting_category is still NULL, in both:
//   global_jobs  — the shared bucket (the important one; profiles project from it)
//   jobs         — per-profile rows (covers non-bucket + manually-added jobs)
//
// Ambiguous care jobs → 'other'; non-care jobs are left NULL (skipped) so they
// never get a badge or get filtered. Re-run any time; it only touches NULLs.
//
// Run:  npx tsx src/scripts/backfillSettings.ts
//       npx tsx src/scripts/backfillSettings.ts jobs      (only jobs table)
//       npx tsx src/scripts/backfillSettings.ts global    (only global_jobs)

import { db } from "../db/client.js";
import { classifySettingDeterministic } from "../ai/settingClassifier.js";

const PAGE = 500;

interface Row {
  id: string;
  description_full?: string | null;
  description_snippet?: string | null;
  description?: string | null;
}

function jdOf(r: Row): string {
  return (r.description_full || r.description || r.description_snippet || "").toString();
}

async function backfillTable(
  table: "global_jobs" | "jobs",
  descCols: string,
): Promise<void> {
  let scanned = 0;
  let classified = 0;
  const counts: Record<string, number> = {};

  // Keyset by id to page stably as we mutate. Only rows still unclassified.
  let lastId = "";
  for (;;) {
    let q = db
      .from(table)
      .select(`id, ${descCols}`)
      .is("setting_category", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (lastId) q = q.gt("id", lastId);

    const { data, error } = await q;
    if (error) {
      console.error(`[backfillSettings] ${table} read error: ${error.message}`);
      return;
    }
    const rows = (data ?? []) as unknown as Row[];
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]!.id;
    scanned += rows.length;

    for (const r of rows) {
      const det = classifySettingDeterministic(jdOf(r));
      if (det.kind === "skip") continue; // not a care job — leave NULL
      const info =
        det.kind === "resolved"
          ? det.info
          : {
              setting_category: "other" as const,
              setting_confidence: 0.3,
              setting_evidence: det.evidence.join(", ") || null,
            };
      const { error: uErr } = await db
        .from(table)
        .update({
          setting_category: info.setting_category,
          setting_confidence: info.setting_confidence,
          setting_evidence: info.setting_evidence,
        })
        .eq("id", r.id);
      if (uErr) {
        console.warn(`[backfillSettings] ${table} update ${r.id} failed: ${uErr.message}`);
        continue;
      }
      classified++;
      const key = info.setting_category ?? "other";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    console.log(`[backfillSettings] ${table}: scanned ${scanned}, classified ${classified}…`);
  }

  console.log(
    `[backfillSettings] ${table} DONE — scanned ${scanned}, classified ${classified} ` +
      `(${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" ") || "none"})`,
  );
}

async function main() {
  const arg = (process.argv[2] ?? "all").toLowerCase();
  if (arg === "all" || arg === "global") {
    await backfillTable("global_jobs", "description_full, description_snippet");
  }
  if (arg === "all" || arg === "jobs") {
    await backfillTable("jobs", "description");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfillSettings] fatal:", err);
  process.exit(1);
});
