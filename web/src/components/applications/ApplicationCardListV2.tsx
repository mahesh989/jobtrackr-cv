"use client";

/**
 * ApplicationCardListV2 — client wrapper around the V2 cards. Manages local
 * row removal so the empty state renders instantly when the last card actions
 * out (instead of waiting for the server round-trip).
 */

import { useState } from "react";
import { ApplicationCardV2, type ApplicationRowV2, type CardTabV2 } from "./ApplicationCardV2";

export function ApplicationCardListV2({
  rows, tab, empty,
}: {
  rows:  ApplicationRowV2[];
  tab:   CardTabV2;
  empty: React.ReactNode;
}) {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const visible = rows.filter((r) => !hiddenIds.has(r.letter_id));

  if (visible.length === 0) return <>{empty}</>;

  return (
    <div className="space-y-3">
      {visible.map((row) => (
        <ApplicationCardV2
          key={row.letter_id}
          row={row}
          tab={tab}
          onActioned={() => {
            setHiddenIds((prev) => {
              const next = new Set(prev);
              next.add(row.letter_id);
              return next;
            });
          }}
        />
      ))}
    </div>
  );
}
