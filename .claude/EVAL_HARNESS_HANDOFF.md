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
- **DB**: `shared/supabase/migrations/043_eval_runs.sql` + `044_eval_runs_status.sql` — isolated
  `eval_runs` table (RLS on, service-role only). No existing table touched.
- **Backend** (`backend/api/app/services/eval/`): `runner.py` (background compute+persist),
  `writers.py` (writer registry), `scorers.py` (scorer registry), `grounding.py` (Layer-A
  fabrication metric), `enforce.py` (skills hygiene), `enforce_w3.py` (deterministic gates),
  `role_families.py` (RoleFamilyProfile config + router). Prompts in
  `backend/api/app/services/ai/prompts/variants/` (tailored_cv_general, tailored_cv_chat,
  composition, tailored_cv_w6).
- **Backend endpoints** (`routes/internal.py`): `POST /internal/analyze-eval` (202+id,
  background) + `GET /internal/eval-run/{id}` (poll). HMAC-gated.
- **Web**: founder-only `/dashboard/beta` (page.tsx + BetaClient.tsx) + API routes
  `/api/eval/run` (POST fan-out) and `/api/eval/run/[id]` (GET poll). cvBackend.ts has
  `triggerEvalRun` + `getEvalRun`.

## Variants
Writers: **W1** current prod · **W2** generalised-lean · **W3** composition (role-pack +
gates) · **W4** chat single-call · **W5** lexical-surfacing · **W6** re-engineered general
W1 prompt · **W7** = W6 prompt + W3 gates (validated winner pre-W8) · **W8** = the
production-integration writer (role-family composition engine + the FROZEN production
presentation contract reproduced 1:1 via the canonical sandwich + W7's full gate stack +
family section ordering). W8 is the deliverable of the "document production → integrate
into new engine → adapt for nursing" task; it fixes W7's one residual (nursing now leads
with "Registration & Licences" and every family's section order is honoured).

### W8.4 — production selection logic integrated into the composition engine
`composition.py` `_UNIVERSAL_ENGINE` rewritten to fold in the proven production
TAILORED_CV_SYSTEM selection mechanisms, **generalised for any sector and
example-free** (no Outlier/CV-Agent/iBuild baked nouns → no example-bleed; ~150
assembled lines vs production's 976 → no hallucination bloat). Added, all
field-agnostic: GENERATION ORDER + ghost-reference ban; JD-FOCUS ALIGNMENT
(general off-axis suppression — demote/replace off-axis bullets, keep off-axis
tools out of Skills/summary, every sector); EXPERIENCE selection (rank
direct→adjacent→transferable, 1-3 roles, sparse floor, per-bullet relevance =
reframe-don't-lift, consolidate 4+→2-3); PROJECTS selection (domain-OR-method,
rank stack>domain>metrics, ≤2, omit if none, duplication ban); EDUCATION
keep-Bachelor + drop off-field grads; CAREER SUMMARY 2-sentence mandatory +
NO-ECHO + tool ban + 2-clause achievement; MIRROR-THE-JD-VOCABULARY (fixes
"commercial framing missing"); DEMONSTRATE-KEY-SKILLS (fixes phantom-skill
critique honestly); 5-point self-check. Affects W3/W5/W8 (all eval). Fixes the
W8+ run issues: wrong project selected, off-axis Bitrates/AI bullets not
suppressed, no commercial language. Residuals NOT code-gated (honesty): occasional
1-sentence Highlights (model variance — prompt+self-check only, never fabricate a
2nd sentence) and whole-entry project dup (prompt ban + bullet-dedup gate; no
fuzzy title gate to avoid false-drop downgrade).

### W8 sophistication stack (W8.0–W8.3, all additive)
- **W8.0 structural hardening** (`enforce_w8.py` + `enforce_w3.py`): merge same-named
  sections (fixes duplicate "Clinical Experience" the mismatch case dumped at the end),
  drop empty placeholder sections, relabel a filler nursing "Registration & Licences" →
  "Checks & Clearances" for unregistered care roles (AINs hold no AHPRA reg). Degree gate:
  when every entry is an irrelevant grad (model dropped the Bachelor), keep only the FIRST
  instead of the whole pile.
- **W8.1 per-claim entailment verify** (`verify.py`, Stage 6): one focused field-agnostic
  AI call (temp 0) checks each Experience/Projects bullet is entailed by the source CV;
  repairs or drops the rest. Catches reframed/inflated claims entity-grounding misses.
  Best-effort (never crashes). Shipped as **`w8_verified`** = `w8_integrated` + verify so
  the beta can A/B the honesty lift.
- **W8.2 knockout pass** (`knockout.py`, Stage 3): deterministic regex over raw JD+CV +
  `experience_years_required` → mandatory licence/registration, min years, work-rights.
  Per-domain curated config. Surfaced in `WriterResult.extras["knockouts"]` (both W8
  variants). data-CV→nursing = 4 hard fails.
- **W8.3 equivalence table** (`role_families.py` `equivalences` + `apply_equivalences`,
  Stage 1): per-family verified synonym/child→parent table. Promotes a JD term to
  inject_directly only when JD wants it AND the CV literally has a justifying term AND
  policy≠none. Replaces over-permissive AI guessing for these terms. tech: SQL↔db engines,
  Data Visualisation←Power BI/Tableau, PostgreSQL←SQL. nursing: Aged Care←Ageing Support
  (true synonyms only). manual: none (policy none).
- **Deferred (Phase C, not built):** Stage 4 production ensemble + Stage 8 auto-judge/
  ATS-parser-sim. Knowledge corpus + Learning Flywheel remain out of scope.

### W8 mechanism (`backend/api/app/services/eval/enforce_w8.py`)
The frozen production contract (`steps/tailored_cv._enforce_structure` +
`_inject_missing_skills`, `contact_line.stamp_contact_line`) and the W3 gates are all
hard-wired to the TECH/master canonical section names. W8 reuses them VERBATIM for any
family via a **canonical sandwich**: `to_canonical` renames family headings →
canonical (nursing: Professional Summary→Career Highlights, Clinical Experience→
Professional Experience; manual: Summary→Career Highlights, Work Experience→Professional
Experience, Certifications & Checks→Certifications), run the whole frozen production +
gate stack, then `restore_and_order` renames back and reorders to `rf.section_order`.
Zero reimplementation of production logic = guaranteed 1:1 fidelity (PDF format,
bullet-writing method, bullet counts, 2-sentence/35-50-word summary method all identical).
Config-driven only — no per-case tokens (anti-overfit). Smoke-tested: bullet caps (4→3)
and role caps (4→3) fire on the renamed sections; nursing output leads with Registration
& Licences. Compile + functional smoke OK.
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

## Validation status — COMPREHENSIVE, W7 confirmed across the spectrum
- Strong tech match (CAE): AI suppressed, honest lift.
- AI-forward (Mercor): kept AI identity correctly.
- Poor tech match (MONEYME fraud/AML): all fraud/AML/credit-card → honest gaps, 0 fabrication.
- Strong nursing match (wife's CV, AIN JD): "Clinical Skills" taxonomy, 0 fabrication,
  honest gaps = the specific nursing enrolments she lacks, kept Bachelor, +12 honest lift (S5).
- Total mismatch (Mahesh data CV → nursing JD): 0 fabrication, honest "career-changer"
  reframe on transferable soft skills, correct LOW score (22→27). Honesty held under max pressure.
- **W7 is the validated production winner.**
- **Still untested**: cleaner/admin (`none` injection policy). Optional before promotion.
- **Test artifact noted**: running someone else's CV under your account stamps YOUR
  contact_details on the H1 (e.g. "Maheshwor Tiwari" on the wife's nursing CV). Not a bug —
  production uses each user's own contact. The missing-H1 in the data→nursing run was the
  same cause. If a real missing-H1 recurs with the correct user, add a deterministic
  header-stamp fallback.

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
- Deploy: `git push` (web→preview) + `flyctl deploy` from inside `backend/api/` (additive).
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
