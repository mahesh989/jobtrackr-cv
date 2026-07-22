-- 043_eval_runs.sql
-- Eval harness storage for the beta A/B/C/D screen.
--
-- ADDITIVE & ISOLATED: this table is written only by cv-backend's
-- /internal/analyze-eval (service role) and read by founder-only web routes
-- (also service role). It has NO relationship to analysis_runs and does not
-- touch any existing table — dropping it is a clean rollback.
--
-- One row per (writer_variant × scorer_variant × jd × iteration) run.

create table if not exists public.eval_runs (
  id                 uuid primary key default gen_random_uuid(),

  -- grouping / provenance
  experiment_id      text,           -- links A/B/C/D outputs for the same JD+CV
  jd_label           text,           -- human label e.g. "CAE Data Analyst"
  vertical           text,           -- it | nursing | cleaner | admin | master | other
  cv_source          text,           -- free-form: which CV was used (e.g. "mahesh", "wife-nursing")
  iteration          int  not null default 1,  -- improve-loop round number

  -- what produced this row
  writer_variant     text not null,  -- w1_current | w2_general | w3_composition | w4_chat
  scorer_variant     text not null,  -- s1_current | s2_grounded | s3_reweighted | s4_llm
  model              text,           -- resolved AI model id

  -- lifecycle (background pattern: row is created 'running', updated on finish)
  status             text not null default 'running',  -- running | completed | failed
  error              text,

  -- outputs
  tailored_md        text,
  initial_ats        int,
  final_ats          int,
  ats_lift           int,

  -- structured reports (deterministic)
  structural_summary jsonb,          -- run_tailored_structural_validation summary+gates
  grounding_report   jsonb,          -- Layer-A named-entity grounding (ungrounded list)
  rescore_report     jsonb,          -- injected / failed / fabricated keywords
  auto_metrics       jsonb,          -- any extra computed numbers
  timings_ms         jsonb,          -- per-stage latency

  created_at         timestamptz not null default now()
);

create index if not exists eval_runs_experiment_idx on public.eval_runs (experiment_id);
create index if not exists eval_runs_writer_idx     on public.eval_runs (writer_variant);
create index if not exists eval_runs_created_idx     on public.eval_runs (created_at desc);

-- RLS on, no policies: only the service role (cv-backend + web server routes)
-- can touch this table. No browser/anon access. Safe by default.
alter table public.eval_runs enable row level security;
