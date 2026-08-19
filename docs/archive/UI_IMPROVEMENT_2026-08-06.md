# UI Improvement Design — 2026-08-06

> **Archived 2026-08-19** — this plan's core proposal shipped
> (`scripts/check-theme-tokens.mjs` is now a hard CI gate per CLAUDE.md).
> Moved here as a completed record; not maintained.

Companion to [UI_AUDIT_2026-08-06.md](./UI_AUDIT_2026-08-06.md). The audit
catalogues symptoms; this document argues about causes and proposes the
structural fix, then sequences it.

---

## 1. Diagnosis: the token system has no enforcement boundary

The instinct on reading the audit is "replace 559 hardcoded colours." That is
the wrong first move, and it is worth being precise about why.

**Those 559 occurrences accumulated *after* the token system existed.** The
themes, the `--brand`/`--brand-fg` pair, the `--chart-*` palette, the semantic
type scale — all of it predates most of the violations. So the system did not
fail because it was missing. It failed because nothing stopped anyone from
routing around it, and routing around it is *easier* than using it:

```
bg-amber-50                    ← autocompletes, ships everywhere, looks right in dev
bg-[var(--amber-light)]        ← must be remembered, no autocomplete, no type safety
```

A pure find-and-replace resets the counter to zero and the counter starts
climbing again the same week. Any plan that does not change the *gradient* —
which of the two lines above is the path of least resistance — is buying a
temporary result at permanent cost.

### 1.1 The tell: a runtime patch for a compile-time problem

`globals.css:1193–1318` is ~125 lines of `!important` overrides that catch
hardcoded palette classes and re-point them at tokens. It is careful, it is
well-commented, and it is the clearest possible evidence of the real problem:

- It is **scoped to Aurora only**, so Gilded Noir — equally dark — gets nothing.
- It is **enumerative**, so it covers `bg-green-100` but not `bg-green-500`,
  `text-amber-700` but not `text-amber-500`, and no `slate`/`gray`/`zinc` at all.
- It **cannot ever be complete**, because it is chasing a set that grows with
  every commit.
- It is **invisible at the call site** — the component says `bg-gray-100`, and
  whether that is correct depends on a stylesheet 1,200 lines away that a
  reviewer will not open.

This block should not be extended to the other themes. It should be **deleted**,
once the source is clean enough that it has nothing to catch.

### 1.2 The same root cause explains the unrelated-looking bugs

Several audit findings that read as separate defects are the same failure:

| Symptom | Same cause |
|---|---|
| `sourcePillTone()` written, tokenised, never imported | correct path existed, wrong path was easier |
| `text-white` on `--brand` in 7 places | `--brand-fg` exists, nothing requires it |
| Aurora remap covers `-100` but not `-500` | enumeration cannot keep up |
| `dark:` variants keyed to the OS | no compile-time signal that the app's dark themes are class-based |
| `ResumePausedBanner`'s dead button colours | unlayered `.gh-btn` silently wins; no error |

Five findings, one fix shape: **make the correct thing the ergonomic thing, then
make the incorrect thing fail the build.**

---

## 2. The proposed architecture

Three layers. Each is independently useful; together they close the loop.

### Layer 1 — A semantic token vocabulary (make the right thing easy)

Today a component that needs "a warning chip" has no token to reach for. There
is `--amber` and `--amber-light`, but no border token, and nothing named for the
*meaning*. So the author writes `bg-amber-50 border-amber-200 text-amber-700`,
which is three correct-looking decisions and one wrong one.

Extend the existing token set — **do not invent a parallel one** — with the two
missing rungs and a semantic alias per family:

```css
/* per theme, alongside the existing --green / --green-light / … */
--success: var(--green);
--success-subtle: var(--green-light);
--success-border: color-mix(in srgb, var(--green) 35%, transparent);
/* …warning→amber, danger→red, info→blue, accent→purple, neutral→surface-2 */
```

mapped through the existing `@theme inline` block so Tailwind generates real
utilities:

```css
@theme inline {
  --color-success: var(--success);
  --color-success-subtle: var(--success-subtle);
  --color-success-border: var(--success-border);
  /* … */
}
```

The call site then reads:

```
bg-success-subtle border-success-border text-success
```

Same character count as the palette version, autocompletes, and correct on all
seven themes by construction. This is the load-bearing change — everything after
it is mechanical.

Two side benefits fall out for free:

- `.badge-green` and friends currently hardcode `border-color: rgba(26,127,55,.3)`
  — the *light-theme* green, on every theme. Pointing them at `--success-border`
  fixes badges on the dark themes as a side effect.
- `ATS_BAND_META` and the chart palette collapse onto the same vocabulary, so the
  ATS dot, the ATS bar, the donut slice and the funnel chip stop being four
  independent colour decisions.

### Layer 2 — A CI guard (make the wrong thing impossible)

This repo already has the right pattern: `scripts/check-route-auth.mjs` is a
structural guard, wired into `.github/workflows/ci.yml`, with an allowlist where
**every entry carries a written justification**. That design is exactly what the
theming problem needs, and reusing it means no new concepts for the team.

`scripts/check-theme-tokens.mjs` would fail the build on:

- raw palette utilities (`bg-amber-50`, `text-red-600`, `border-gray-200`, …)
- arbitrary hex in class position (`bg-[#fafbfc]`)
- `text-white` / `text-black` on a `--brand` background
- `dark:` variants (see §3.2 — these should not exist here at all)

with an allowlist for the surfaces that are *legitimately* not themed, each
justified in the same style as the auth guard:

```js
const ALLOWLIST = {
  "features/cv/analysis/TailoredCvCard.tsx":
    "CV paper preview — deliberately renders on white stock at all times so the "
    + "on-screen preview matches the exported PDF byte-for-byte",
  "features/profiles/components/LiveLogConsole.tsx":
    "terminal emulator — GitHub-dark console palette is the point, not a theme surface",
  "features/auth/components/brand.tsx":
    "Google's brand SVG — the four-colour mark is trademark-fixed and must not be recoloured",
};
```

Crucially the guard ships in **report-only mode first** (prints the count,
exits 0) so the tree can be cleaned incrementally without a red CI for weeks. It
flips to enforcing at the end of the migration. That mirrors how the eslint gate
was introduced here on 2026-07-08 — backlog cleared first, then made a hard gate.

### Layer 3 — Contrast as a test, not an opinion

`globals.css:775–779` documents WCAG ratios for Aurora in a comment. Comments do
not fail. There is already a vitest setup (`vitest.config.ts`, 3 test files), so
this is cheap:

`themeContrast.test.ts` parses the token blocks out of `globals.css`, and for
every theme × every semantic pair asserts a minimum ratio:

- `--text` on `--surface` ≥ 4.5
- `--text-2` on `--surface` ≥ 4.5
- `--text-3` on `--surface` ≥ 3.0
- `--brand-fg` on `--brand` ≥ 4.5   ← *this one alone catches the `text-white` class of bug*
- `--success` on `--success-subtle` ≥ 4.5, and the same for warning/danger/info

After this exists, "does Gilded Noir work?" stops being something anyone has to
eyeball, and adding an eighth theme becomes safe.

---

## 3. Specific design decisions worth arguing

### 3.1 Auth: scope the tokens, don't fight them

The audit's finding 2.3 (auth inherits the theme class and renders white labels
on a white card) has an obvious cheap fix — strip the theme class on `/auth/*` —
and a better one.

The auth screens carry **~40 inline hex values** specifically to avoid the
theme. But they compose `Input`, which is token-driven, so the avoidance is
already leaking. Rather than making auth *more* hand-styled, give it its **own
token scope**:

```css
.auth-shell {
  --surface: #FFFFFF;  --surface-2: #F1F5F9;
  --text: #0F172A;     --text-2: #475569;  --text-3: #64748B;
  --border: #E2E8F0;   --brand: #3B82F6;   --brand-fg: #FFFFFF;
}
```

Now `Input`, `FieldLabel`, `.field` and `.gh-btn` all resolve *auth's* palette
regardless of what `<html>` says, the ~40 inline styles delete down to classes,
and the docblock in `brand.tsx` becomes true instead of aspirational. Auth
becomes theme-proof **by construction** rather than by a route check that a
future refactor can quietly break.

This also fixes the stray `rgba(11,125,116,…)` Aurora-teal backgrounds sitting
behind blue icons in three places — they become `bg-success-subtle`.

### 3.2 `dark:` variants: delete, don't rewire

Tailwind v4 can bind `dark:` to the theme classes:

```css
@custom-variant dark (&:where(.theme-aurora-dark, .theme-gilded-noir, .theme-aurora-dark *, .theme-gilded-noir *));
```

I recommend **not** doing this, and deleting all 20 usages instead. Reasons:

- With Layer 1, they are redundant — `bg-success-subtle` is already correct on
  dark themes, so a dark override is a second way to say the same thing.
- Two mechanisms for "this is the dark case" is precisely the ambiguity that
  produced the current bug. One vocabulary is the win.
- It bakes in an assumption that themes are binary. There are seven, and Notion
  and Clay are neither light-neutral nor dark.

### 3.3 Deliberately deferred: moving `.gh-btn` into `@layer components`

`.gh-btn` and `.field` live outside Tailwind's cascade layers, so unlayered
rules beat every utility. That is why `ResumePausedBanner`'s button colours are
silently dead, and the comments in `globals.css` and `Button.tsx` show this has
already cost real debugging time.

The clean fix is `@layer components { .gh-btn { … } }`, which would let
`className` overrides work as authors plainly expect.

**I am recommending against doing it in this pass.** It changes the cascade for
every button, input, badge and table in the app at once, and the failure mode is
silent visual drift rather than a build error — the worst possible shape for a
change that cannot be verified by types or tests. It deserves its own branch,
its own screenshot diff, and its own week. For now, `ResumePausedBanner` gets
fixed by *not* passing dead overrides.

Recorded here so the decision is deliberate rather than forgotten.

### 3.4 Landing testimonials

Not a code problem, so no code fix is proposed. The audit's §4.1 stands: the
JSON-LD comment already states these are illustrative and unverified, and the
visible page states they are real feedback from named people. Those cannot both
be true. This needs a product decision, and it is the only item in either
document with legal rather than aesthetic exposure.

---

## 4. Execution plan

Seven phases. Ordered so that visible wins land early, risky work lands late,
and every phase is independently shippable. Verification gate after each:
`npx tsc --noEmit && npx eslint . && npx vitest run && npm run build`.

| # | Phase | Nature | Risk |
|---|---|---|---|
| 0 | **Foundation** — semantic tokens, contrast test, guard in report-only mode | additive, zero visual change | very low |
| 1 | **Contrast & legibility** — `--brand-fg`, `#fafbfc` strips, `SourcePill`→`sourcePillTone()`, `ATS_BAND_META`→chart tokens | visible fix | low |
| 2 | **Behavioural bugs** — sidebar active state, stale location input, dead sidebar query, `ResumePausedBanner`, `error.tsx`, `100dvh` | logic | low |
| 3 | **Auth token scope** — `.auth-shell`, strip ~40 inline hex, kill stray teal | contained rewrite | medium |
| 4 | **Landing** — mobile nav, anchor offsets, pill naming, Terms/Pricing links, testimonials per decision | contained | low |
| 5 | **Palette migration** — the 559, folder by folder; `dark:` deleted | mechanical, broad | medium |
| 6 | **Remove the Aurora remap block; flip guard to enforcing** | deletion | low *after* 5 |
| 7 | **Accessibility** — fake buttons, tablist wiring, canvas labelling, sidebar resizer | semantics | low |

Phase 5 is the only one with real breadth (61 files). It is deliberately last
among the mechanical work because Layer 1 must exist first — otherwise the
migration has no target vocabulary and would invent one file-by-file, which is
how the current mess started.

### Notes on parallelism

Phases 0→1→2 are strictly sequential (1 and 2 both consume Layer 1's tokens).
Phase 5 parallelises cleanly by feature folder — `features/jobs`, `features/cv`,
`features/admin`, `app/(dashboard)/admin` share no files. Phases 3, 4 and 7
touch disjoint file sets and can run alongside 5.

---

## 5. What this buys

- ~125 lines of `!important` CSS deleted, not extended.
- Gilded Noir, Notion and Clay become genuinely supported rather than
  nominally supported.
- Contrast regressions become a failing test instead of a support ticket.
- New palette violations become a failing build instead of a slow accumulation.
- One colour vocabulary, so the ATS dot, the donut slice and the status badge
  stop drifting apart.
- An eighth theme becomes a data change, not a project.
