# Eval Harness — Session Handoff (2026-05-28)

Branch: **`feat/eval-harness`** (NOT merged). Rollback anchor tag: **`eval-baseline`** (= old `main` @ d577c04).
11 commits, all additive. Production (`main`, W1 path) is UNTOUCHED.

> ⚠️ `main` has moved on (jd+donut work) since the branch was cut. Before promotion,
> merge latest `main` INTO the branch and resolve (eval code is additive → low conflict).

## Why this exists
The app's tailoring was tuned for one person (data-analyst). Goal: an **honest** engine
that works for **any CV / any job**. Built an A/B/C/D harness to compare prompt/pipeline
variants on the same CV+JD and iterate with evidence, not guesses.

## What was built (all additive, isolated)
- **DB**: `supabase/migrations/043_eval_runs.sql` + `044_eval_runs_status.sql` — isolated
  `eval_runs` table (RLS on, service-role only). No existing table touched.
- **Backend** (`cv-backend/app/services/eval/`): `runner.py` (background compute+persist),
  `writers.py` (writer registry), `scorers.py` (scorer registry), `grounding.py` (Layer-A
  fabrication metric), `enforce.py` (skills hygiene), `enforce_w3.py` (deterministic gates),
  `role_families.py` (RoleFamilyProfile config + router). Prompts in
  `cv-backend/app/services/ai/prompts/variants/` (tailored_cv_general, tailored_cv_chat,
  composition, tailored_cv_w6).
- **Backend endpoints** (`routes/internal.py`): `POST /internal/analyze-eval` (202+id,
  background) + `GET /internal/eval-run/{id}` (poll). HMAC-gated.
- **Web**: founder-only `/dashboard/beta` (page.tsx + BetaClient.tsx) + API routes
  `/api/eval/run` (POST fan-out) and `/api/eval/run/[id]` (GET poll). cvBackend.ts has
  `triggerEvalRun` + `getEvalRun`.

## Variants
Writers: **W1** current prod · **W2** generalised-lean · **W3** composition (role-pack +
gates) · **W4** chat single-call · **W5** lexical-surfacing · **W6** re-engineered general
W1 prompt · **W7** = W6 prompt + W3 gates (THE WINNER).
Scorers: **S1** current ATS · **S2** grounded · **S5** ATS-readiness (parseability +
grounded lexical coverage — the honest, demonstrable lift). S3/S4 deferred (skip — S2/S5
answer the scorer question; real validation needs callback data, not more scorers).

## Findings (proven across runs — the load-bearing lessons)
1. **Prose rules don't hold; deterministic code does.** Suppression, degree-pruning,
   skills caps, 2-sentence highlights — only the *code gates* held reliably. The 976-line
   W1 prompt's bias + baked examples caused example-bleed (same projects/degrees regardless
   of JD).
2. **Honest lift is real under S5** (e.g. W7 nursing 45→55, +10). Under S2 it's ~0 because
   tailoring adds no NEW honest keywords; the lift was always fabrication. S5 credits
   honest exact-term surfacing → the number to show users. (Real ATS: parsing is the
   mechanical gate; recruiters boolean-search exact terms; auto-reject is mostly a myth —
   see research in chat.)
3. **Domain expertise cannot be inferred.** Systematic leak (CAE "financial analysis",
   MONEYME "transaction monitoring"). Fix shipped: `restrict_domain_to_direct` demotes all
   `domain_knowledge` inject_as_extension/inference → cannot_inject, ALL verticals, in
   W3/W6/W7. Technical inference (SQL→PostgreSQL) and soft-skill reframing stay allowed.
   Philosophy: infer a TOOL, reframe/add a SOFT skill with anchor, NEVER claim a DOMAIN.

## Validation status
- **W7 validated honestly** on 3 tech JDs (CAE, Mercor, MONEYME) + **nursing** (wife's CV,
  licensed vertical): 0 fabricated clinical skills, "Clinical Skills" taxonomy, kept
  Bachelor, +10 honest lift, no AI-suppression misfire. **W7 is the production winner.**
- **Still untested**: cleaner/admin (`none` injection policy). Run before promotion.

## Known residuals (NOT fixed — judged variance or low-value; revisit only if systematic)
- 1-sentence Highlights = model variance (W6 got 2, W7 got 1 same prompt) — don't chase.
- Bachelor occasionally dropped by the writer (gate can't re-add; would need a fragile
  reconstruction). Watch across verticals.
- W7 uses W6's GENERAL section order — does NOT lead with "Registration & Licences".
  Fine for AIN/student; matters for a fully-registered RN/EN (W3's role-pack section order
  would handle it). Optional future enhancement.
- Grounding noise on hyphenated/date tokens ("Problem-solving", "Completed May") — cosmetic.

## NEXT SESSION
User wants MORE TESTS first. To run: deploy branch, use `/dashboard/beta` on the Vercel
preview.
- Deploy: `git push` (web→preview) + `flyctl deploy` from inside `cv-backend/` (additive).
- No new migration needed (043+044 already applied to Supabase).
- Suggested tests: cleaner/admin JD (W7, vertical=cleaner); re-run MONEYME W7 to confirm
  "transaction monitoring" now lands in Honest gaps; more diverse CVs/JDs.
- Judge for PATTERNS across the set, not single-run blemishes (anti-overfit discipline —
  user is firm on this; do NOT add per-case prompt tokens).

## THEN: promotion plan (when user approves — touches production)
1. Merge latest `main` into `feat/eval-harness`; resolve.
2. Point production `/internal/analyze` pipeline at the W7 path (W6 prompt + apply_w3_gates
   + restrict_domain_to_direct + enforce_skills_section) instead of W1's prompt.
3. Thread `vertical` (from search_profiles target role) into the real pipeline so
   gates/router work in production.
4. Display S5 as the honest ATS lift (or show S1+S5).
5. Cleanup PR: retire W2/W4/W5 + S3/S4 scaffolding; keep the beta harness for future A/B.
6. Stage on preview → run real flow once → merge to main (auto-deploys prod).
