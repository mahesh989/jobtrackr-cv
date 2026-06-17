# Rule Coherence Audit

Audit a set of rules for ambiguity, contradiction, gaps, and
under-specification that could cause inconsistent or incorrect behavior
when the rules are followed.

The "rules" can be anything: a prompt, a spec, a config schema, function
contracts, a state machine, a validator, a policy document, an API
contract, a style guide, a protocol — whatever defines required behavior.

## Scope — what to audit

Primary rules:
  [path or location]   — [optional: lines, function, block name]

Anything that interacts with the primary rules (cross-check for mismatches):
  [path or location]   — [its role: enforces / consumes / produces /
                          transforms / references]
  [path or location]   — [role]
  ...

## Context (optional but helps focus)

[1-3 sentences: what changed recently, the problem being solved, known
 gotchas, or what kind of failure you are trying to prevent]

## What counts as a finding — flag anything matching these patterns

**(1) NUMERIC / THRESHOLD COHERENCE**
- All numeric values (counts, sizes, limits, rates, timeouts,
  percentages, version bounds, indexes) agree across every place the
  same concept is referenced.
- Combined constraints from two rules imply a tighter bound than
  either states alone, and that tighter bound is stated explicitly.
- Min/max pairs are non-empty (min <= max); boundary behavior
  (inclusive vs exclusive, round-up vs round-down) is defined.

**(2) TERMINOLOGY DRIFT**
- The same concept is named the same thing in every place it appears
  (rule body, error message, log line, identifier, comment, example).
- No silent synonyms or aliases the reader/system must mentally map.
- Abbreviations / acronyms are introduced before use.

**(3) LOGICAL CONTRADICTION**
- No two rules can fire simultaneously and demand opposite outcomes.
- "Always X" rules have explicit exceptions, or none — never buried.
- "If A then B": A is unambiguous, B is reachable, the negation case
  ("if not A") is either covered or explicitly out of scope.
- "Forbidden" lists do not contradict "required" lists.

**(4) FALLBACK / PRIORITY ORDERING**
- When two rules could both apply, priority order is stated.
- Every required input has exactly one defined fallback when missing —
  not zero (silent failure), not two (undefined choice).
- Default values are stated explicitly, not implied.

**(5) EXECUTION / EVALUATION ORDER**
- Every step receives input in the shape its predecessors produce.
- Renames, normalisations, transforms happen in an order that
  preserves the assumptions of every downstream step.
- "HARD" / "MUST" / "REQUIRED" upstream is not silently downgraded
  to "warn" / "should" / "optional" downstream.
- Idempotence: running a step twice does not change the result, or
  the non-idempotence is intentional and documented.

**(6) BOUNDARY / EDGE COVERAGE**
- Every conditional has at least one example showing the correct
  outcome AND one showing the wrong outcome it is meant to prevent.
- Exact threshold values (boundary, off-by-one, empty input, single
  element, max size) are covered or explicitly excluded.
- Special values (null, empty, zero, negative, unicode, very large,
  duplicates) are handled or stated out of scope.

**(7) EXTERNAL CONTRACTS**
- Names, fields, endpoints, env vars, identifiers referenced in
  the rules actually exist where they claim to.
- Rules that depend on a specific version of an external contract
  say so.

**(8) INTERNAL SELF-CONSISTENCY**
- The summary / preamble / header matches the detailed body.
- Examples produce the result the rules describe.
- Self-check / verification / test steps enumerate the same
  constraints stated in the body — no missing checks, no extra
  checks that were never specified.

## Output format — for each finding

```
Finding N | <location> | Severity: HIGH / MED / LOW
Problem:  [one sentence — what is ambiguous, contradicted, or missing]
Evidence: [one quoted phrase or value showing the issue]
Fix:      [one sentence — the minimal change that resolves it]
```

## Ground rules

- Report only real findings. Do not flag style preferences or
  "nice-to-have" additions.
- If a checklist category has NO findings, state so in one line
  ("(2) TERMINOLOGY: no findings.") — a clean category is itself a result.
- Severity: HIGH = will produce wrong behavior on plausible inputs.
  MED = inconsistent / risks divergence over time. LOW = cosmetic.
- Read the full scope before reporting — a finding that looks like a bug
  in isolation may be resolved in another file you have not yet read.
- Be terse. Full report fits in under 600 words.
