---
name: pr-review
description: "Review a PR or diff. Categorize findings (blockers, warnings, suggestions, nits, what's good), score them, suggest fixes. Use when the user says 'review this PR', 'review the diff', '/pr-review'."
trigger: /pr-review
---

# PR Review

Review a pull request diff, produce a scored report with categorized findings and concrete fix suggestions.

## Usage

```
/prreview                          # review current branch vs main
/prreview fix login bug            # review specific commits/scope
/prreview --base develop           # custom base branch
```

## What You Must Do When Invoked

### Step 1 — Recon

Identify the diff scope:

```bash
# Get changed files vs main
git diff main...HEAD --name-only

# Get the full diff
git diff main...HEAD --stat
git diff main...HEAD
```

If `$ARGUMENTS` specifies a scope (e.g. "the last 3 commits" or "backend/api only"), filter the diff accordingly.

Identify which services are touched:
- `frontend/web/` → frontend changes
- `backend/api/` → Python backend changes
- `backend/worker/` → Node worker changes
- `supabase/migrations/` → database changes
- `.opencode/skills/` → AI skill changes

### Step 2 — Run CI Checks

Run only the checks relevant to the changed services:

```bash
# Frontend
cd frontend/web && npx tsc --noEmit        # TypeScript
cd frontend/web && npm run lint            # ESLint

# Backend API
cd backend/api && python -m pytest -x     # Python tests

# Worker
cd backend/worker && npx tsc --noEmit     # TypeScript
cd backend/worker && npx vitest run        # Vitest

# Auth guard (if API routes changed)
node frontend/web/scripts/check-route-auth.mjs

# Migration lint (if migrations changed)
node shared/supabase/scripts/lint-migrations.mjs
```

Record pass/fail for each check. Failures in tsc, pytest, or vitest are **blockers**.

### Step 3 — Code Review

Read every changed file. For each file, check across 6 dimensions:

#### Security
- Missing auth on new routes (check `requireUser()` or `getAuthUser()`)
- IDOR: can user A access user B's resource by changing an ID?
- Missing ownership verification on admin endpoints
- Secrets in client bundle (`NEXT_PUBLIC_*` must not contain secrets)
- SSRF on user-supplied URLs (no validation)
- Missing rate limiting on state-changing endpoints
- HMAC verification missing on internal routes
- XSS via unescaped user input or `dangerouslySetInnerHTML`

#### Correctness
- Logic errors (wrong operator, off-by-one, missing return)
- Unhandled edge cases (null, empty array, missing fields)
- Type safety (`any` types, missing type guards)
- Error handling (swallowed errors, wrong error type)
- Async issues (missing `await`, race conditions)

#### Architecture
- Duplicate types (should import from `lib/types.ts`, `lib/constants.ts`)
- Pattern inconsistency (server actions vs route handlers for same operation)
- Non-additive database changes (ALTER/DROP on existing tables)
- Missing `revalidatePath` after writes
- Importing from wrong canonical source

#### Performance
- Unnecessary re-renders (missing `React.memo`, missing `useMemo`)
- N+1 queries (fetching in a loop instead of batch)
- Missing indexes on frequently queried columns
- Large bundle imports (importing entire library vs specific function)

#### Testing
- New code has no tests (if pure function)
- Existing tests broken by the change
- Test coverage gaps for edge cases

#### Naming
- File naming convention: `FolderName/` should contain `FeatureName.tsx`, not `FolderFeatureName.tsx`
- No duplicate constants/types across files
- Consistent naming with existing patterns

### Step 4 — Categorize Findings

For each finding, assign a category:

| Category | Definition | Example |
|----------|-----------|---------|
| **Blocker** | Must fix before merge. Security漏洞, data loss risk, CI failure, broken existing functionality. | Missing auth on endpoint, TypeScript error, test failure |
| **Warning** | Should fix. Likely bug, pattern violation that will cause issues, missing validation. | Missing `revalidatePath`, no error handling on fetch, `any` type |
| **Suggestion** | Nice to have. Cleaner approach, better pattern, performance improvement. | Use canonical type instead of inline, extract helper function |
| **Nit** | Style/formatting. Naming, spacing, comment clarity, variable naming. | Inconsistent naming, unused import, long line |
| **What's Good** | Acknowledge solid patterns. Specific praise for well-done code. | Clean error handling, good type safety, follows patterns |

### Step 5 — Score

Start at **100 points**. Apply deductions:

| Category | Per finding |
|----------|-----------|
| Blocker | -10 |
| Warning | -5 |
| Suggestion | -2 |
| Nit | -1 |
| What's Good | +3 |

Minimum score: 0. Maximum: no cap (but rare to exceed 115).

### Step 6 — Fix Suggestions

For every Blocker and Warning, provide a concrete code snippet showing the fix. For Suggestions, provide the approach. For Nits, just note the issue.

### Step 7 — Verdict

| Score | Verdict |
|-------|---------|
| 90+ | **APPROVE** — merge when ready |
| 70-89 | **APPROVE_WITH_NOTES** — merge after addressing warnings |
| <70 | **REQUEST_CHANGES** — fix blockers before merge |

## Output Format

```markdown
## Verdict: [APPROVE / APPROVE_WITH_NOTES / REQUEST_CHANGES] ([score]/100)

## Summary
Brief overview of what the PR does and overall quality assessment.

## CI Status
| Check | Status |
|-------|--------|
| tsc --noEmit | ✅ Pass |
| pytest | ✅ Pass |
| eslint | ❌ 2 errors |
| auth guard | ✅ Pass |

## Findings

### 🚫 Blockers ([count], [points])
1. **[Blocker]** `path:line` — Description of the issue
   - **Why:** Explanation of impact
   - **Fix:**
   ```code
   // concrete fix
   ```

### ⚠️ Warnings ([count], [points])
1. **[Warning]** `path:line` — Description
   - **Why:** Explanation
   - **Fix:**
   ```code
   // concrete fix
   ```

### 💡 Suggestions ([count], [points])
1. **[Suggestion]** `path:line` — Description
   - **Approach:** How to improve

### 📝 Nits ([count], [points])
1. **[Nit]** `path:line` — Description

### ✅ What's Good ([count], [points])
- `path:line` — Why this is well done
- `path:line` — Why this is well done

## Score Breakdown
| Category | Count | Points |
|----------|-------|--------|
| Blockers | [n] | [n × -10] |
| Warnings | [n] | [n × -5] |
| Suggestions | [n] | [n × -2] |
| Nits | [n] | [n × -1] |
| What's Good | [n] | [n × +3] |
| **Total** | | **[score]/100** |

## Recommendation
One paragraph. Either: "Merge when ready" with reasoning, or "Fix [specific items] then re-review" with priority order.
```

## Rules

- Be specific. "Looks good" is useless. "Lines 47-62: the trust_score weighting reverses the priority" is useful.
- Every finding must have `path:line` reference.
- Severity matters. A typo in a comment is not a Blocker. A missing RLS policy is. Calibrate accordingly.
- Don't inflate findings to look thorough. Don't downplay to look clean.
- If you cannot reach a verdict (insufficient context, missing diff), ask for it.
- Run CI checks — don't assume they pass.
- The developer commits manually. Do not run `git commit`.
