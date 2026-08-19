# Job-Card Design Brief — user dashboard

For any AI agent iterating on the JobTrackr-CV dashboard UI.

> **The prototype file this brief referred to is gone.** `user-dashboard-demo.html`
> (repo root) was deleted on 2026-08-19: its mock CV pane contained a real user's
> name, mobile number and email, and this repo is public. The design it validated
> already shipped into `frontend/web` (commit `6de05f90`), so the live dashboard —
> not a prototype file — is now the reference. The principles below still stand on
> their own; only the "open the playground and tweak tokens" workflow is no longer
> available. Design tokens live in `frontend/web/src/app/globals.css`.

## The goal

Job cards that feel **lively, modern, and premium — without being loud**. Calm on the
surface, energetic through scale, spacing, and a single well-placed accent per card.

## What I value (in priority order)

1. **Calm before bold.** Cards are mostly neutral (white surface, `--border`). Color
   appears sparingly and only where it carries meaning: score band, state chip, primary
   action button. Never tint whole cards with gradient washes by default.
2. **Theme-consistent.** Use the app's tokens only: `--success/--warning/--danger/--info`
   with their `-subtle` / `color-mix(... 35%)` border pairs, `--chart-*`, `--brand`,
   `--border`, `--text-*`. No ad-hoc hexes. Style chips/buttons/badges exactly like the
   rest of the app does.
3. **Zero redundancy.** Every fact appears exactly once per surface. Score lives in the
   gauge (with the faint "from N" arc); footer chips show state label only; never repeat
   score text next to the gauge; never stack two "Applied" indicators; never repeat ATS
   numbers in the pane header that already live in Match & score / Tailored CV tabs.
4. **Lively = scale + whitespace + motion, not color.** Bigger type, generous padding,
   distinct card sizes, hover elevation with a small translate. That's the "vibrant" the
   user keeps asking for.
5. **Scannable hierarchy.** monogram → title → one-line meta → salary → footer
   (source pill · state chip · action). A card should feel informative, not sparse — more
   useful content per card is welcome (e.g. top matched/missing skills, type + salary
   chips, freshness, distance).
6. **One style per surface.** A single refined card treatment everywhere: dashboard
   sections, Favourite, Applied, filtered and sorted views. Variants exist only so the
   user can choose — the winner gets rolled out to all surfaces and the full-analysis pane.

## Direction I'm leaning (iterate, don't settle)

- Medium-large cards: titles ~17-20px, padding ~16-20px, radius 12-14px, gauge 80-96px.
- Strong but single accent per card: colored gauge + colored state chip, everything else
  neutral.
- Clean section headers (no divider underline), generous gaps (section 28-36px, cards 10-14px).
- Keep the dashboard column centered (~922px) and don't touch the sliding detail pane's layout.

## Rejections history — do not regress

- Colored gradient washes / tinted backgrounds for every card state → "too much color".
- Duplicated info: chip text repeating the gauge score, "✓ Applied" next to "Applied",
  "ATS 48 → 66" text beside the gauge, score tile in pane header duplicating Match & score.
- All cards looking "more or less the same" — no energy between sections/cards.
- The section-header underline divider.

## Process

- Prototype directly in `frontend/web` (the standalone demo file is gone — see the
  note at the top); tokens live at `:root` in `frontend/web/src/app/globals.css`.
- When exploring directions, ship 3-5 **distinct archetypes** side by side (different
  padding/type/layout), so the user picks — don't micro-tweak one design.
- After a pick: apply it everywhere, unify, remove dead variant code.
- Verify JS syntax: `node -e` on the extracted `<script>` body after every change.
