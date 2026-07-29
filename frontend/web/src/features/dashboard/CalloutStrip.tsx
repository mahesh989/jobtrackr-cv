"use client";

import Link from "next/link";
import { FilterAnchor } from "./FilterAnchor";
import { LETTER_READY_HREF } from "@/features/jobs/lib/boardViews";
import type { PipelineLensData } from "./PipelineDonut";

export function CalloutStrip({ callouts, applyFilter }: {
  callouts: PipelineLensData["callouts"];
  applyFilter: (href: string) => void;
}) {
  if (callouts.thinJdCount === 0 && callouts.passedButNoLetter === 0 && callouts.readyToApply === 0) return null;

  return (
    <div className="flex flex-nowrap sm:flex-wrap items-center gap-2 px-5 py-3 border-t border-border overflow-x-auto sm:overflow-visible whitespace-nowrap sm:whitespace-normal">
      {callouts.thinJdCount > 0 && (
        <FilterAnchor href="/dashboard?triage=thinJd" apply={applyFilter} className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-md text-caption font-medium bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 transition-colors">
          ⚠ {callouts.thinJdCount} thin JD{callouts.thinJdCount > 1 ? "s" : ""} need attention
        </FilterAnchor>
      )}
      {callouts.passedButNoLetter > 0 && (
        <FilterAnchor href="/dashboard?triage=passedNoLetter" apply={applyFilter} className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-md text-caption font-medium bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition-colors">
          → {callouts.passedButNoLetter} passed ATS, no letter yet
        </FilterAnchor>
      )}
      {/* "Ready to apply" here means pipelineState's ready_to_apply/ready_to_send
          combined — has a cover letter, hasn't been sent — NOT the toolbar's
          "Ready to apply" saved view (ATS above the final gate + full JD, no
          letter needed). Those are different sets; see LETTER_READY_HREF. */}
      {callouts.readyToApply > 0 && (
        <Link href={LETTER_READY_HREF} className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-md text-caption font-medium bg-pink-50 border border-pink-200 text-pink-700 hover:bg-pink-100 transition-colors">
          ✓ {callouts.readyToApply} cover letter{callouts.readyToApply > 1 ? "s" : ""} ready to send or apply
        </Link>
      )}
    </div>
  );
}
