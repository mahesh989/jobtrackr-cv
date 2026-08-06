"use client";

/**
 * The dashboard's "what should I do next" cluster.
 *
 * These are the only items on the dashboard that name a NEXT ACTION rather
 * than describe history, so they sit on the action side of the summary row,
 * opposite the progress figures. Previously they rendered as small text in a
 * footer strip underneath the donut.
 *
 * Order runs newest-signal first, then by proximity to the product's actual
 * point — an application going out the door:
 *   1. new arrivals nobody has looked at yet
 *   2. letters written, nothing left to do but send   → primary, brand-filled
 *   3. passed the ATS gate but has no letter yet      → one step behind
 *   4. thin JD, analysis is blocked until text is pasted
 *
 * Renders nothing at all when there is nothing to do. An empty action bar is
 * worse than no action bar.
 *
 * Every entry uses the same shallow client-side filter as the donut's slices
 * (useApplyFilter), so acting on one re-filters the board in place and scrolls
 * to it rather than triggering a full server navigation. "New to review"
 * previously did a router.push that reloaded the route; it is now consistent
 * with the rest — `status` is one of the view keys applyFilter clears.
 */

import Link from "next/link";
import { FilterAnchor } from "./FilterAnchor";
import { useApplyFilter } from "./useApplyFilter";
import { LETTER_READY_HREF } from "@/features/jobs/lib/boardViews";
import type { PipelineLensData } from "./PipelineDonut";

const BASE =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md font-medium " +
  "transition-colors focus:outline-none focus-visible:ring-2";

export function NextActions({ callouts, totalNew }: {
  callouts: PipelineLensData["callouts"];
  totalNew: number;
}) {
  const applyFilter = useApplyFilter();

  const nothingToDo =
    totalNew === 0 &&
    callouts.thinJdCount === 0 &&
    callouts.passedButNoLetter === 0 &&
    callouts.readyToApply === 0;
  if (nothingToDo) return null;

  return (
    <div className="flex flex-nowrap sm:flex-wrap items-center gap-2 overflow-x-auto sm:overflow-visible whitespace-nowrap sm:whitespace-normal sm:justify-end anim-in">
      {totalNew > 0 && (
        <FilterAnchor
          href="/dashboard?status=new"
          apply={applyFilter}
          className={`${BASE} px-3 py-2 text-label bg-[var(--brand)]/10 border border-[var(--brand)]/30 text-[var(--brand)] hover:bg-[var(--brand)]/15 focus-visible:ring-[var(--brand)]/40`}
        >
          {totalNew} new to review
        </FilterAnchor>
      )}
      {/* "Ready to apply" here means pipelineState's ready_to_apply/ready_to_send
          combined — has a cover letter, hasn't been sent — NOT the toolbar's
          "Ready to apply" saved view (ATS above the final gate + full JD, no
          letter needed). Those are different sets; see LETTER_READY_HREF. */}
      {callouts.readyToApply > 0 && (
        <Link
          href={LETTER_READY_HREF}
          className={`${BASE} px-3.5 py-2 text-label bg-[var(--brand)] text-[var(--brand-fg)] hover:brightness-95 focus-visible:ring-[var(--brand)]/40`}
        >
          ✓ {callouts.readyToApply} cover letter{callouts.readyToApply > 1 ? "s" : ""} ready to send
        </Link>
      )}
      {callouts.passedButNoLetter > 0 && (
        <FilterAnchor
          href="/dashboard?triage=passedNoLetter"
          apply={applyFilter}
          className={`${BASE} px-3 py-2 text-label bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 focus-visible:ring-blue-300`}
        >
          → {callouts.passedButNoLetter} passed ATS, no letter yet
        </FilterAnchor>
      )}
      {callouts.thinJdCount > 0 && (
        <FilterAnchor
          href="/dashboard?triage=thinJd"
          apply={applyFilter}
          className={`${BASE} px-3 py-2 text-label bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 focus-visible:ring-amber-300`}
        >
          ⚠ {callouts.thinJdCount} thin JD{callouts.thinJdCount > 1 ? "s" : ""} need attention
        </FilterAnchor>
      )}
    </div>
  );
}
