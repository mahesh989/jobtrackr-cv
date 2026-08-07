# How we refactor

House rules for changing the shape of code in this repo. Written from what
actually went right and wrong here — every rule below has a real incident
behind it, cited so you can go read the case.

The goal is code a new developer can navigate without a tour guide. Optimise
for **reading**, not for writing.

---

## 1. Before you touch anything

**Refactor for a reason you can name in one sentence.**

Good reasons:
- "This file is too big to hold in your head." (`orchestrator.ts` was 1,667 lines)
- "I need to change X and can't tell what else breaks."
- "This logic is duplicated in 5 places and they've already drifted."

Not reasons:
- "It would be cleaner." Cleaner by whose measure, and who benefits?
- "It's not the pattern I'd have used."
- "It's old."

If you can't name the reason, you're rearranging furniture. Stop.

**The anti-over-engineering test:** does this change reduce the number of
things a developer must understand to make the *next* change? If it adds a
layer, an abstraction, or a config option that nothing needs *today*, delete
it. Speculative flexibility is a cost paid now for a benefit that usually
never arrives.

---

## 2. Refactor and fix are separate commits. Always.

A refactor is **pure code motion**: same behaviour, same output, same logs.
The moment you also fix a bug, you can no longer prove the move was safe —
any diff in behaviour could be either.

Real case: `earlyDedup` computes `sha256(canonicalUrl(url))` while
`dedup.ts` computes the same hash **lowercased**. They disagree, and
cross-profile dedup silently misses uppercase-path URLs. It is a known,
tracked bug — and it was deliberately carried across *unchanged* during the
orchestrator split ([backend/worker/src/pipeline/orchestrator/earlyDedup.ts](../backend/worker/src/pipeline/orchestrator/earlyDedup.ts)),
comment intact. "Fixing" it mid-move would have started dropping jobs from
users' boards under cover of a refactor nobody would think to audit.

Move it first. Fix it second. Two commits, two reviews.

---

## 3. Prove it with tests *before* you move

Order of operations, non-negotiable for anything with real logic:

1. **Write characterization tests** against the current behaviour.
2. **Break the source on purpose** and confirm the tests fail. A test suite
   that has never failed is not evidence of anything.
3. **Do the move.**
4. **Re-run.** Green.
5. **Mutate again** against the *new* structure — drop a counter, flip an
   `&&` to `||`, reorder two calls. Confirm each is caught. Revert.

Step 5 is the one people skip, and it's the one that matters: a pre-existing
suite passing is not proof it would catch *this* change. In the orchestrator
split, three injected mutations were each caught — including a reordering
that only the call-order trace detected, because the other four assertion
windows compared end state and a moved operation left that identical.

**Also diff the literal strings.** Grep every `console.log` / error message /
contract value out of the old file and the new files and diff them as sets.
This caught real bugs in three of the five Python package splits.

---

## 4. Map dependencies before choosing the shape

Don't guess the file layout. For each function, list what it references.
Build the ownership map. Check the group graph for cycles *before* writing
any new file.

When you hit a cycle, that's information — something belongs somewhere else.
Don't force it with a lazy import. `pdf_generator.py` resolved its cycle with
an explicit setter; `tailored_structural_validation.py` resolved its by
moving two shared helpers into their own leaf module. Both are honest
answers. A circular import papered over with a deferred `require` is not.

---

## 5. Naming: the folder is the namespace

**A file's name should not repeat its folder, and should say what's inside.**

```
✅ pipeline/orchestrator/enrichment.ts     → enrichDescriptions
✅ pipeline/orchestrator/sourceFetch.ts    → fetchFromSources
✅ features/jobs/components/FeedCards/chips.tsx

❌ pipeline/orchestrator/orchestratorEnrichment.ts   (folder already said it)
❌ features/jobs/components/FeedCards/FeedCardsBits.tsx
❌ utils.ts / helpers.ts / misc.ts / common.ts       (says nothing)
```

`utils.ts` is where code goes to die. If you can't name the module after what
it does, you haven't decided what it does.

**Watch for collisions across levels.** `pipeline/dedup.ts` already existed,
so the orchestrator's own dedup stage became `earlyDedup.ts`, not a second
`dedup.ts`. Two same-named files in one import graph is a permanent tax on
every reader.

**One public name per package where possible.** The orchestrator package
exports exactly `runPipeline` from its `index.ts`; the other twelve modules
are internal. Small public surface = free rein to reshape the inside later.

---

## 6. Size is a smell, not a rule

There's no line limit. But:

- **Over ~500 lines**, ask what the seams are. Often there's one obvious cut.
- **Over ~1,000 lines**, it's costing everyone who reads it.
- **A 200-line file with five unrelated concerns** is worse than an 800-line
  file with one.

Split along **concerns**, not line counts. `ReviewClient` split into state
(`ReviewClient.tsx`), rendering (`ReviewSections.tsx`), document updates
(`cvDocPatchers.ts`), and persistence (`useReviewAutosave.ts`) — four
different reasons to change. That's a good cut. Slicing the same component
into `ReviewClientPart1/2/3` would not be.

---

## 7. Don't delete what you haven't proven is dead

Dead-code sweeps are valuable and have repeatedly gone wrong here.

- `proxy.ts` was once removed as "dead code" — nothing imports it, the
  *framework* invokes it by file convention. Every logged-in session started
  dying after ~1 hour. It now carries a `DO NOT DELETE` header
  ([frontend/web/src/proxy.ts](../frontend/web/src/proxy.ts)).
- An external audit flagged `checkDuplicateWorkers.ts` as having "no CI
  reference". It is wired into `deploy.yml` and is the guard against a real
  Upstash billing incident.

Before deleting, verify against **all** of: source imports, CI workflows,
framework file conventions, env-var references, and docs. "I grepped for the
symbol" is not sufficient. When in doubt, leave it and open a task.

---

## 8. Comments earn their place by explaining *why*

Delete comments that restate the code. Keep — and *move verbatim* during
refactors — comments that encode:

- **Cross-service contracts.** `SourceMethods` carries a warning that the
  admin Sourcing page reads its keys out of untyped JSONB; rename one and a
  production dashboard silently goes to zero, with no type or runtime error.
- **Non-obvious ordering.** `fetchFromSources` documents that its three
  `checkCancellation()` calls are load-bearing — they're the only cancel
  points in the pipeline.
- **Deliberate weirdness.** The mutation-in-place metrics accumulator exists
  so a mid-stage throw still reports which sources succeeded.
- **Incident history.** The 30s grace window in `RunNotifier` exists because
  the enqueue endpoint returns before the worker flips the row.

A refactor that drops these comments has destroyed information that isn't
recoverable from the code.

---

## 9. Keep the public surface still

Prefer moves that need **zero changes at call sites**. When a consumer must
change, that's a real cost — count it and say so in the PR.

Language gotcha worth knowing: Node's `NodeNext` resolution has **no**
CommonJS-style directory-index fallback. Turning `orchestrator.ts` into
`orchestrator/` did *not* resolve automatically; both importers had to move
to `orchestrator/index.js` explicitly. Verify your assumption before
promising a zero-touch move.

---

## 10. Commit hygiene

- **Stage only files you changed this session.** Never sweep in someone
  else's pending work — this repo is often open in more than one session at
  once, sharing one working tree.
- **One logical change per commit.** A package split and a bug fix are two
  commits even if you did them in one sitting.
- **Say what you verified in the commit message**, and say what you *didn't*.
  "tsc clean, 181 tests pass, not verified in a browser" is an honest
  message. Silence implies more confidence than you earned.

---

## Checklist

Before opening a refactor PR:

- [ ] I can state the reason in one sentence
- [ ] No behaviour change is bundled with the move
- [ ] Characterization tests existed first, and I proved they can fail
- [ ] I re-mutated against the new structure, and it caught the injections
- [ ] Literal strings (logs, contract values) diff clean
- [ ] Dependency graph has no cycles
- [ ] Filenames say what's inside; none collide; no `utils.ts`
- [ ] Load-bearing comments moved verbatim
- [ ] Call-site changes counted and named in the PR
- [ ] Only my files staged
