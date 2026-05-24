"use client";

import { useState, type ReactNode } from "react";
import { ApplicationCard, type ApplicationRow, type CardTab } from "./ApplicationCard";

/**
 * Client wrapper for the plain (apply / sent / archived) tabs. Owns the row
 * list so that when a card actions itself out, we drop it from local state and
 * render the empty state immediately — instead of waiting for the card's
 * router.refresh() server round-trip to re-render the server component.
 */
export function ApplicationCardList({
  rows,
  tab,
  empty,
}: {
  rows:  ApplicationRow[];
  tab:   CardTab;
  empty: ReactNode;
}) {
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const visible = rows.filter((r) => !removed.has(r.letter_id));

  if (visible.length === 0) return <>{empty}</>;

  return (
    <div className="space-y-3">
      {visible.map((row) => (
        <ApplicationCard
          key={row.letter_id}
          row={row}
          tab={tab}
          onActioned={() =>
            setRemoved((prev) => new Set(prev).add(row.letter_id))
          }
        />
      ))}
    </div>
  );
}
