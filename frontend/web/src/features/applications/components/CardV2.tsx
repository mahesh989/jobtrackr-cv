"use client";

/**
 * CardV2 — the redesigned card used by the new 2-tab Applications
 * screen. Two variants behind one component:
 *
 *   Pool variant  (tab="pool") — expandable big card. Click to open, then use
 *     section tabs (Tailored CV / Cover letter / Email message) to review
 *     everything in one place. Cover letter and email message are inline-
 *     editable with explicit Save buttons. Action bar exposes the document
 *     buttons (Cover letter PDF, Tailored CV PDF, Download ZIP) and the
 *     channel-adaptive send/apply action.
 *
 *   Sent variant  (tab="sent") — minimal done card. Surfaces a popup with the
 *     email message + Copy button so the user can revisit later.
 */


import { PoolCard } from "./PoolCard";
import { SentCard } from "./SentCard";

export interface ApplicationRowV2 {
  letter_id:                 string | null;
  letter_completed_at:       string | null;
  job_id:                    string;
  job_title:                 string;
  job_company:               string;
  job_location:              string;
  job_url:                   string;
  job_applied_at:            string | null;
  job_dismissed_at:          string | null;
  job_contact_email:         string | null;
  job_hiring_manager:        string | null;
  job_posted_at:             string | null;
  job_distance_km:           number | null;
  analyzed_at:               string | null;
  profile_id:                string;
  profile_name:              string;
  latest_run_id:             string | null;
  tailored_match_score:      number | null;
  tailored_pdf_storage_path: string | null;
  tailored_cv_storage_path:  string | null;
}

import type { ApplicationStatusKey } from "./StatusTabs";
export type CardTabV2 = ApplicationStatusKey;


export function scoreColor(n: number | null) {
  if (n == null) return "text-text-3";
  if (n >= 75) return "text-emerald-600";
  if (n >= 55) return "text-amber-600";
  return "text-red-600";
}

export function CardV2({
  row, tab, onActioned }: {
  row: ApplicationRowV2;
  tab: CardTabV2;
  onActioned?: () => void;
}) {
  return tab === "pool"
    ? <PoolCard row={row} onActioned={onActioned} />
    : <SentCard row={row} onActioned={onActioned} />;
}
