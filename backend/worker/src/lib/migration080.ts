// Columns added by migration 080. Stripped and retried when an upsert fails
// with "column not found" so the pipeline (save.ts's `jobs` writes and
// bucket.ts's `global_jobs` writes) keeps saving before the migration is
// applied (graceful-degradation convention, same as 079).
export const M080_COLUMNS = [
  "employment_types",
  "employment_source",
  "work_rights_requirement",
  "extracted_emails",
  "salary_period",
  "closing_date",
  "shift_patterns",
  "is_agency",
] as const;

export function stripM080<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const c of M080_COLUMNS) delete out[c];
  return out as T;
}
