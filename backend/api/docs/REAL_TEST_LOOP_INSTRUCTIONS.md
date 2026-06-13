# Real-test loop — overnight 40-job re-analysis + broad fixing

> **Written:** 2026-06-12 · **Branch:** `refactor/architecture-review` (stay here; merge to main is later)
> **Audience:** the next session (you). The user will paste a fresh OpenAI API key and say "go".
> **Prereq docs:** `PHASE_2_PLUS_STATUS.md` (JD-extraction), `ATS_SCORING_V2.md` (scoring v2).

---

## 1. Mission

Re-analyse the user's **~40 already-analysed jobs** against their **active CV**, through the
real LLM-backed pipeline (their OpenAI key), in **batches of 5 unique jobs**. For each batch:

1. **Analyse** the 5 jobs.
2. **Compare** the output against what an honest, complete analysis should produce.
3. **Diagnose** the issues — and **categorise** them (not "this JD broke", but "this *class*
   of phrasing/structure breaks").
4. **Fix broadly** — change the systemic layer so the issue cannot recur on this JD, on the
   other 39, *or* on a future JD of a different vertical.
5. **Verify** (`pytest`), **commit**, **update the ledger**, move to the next batch.

Run all 40 (8 batches). It does **not** have to be perfect — improve as much as possible
within the time/quality budget. Stop when all 40 are done or the user interrupts.

## 2. The non-negotiable philosophy — BROAD fixes only

The user was explicit: **no case-by-case, no per-JD, no word-by-word patching.** If a fix only
helps the one JD in front of you, it is the wrong fix. Lines-of-code must not balloon.

**Where broad fixes live (in priority order — prefer the highest layer that solves it):**

| Layer | File(s) | Use when |
|---|---|---|
| Lexicon vocabulary | `app/services/skills/lexicons/{nursing,tech,cleaning}.json`, `_universal_noise.json` | A phrasing is mis-bucketed, leaked as a skill, or a real skill is unrecognised. **Add a variant/canonical/noise entry — it then works for every JD.** |
| Pattern recognisers | `app/services/skills/post_process.py` (`_looks_like_language`, `_is_au_unit_code`, conditional demoter, recall floor, subsumption) | A whole *family* of phrasings needs structural handling (codes, conditionals, languages, parent/child). Add/extend a regex or rule, not an enumerated list. |
| Groundedness / recall | `verify_skill_evidence`, `enrich_required_skills_from_jd_body` | Hallucinated skills survive, or real skills go missing across runs (variance). |
| Scoring | `app/services/pipeline/steps/ats_scoring.py`, `experience_parser.py` | The number is wrong for a *reason that generalises* (a sub-signal mis-measures a whole class). |
| Writer/composition | `app/services/eval/writers/` | The tailored CV prose is dishonest or low-quality for a *class* of inputs. |

**Litmus test before any edit:** "Would this also fix the same problem on a tech JD / a
cleaning JD / a JD I haven't seen?" If no → find the higher layer. If you truly can't
generalise, **log it in the ledger under `deferred_narrow_issues` and move on** — do not
hack it.

## 3. Prerequisites (do these once, at the start)

1. **Branch check.** `git -C /Users/mahesh/Documents/Github/jobtrackr-cv branch --show-current`
   → must be `refactor/architecture-review`. If not, `git checkout` it.
2. **Tests baseline.** `cd cv-backend && ./.venv/bin/pytest -q` → must be **915 passed**.
   This is the floor; never commit a batch that drops below it.
3. **OpenAI key.** The user pastes it in chat. **Never write it to a committed file.** Export
   it into the loop's environment only (e.g. a gitignored `backend/api/.env.realtest` that the
   driver reads, or an inline env var). Confirm it's gitignored.
4. **Local cv-backend, refactor-branch code.** The whole point is to test *our new code*
   without a Fly deploy. Run cv-backend locally so edits take effect on restart:
   ```bash
   cd cv-backend && ./.venv/bin/uvicorn app.main:app --port 8099 --log-level info
   ```
   (Run it in the background via the Bash tool's `run_in_background`. Verify it answers
   `GET /health` or similar before driving traffic.)
   - It already has Supabase service-role creds in `backend/api/.env` → it can read jobs + the
     active CV and write `analysis_runs`.
   - The HMAC header: internal routes are HMAC-guarded (`JOBTRACKR_HMAC_SECRET`). The driver
     must sign requests the same way the web layer does — **find the signing helper first**
     (`grep -rn "verify_hmac\|hmac" app/routes app/core`) and mirror it, or temporarily drive
     the pipeline in-process (see §4, Option B) to skip HTTP entirely.

## 4. Step 0 — Discover the data layer (do NOT assume the schema)

Before writing the driver, confirm exactly where things live. Spend a few minutes here; it
saves a wrong-shaped script later.

- **The 40 jobs + their JD text:** look at how the web app lists analysed jobs. Reference:
  `web/src/app/(dashboard)/dashboard/**` queries and the `analysis_runs` / `jobs` tables.
  `grep -rn "analysis_runs\|jobs" web/src/lib` and the Supabase migrations under
  `shared/supabase/migrations/` for column names.
- **The active CV:** `cv_versions` table, `is_active = true` for the user (one per user, partial
  unique index — see CLAUDE.md decision #8). Get its `cv_text` + `contact_details`.
- **The user_id:** the owner of those jobs. Confirm there's exactly one relevant user.

**Two ways to run the pipeline — pick the simpler that works:**

- **Option A — HTTP (closest to production):** POST `AnalyzeRequest` to
  `http://localhost:8099/internal/analyze` per job (schema in
  `app/schemas/internal.py:AnalyzeRequest`: `run_id, user_id, cv_version_id, jd_text, cv_text,
  ai_provider="openai", ai_api_key=<key>, ai_model="gpt-5.1" or similar, contact_details`).
  It's 202-async → it writes results to `analysis_runs.{run_id}`; poll that row for completion.
  Requires HMAC signing.

- **Option B — in-process (simpler for a dev loop):** import and call
  `run_analysis_pipeline(AnalyzeRequest(...))` directly from a small script under
  `backend/api/scripts/realtest_driver.py`, using `make_ai_client("openai", key, model)`.
  No HTTP, no HMAC, but you must replicate the row pre-creation the orchestrator expects
  (check `orchestrator.py` for what it reads/writes; it pre-reads cached step results, so a
  fresh `run_id` per re-run avoids resume collisions). **This is the recommended path** —
  fewer moving parts, and you can read the returned/persisted result directly.

Write `backend/api/scripts/realtest_driver.py` as the reusable entry the loop calls. Keep it
**idempotent per job** (fresh `run_id`, but record the source job id in the ledger so we never
double-process).

## 5. The durable ledger — what makes this survive context compaction

**Context will compact (~80% used). Conversation memory is NOT reliable across that boundary.**
The only reliable progress record is **on disk.** Create and maintain:

```
backend/api/docs/realtest/ledger.json     # progress + findings (COMMITTED each batch)
backend/api/docs/realtest/runs/<jobid>.json   # raw analysis output per job (for diffing)
```

`ledger.json` shape (create it on first run):
```json
{
  "updated": "2026-06-12T23:10:00",
  "active_cv_version_id": "...",
  "user_id": "...",
  "total_jobs": 40,
  "all_job_ids": ["...x40"],
  "processed_job_ids": [],
  "batches": [
    {
      "n": 1,
      "job_ids": ["...x5"],
      "issues": [
        {"class": "noise-leak", "example_phrase": "work in partnership with families",
         "verticals_affected": ["nursing"], "fix": "added to _universal_noise.json",
         "commit": "<sha>", "generalised": true}
      ],
      "tests": "915 passed",
      "commit": "<sha>"
    }
  ],
  "deferred_narrow_issues": [],
  "done": false
}
```

**Every batch ends by writing + committing the ledger.** On any cold restart, the FIRST action
is: read `ledger.json`, compute `remaining = all_job_ids - processed_job_ids`, resume there.
If `ledger.json` doesn't exist yet, this is batch 1 — build `all_job_ids` from Step 0.

## 6. The batch workflow (repeat 8×)

For each batch of 5 unprocessed job ids:

1. **Run** the 5 through `realtest_driver.py` (OpenAI key). Save each raw result to
   `runs/<jobid>.json`.
2. **Compare / diagnose.** For each job, look for the recurring failure classes we already
   know (and any new ones):
   - noise leaking into skills (availability, sector/setting descriptors, "in partnership…")
   - real skills unrecognised (missing lexicon canonical/variant)
   - hallucinated skills surviving the groundedness gate
   - cross-run variance (same JD, different skill set) → recall-floor gap
   - redundant parent+child both kept → subsumption gap
   - ATS sub-signal mis-measuring (wrong vertical tag, tenure not counted, responsibility
     coverage missing obvious matches)
   - dishonest/weak summary or bullet prose
3. **Categorise** each issue by *class* + *which layer fixes it broadly* (§2 table).
4. **Apply the broad fix** at the highest layer that solves it. Prefer data (lexicon JSON) over
   code; prefer one regex/rule over an enumerated list.
5. **Add/extend a test** when you touch logic (recogniser, scoring, recall/subsumption). For
   pure lexicon additions, the golden harness + existing suites are usually enough; add a
   golden JD only if the class is important and uncovered.
6. **`./.venv/bin/pytest -q`** → must stay ≥ 915. If a golden-JD expected set legitimately
   changed because the chain improved, re-pin it (that's the harness working as designed — see
   `PHASE_2_PLUS_STATUS.md`).
7. **Commit** (scope: only files changed this batch — per the standing commit-scope rule).
   Message: `realtest batch N: <issue classes fixed>`.
8. **Update + commit `ledger.json`** (`processed_job_ids += batch`, append the batch record).
9. Next batch.

When `processed_job_ids` reaches 40 → set `done: true`, write a final summary section in the
ledger (top issue classes, total commits, anything deferred), commit, and **stop the loop**.

## 7. Scheduling — how to make it auto-run overnight

**Recommended mechanism: `/loop` (self-paced) + the on-disk ledger.** Rationale:

- `/loop` re-enters the task on a schedule the model sets via `ScheduleWakeup`. The schedule is
  held at the **harness level**, so it survives context compaction — when context is summarised,
  the next wake still fires and re-reads the ledger.
- The ledger (not conversation memory) is the source of truth, so a cold/summarised restart
  resumes cleanly: read ledger → remaining jobs → next batch.
- It runs **locally** (needs local cv-backend + venv + git + the key), matching "laptop open
  overnight." `/schedule` (cloud routines) is the wrong tool here — cloud agents don't have the
  local backend/key/repo.

**How the user starts it (they type this once):**
```
/loop continue the real-test loop per backend/api/docs/REAL_TEST_LOOP_INSTRUCTIONS.md — read the ledger, process the next batch of 5, fix broadly, commit, update the ledger, repeat until all 40 done
```
(No interval → self-paced. The model picks the wake delay with `ScheduleWakeup` after each
batch — a batch involves real LLM calls + edits + pytest, so pace at the natural batch
cadence, not a fixed clock.)

**Your responsibilities inside each loop iteration:**
- Do exactly ONE batch per iteration (keeps each turn bounded, compaction-safe).
- Always start by reading `ledger.json`; always end by committing it.
- If `done: true` in the ledger → do nothing and **omit the next `ScheduleWakeup`** so the loop
  ends cleanly.
- If the local cv-backend died (port not answering), restart it before driving traffic.
- If the OpenAI key is missing/expired (401s), STOP, write the reason into the ledger, and
  surface it for the user instead of silently looping on failures.

## 8. Guardrails

- **Never** commit the OpenAI key. Confirm `.env.realtest` (or wherever the key lands) is
  gitignored before the first commit.
- **Never** drop below 915 tests. A red suite blocks the commit; fix or revert the batch.
- **Stay on `refactor/architecture-review`.** No merge to main this session.
- **Commit scope:** only files changed in the current batch (standing rule —
  `feedback_commit_scope`). The repo has a lot of pre-existing dirty `.pyc`/`.env` noise; never
  `git add -A`.
- **Don't `rm`/overwrite a dirty working-tree file** without capturing it first (standing rule).
- **Broad over narrow, always.** If you catch yourself adding the 3rd near-identical per-phrase
  entry, stop and write the regex/rule instead.
- **Cost awareness:** real OpenAI calls. 40 jobs × full pipeline is the budget the user signed
  up for; don't re-run jobs already in `processed_job_ids`.

## 9. Definition of done

- All 40 jobs processed (`processed_job_ids` length 40, `done: true`).
- A ledger that reads as a clean audit: issue classes, the broad fix + commit for each, and an
  honest `deferred_narrow_issues` list for anything that couldn't be generalised.
- 915+ tests green at the final commit.
- A short closing summary committed to the ledger so the *following* session can pick up the
  deferred items.
```
```

## 10. First-iteration checklist (paste-ready for yourself)

1. `git branch --show-current` == refactor/architecture-review
2. `pytest -q` == 915 passed
3. OpenAI key present in env, gitignored
4. local cv-backend up on :8099 (background) and answering
5. ledger.json exists? → resume. Else → Step 0 builds `all_job_ids`, then batch 1.
6. Process exactly one batch, commit code + ledger, schedule next wake.
